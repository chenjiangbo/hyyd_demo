import { Prisma, type PrismaClient } from '@prisma/client'
import type * as Minio from 'minio'
import { matchNativeRegistrationProofToOrders } from './registrationProofService.js'
import { understandImage } from './imageUnderstanding.js'
import { getNativeChatImageAnalysisStartAt, getOrderAiAutomationConfig, isImageAiEnabled, nativeChatStoredBeijingTimeIsEligible } from './orderAiAutomationConfig.js'
import { convertNativeChatWxgfToJpeg } from './nativeChatWxgfPreview.js'
import { triggerOrderAiAnalysis } from '../jobs/orderAiSchedule.js'

const BUCKET = 'materials'
const WORKER_INTERVAL_MS = 15_000
const PROMPT_VERSION = 'image-understanding-v1'
export const MAX_IMAGE_ANALYSIS_ATTEMPTS = 2
const MAX_ATTEMPTS = MAX_IMAGE_ANALYSIS_ATTEMPTS
const MAX_CONCURRENT_ANALYSIS = 2
const activeAttachments = new Set<number>()
let concurrentAnalysisCount = 0
let workerTimer: ReturnType<typeof setInterval> | null = null
let workerTicking = false

export type NativeImageType = string

export type NativeChatImageAnalysis = {
  status: 'completed'
  imageType: NativeImageType
  typeDescription: string
  description: string
  visibleText: string
  visibleFields: Array<{ label: string; value: string }>
  model: string
  promptVersion: string
  attemptCount: number
  completedAt: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function parseAnalysis(parsed: Awaited<ReturnType<typeof understandImage>>, attemptCount: number): NativeChatImageAnalysis {
  return {
    status: 'completed',
    imageType: parsed.imageType,
    typeDescription: parsed.typeDescription,
    description: parsed.description,
    visibleText: parsed.visibleText,
    visibleFields: parsed.visibleFields,
    model: parsed.model,
    promptVersion: PROMPT_VERSION,
    attemptCount,
    completedAt: new Date().toISOString()
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk))
    } else if (chunk instanceof Uint8Array) {
      chunks.push(chunk)
    } else {
      throw new Error('图片存储流返回了无法读取的数据块')
    }
  }
  return Buffer.concat(chunks)
}

export function imageDataUrl(mimeType: string | null, buffer: Buffer): string {
  let actual: string | undefined
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) actual = 'image/png'
  else if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) actual = 'image/jpeg'
  else if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') actual = 'image/gif'
  else if (buffer.subarray(0, 2).toString('ascii') === 'BM') actual = 'image/bmp'
  else if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') actual = 'image/webp'
  if (!actual) throw new Error(`无法识别图片文件格式（记录的 MIME 类型：${mimeType || '未提供'}）`)
  return `data:${actual};base64,${buffer.toString('base64')}`
}

async function writeImageAnalysis(prisma: PrismaClient, id: number, value: Record<string, unknown>, bumpUpdatedAt: boolean): Promise<void> {
  await prisma.$executeRaw`
    UPDATE native_chat_attachments
       SET source_metadata = jsonb_set(COALESCE(source_metadata, '{}'::jsonb), '{imageAnalysis}', ${JSON.stringify(value)}::jsonb, true),
           updated_at = CASE WHEN ${bumpUpdatedAt} THEN NOW() ELSE updated_at END
     WHERE id = ${id}
  `
}

async function getAttachment(prisma: PrismaClient, id: number) {
  const rows = await prisma.$queryRaw<Array<{
    id: number
    message_id: number
    conversation_id: number
    kind: string
    mime_type: string | null
    storage_key: string | null
    state: string
    source_metadata: unknown
    application_no: string | null
    order_id: number | null
    application_link_status: string
    application_link_source: string | null
    message_application_no: string | null
    message_order_id: number | null
    message_application_link_status: string
    employee_id: number
    received_at: Date | null
  }>>`
    SELECT a.id, a.message_id, m.conversation_id, a.kind, a.mime_type, a.storage_key, a.state, a.source_metadata,
           a.application_no, a.order_id, a.application_link_status, a.application_link_source,
           m.application_no AS message_application_no, m.order_id AS message_order_id,
           m.application_link_status AS message_application_link_status, c.employee_id, root.occurred_at AS received_at
      FROM native_chat_attachments a
      JOIN native_chat_messages m ON m.id = a.message_id
      JOIN native_chat_conversations c ON c.id = m.conversation_id
      LEFT JOIN LATERAL (
        WITH RECURSIVE ancestors AS (
          SELECT m.conversation_id, m.source_message_id, m.parent_source_message_id, m.occurred_at, ARRAY[m.id] AS visited
          UNION ALL
          SELECT p.conversation_id, p.source_message_id, p.parent_source_message_id, p.occurred_at, ancestors.visited || p.id
            FROM ancestors
            JOIN native_chat_messages p ON p.conversation_id = ancestors.conversation_id
              AND p.source_message_id = ancestors.parent_source_message_id
           WHERE NOT p.id = ANY(ancestors.visited)
        )
        SELECT occurred_at FROM ancestors WHERE parent_source_message_id IS NULL
      ) root ON TRUE
     WHERE a.id = ${id}
  `
  return rows[0] ?? null
}

async function processAttachment(prisma: PrismaClient, minio: Minio.Client, id: number): Promise<void> {
  if (activeAttachments.has(id)) return
  if (concurrentAnalysisCount >= MAX_CONCURRENT_ANALYSIS) return
  activeAttachments.add(id)
  concurrentAnalysisCount++
  try {
    if (!await isImageAiEnabled(prisma)) return
    const attachment = await getAttachment(prisma, id)
    if (!attachment || attachment.kind !== 'image' || attachment.state !== 'available' || !attachment.storage_key) return
    if (!attachment.received_at) throw new Error(`图片附件 ${id} 的合并消息未找到，无法判断发送时间`)
    const startAt = await getNativeChatImageAnalysisStartAt(prisma)
    if (!nativeChatStoredBeijingTimeIsEligible(attachment.received_at, startAt)) return
    const metadata = asRecord(attachment.source_metadata) ?? {}
    if (metadata.rendition !== 'non_thumbnail') return
    let analysis = asRecord(metadata.imageAnalysis)
    let dataUrl: string | null = null
    if (analysis?.status !== 'completed') {
      if (analysis?.status === 'failed') return
      const attemptCount = typeof analysis?.attemptCount === 'number' ? analysis.attemptCount : 0
      if (attemptCount >= MAX_ATTEMPTS) return
      const attempt = attemptCount + 1
      if (!await isImageAiEnabled(prisma)) return
      const imageAttempts = Array.isArray(analysis?.imageAttempts) ? [...analysis.imageAttempts] : []
      let currentImage: Record<string, unknown> = { ...analysis, imageAttempts, status: 'processing', attemptCount: attempt, promptVersion: PROMPT_VERSION, startedAt: new Date().toISOString() }
      await writeImageAnalysis(prisma, id, currentImage, false)
      try {
        const stream = await minio.getObject(BUCKET, attachment.storage_key)
        const buffer = await streamToBuffer(stream)
        dataUrl = buffer.subarray(0, 4).toString('ascii') === 'wxgf'
          ? imageDataUrl('image/jpeg', await convertNativeChatWxgfToJpeg(buffer))
          : imageDataUrl(attachment.mime_type, buffer)
        const { imageAnalysisModel } = await getOrderAiAutomationConfig(prisma)
        const parsed = parseAnalysis(await understandImage(dataUrl, imageAnalysisModel, async (response) => {
          imageAttempts.push({ attempt, response: response.content, model: response.model })
          currentImage = { ...currentImage, imageAttempts }
          await writeImageAnalysis(prisma, id, currentImage, false)
        }), attempt)
        const latest = await getAttachment(prisma, id)
        const latestMetadata = asRecord(latest?.source_metadata) ?? {}
        if (!latest || latest.storage_key !== attachment.storage_key
          || latestMetadata.content_hash !== metadata.content_hash) {
          console.info(`[native-chat:image] 附件 ${id} 在识别期间被更新，丢弃旧图片的识别结果`)
          return
        }
        analysis = { ...parsed, imageAttempts }
        await writeImageAnalysis(prisma, id, analysis, true)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await writeImageAnalysis(prisma, id, {
          ...currentImage, status: attempt < MAX_ATTEMPTS ? 'retrying' : 'failed',
          attemptCount: attempt,
          promptVersion: PROMPT_VERSION,
          error: message,
          lastAttemptAt: new Date().toISOString()
        }, attempt >= MAX_ATTEMPTS)
        throw error
      }
    }

    if (analysis?.imageType !== '挂号凭证') return
    if (!await isImageAiEnabled(prisma)) return
    const priorMatch = asRecord(analysis.registrationMatch)
    if (priorMatch?.status === 'completed' || priorMatch?.status === 'failed') return
    const matchAttemptCount = typeof priorMatch?.attemptCount === 'number' ? priorMatch.attemptCount : 0
    if (matchAttemptCount >= MAX_ATTEMPTS) return
    const matchAttempt = matchAttemptCount + 1
    const matchAttempts = Array.isArray(priorMatch?.attempts) ? [...priorMatch.attempts] : []
    let matchTrace: Record<string, unknown> | null = null
    const currentAnalysis = { ...analysis, registrationMatch: {
      ...priorMatch, attempts: matchAttempts, status: 'processing', attemptCount: matchAttempt, startedAt: new Date().toISOString()
    } }
    await writeImageAnalysis(prisma, id, currentAnalysis, false)
    try {
      if (!dataUrl) {
        const stream = await minio.getObject(BUCKET, attachment.storage_key)
        const buffer = await streamToBuffer(stream)
        dataUrl = buffer.subarray(0, 4).toString('ascii') === 'wxgf'
          ? imageDataUrl('image/jpeg', await convertNativeChatWxgfToJpeg(buffer))
          : imageDataUrl(attachment.mime_type, buffer)
      }
      const matching = await matchNativeRegistrationProofToOrders(prisma, dataUrl, analysis as unknown as NativeChatImageAnalysis, {
        applicationNo: attachment.application_link_status === 'matched'
          ? attachment.application_no
          : attachment.message_application_link_status === 'matched' ? attachment.message_application_no : null,
        onAiTrace: async (trace) => {
          if (matchTrace) matchAttempts.pop()
          matchTrace = { attempt: matchAttempt, ...trace }
          matchAttempts.push(matchTrace)
          await writeImageAnalysis(prisma, id, { ...analysis, registrationMatch: { ...currentAnalysis.registrationMatch, attempts: matchAttempts } }, false)
        }
      })
      if (matching.candidateApplicationCount === 0) {
        console.warn(`[native-chat:image] 挂号凭证 ${id} 未找到申领号和订单候选：${matching.reason}`)
      }
      const latest = await getAttachment(prisma, id)
      const latestMetadata = asRecord(latest?.source_metadata) ?? {}
      if (!latest || latest.storage_key !== attachment.storage_key || latestMetadata.content_hash !== metadata.content_hash) {
        console.info(`[native-chat:image] 附件 ${id} 在订单匹配期间被更新，丢弃旧图片的匹配结果`)
        return
      }
      const matchedApplicationNo = matching.applicationDecision === 'matched' && matching.applicationNo
        ? matching.applicationNo
        : null
      const matchedOrderId = matching.orderDecision === 'matched' && typeof matching.orderId === 'number'
        ? matching.orderId
        : null
      const linkStatus = matchedApplicationNo ? 'matched'
        : matching.applicationDecision === 'ambiguous' ? 'ambiguous' : 'unmatched'
      const applicationConflict = Prisma.sql`(
        application_link_status = 'matched' AND application_no IS NOT NULL AND (
          (${matchedApplicationNo}::text IS NOT NULL AND application_no <> ${matchedApplicationNo})
          OR (${matchedApplicationNo}::text = application_no AND ${matchedOrderId}::integer IS NOT NULL
              AND order_id IS NOT NULL AND order_id <> ${matchedOrderId})
        )
      )`
      const linkChanged = await prisma.$executeRaw`
        UPDATE native_chat_attachments
           SET application_no = CASE
                 WHEN application_link_status = 'conflict' THEN NULL
                 WHEN ${applicationConflict} THEN NULL
                 WHEN application_link_source = 'manager_confirmation' THEN application_no
                 WHEN application_link_status = 'matched' AND application_no IS NOT NULL
                   AND ${matchedApplicationNo}::text IS NULL THEN application_no
                 ELSE ${matchedApplicationNo} END,
               order_id = CASE
                 WHEN application_link_status = 'conflict' THEN NULL
                 WHEN ${applicationConflict} THEN NULL
                 WHEN application_link_source = 'manager_confirmation' THEN order_id
                 WHEN application_link_status = 'matched' AND order_id IS NOT NULL
                   AND ${matchedOrderId}::integer IS NULL THEN order_id
                 ELSE ${matchedOrderId} END,
               application_link_status = CASE
                 WHEN application_link_status = 'conflict' THEN 'conflict'
                 WHEN ${applicationConflict} THEN 'conflict'
                 WHEN application_link_source = 'manager_confirmation' THEN application_link_status
                 WHEN application_link_status = 'matched' AND ${matchedApplicationNo}::text IS NULL THEN 'matched'
                 ELSE ${linkStatus} END,
               application_link_source = CASE
                 WHEN application_link_source = 'manager_confirmation' THEN application_link_source
                 WHEN application_link_status = 'matched' AND ${matchedApplicationNo}::text IS NULL THEN application_link_source
                 ELSE 'registration_proof_ai' END,
               application_link_evidence = CASE
                 WHEN application_link_source = 'manager_confirmation' THEN application_link_evidence
                 WHEN application_link_status = 'conflict'
                 THEN jsonb_build_object('existing', application_link_evidence, 'incoming', ${JSON.stringify(matching)}::jsonb)
                 WHEN ${applicationConflict}
                 THEN jsonb_build_object('existing', application_link_evidence, 'incoming', ${JSON.stringify(matching)}::jsonb)
                 WHEN application_link_status = 'matched' AND ${matchedApplicationNo}::text IS NULL THEN application_link_evidence
                 ELSE ${JSON.stringify(matching)}::jsonb END,
               application_linked_at = CASE
                 WHEN application_link_source = 'manager_confirmation' THEN application_linked_at
                 WHEN application_link_status = 'matched' AND ${matchedApplicationNo}::text IS NULL THEN application_linked_at
                 ELSE NOW() END,
               updated_at = NOW()
         WHERE id = ${id}
           AND application_link_source IS DISTINCT FROM 'manager_confirmation'
      `
      if (linkChanged !== 1) {
        const current = await getAttachment(prisma, id)
        if (current?.application_link_source !== 'manager_confirmation') {
          throw new Error('挂号凭证素材关联没有写入附件记录')
        }
      }
      await writeImageAnalysis(prisma, id, { ...analysis, registrationMatch: {
        ...matching, attempts: matchAttempts, status: 'completed', attemptCount: matchAttempt, completedAt: new Date().toISOString()
      } }, true)
      const linked = await getAttachment(prisma, id)
      if (linked?.application_link_status === 'matched' && linked.application_no && linked.order_id !== null) {
        void triggerOrderAiAnalysis(prisma, minio, linked.order_id).catch((error) => {
          console.error(`[native-chat:image] 挂号凭证 ${id} 触发订单字段分析失败：`, error)
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await writeImageAnalysis(prisma, id, { ...analysis, registrationMatch: {
        ...currentAnalysis.registrationMatch, attempts: matchAttempts, status: matchAttempt < MAX_ATTEMPTS ? 'retrying' : 'failed',
        attemptCount: matchAttempt,
        error: message,
        lastAttemptAt: new Date().toISOString()
      } }, matchAttempt >= MAX_ATTEMPTS)
      throw error
    }
  } finally {
    activeAttachments.delete(id)
    concurrentAnalysisCount--
  }
}

async function recoverAvailableImages(prisma: PrismaClient, minio: Minio.Client): Promise<void> {
  if (workerTicking) return
  workerTicking = true
  try {
    if (!await isImageAiEnabled(prisma)) return
    const startAt = await getNativeChatImageAnalysisStartAt(prisma)
    const rows = await prisma.$queryRaw<Array<{ id: number }>>`
      SELECT a.id
        FROM native_chat_attachments a
        JOIN native_chat_messages m ON m.id = a.message_id
        LEFT JOIN LATERAL (
          WITH RECURSIVE ancestors AS (
            SELECT m.conversation_id, m.source_message_id, m.parent_source_message_id, m.occurred_at, ARRAY[m.id] AS visited
            UNION ALL
            SELECT p.conversation_id, p.source_message_id, p.parent_source_message_id, p.occurred_at, ancestors.visited || p.id
              FROM ancestors
              JOIN native_chat_messages p ON p.conversation_id = ancestors.conversation_id
                AND p.source_message_id = ancestors.parent_source_message_id
             WHERE NOT p.id = ANY(ancestors.visited)
          )
          SELECT occurred_at FROM ancestors WHERE parent_source_message_id IS NULL
        ) root ON TRUE
       WHERE a.kind = 'image'
         AND a.state = 'available'
         AND a.storage_key IS NOT NULL
         AND a.source_metadata->>'rendition' = 'non_thumbnail'
         AND (root.occurred_at IS NULL OR root.occurred_at >= (${startAt}::timestamptz AT TIME ZONE 'Asia/Shanghai'))
         AND (
           a.source_metadata->'imageAnalysis' IS NULL
           OR a.source_metadata->'imageAnalysis'->>'status' IN ('retrying', 'pending')
           OR (
             a.source_metadata->'imageAnalysis'->>'status' = 'completed'
             AND a.source_metadata->'imageAnalysis'->>'imageType' = '挂号凭证'
             AND COALESCE(a.source_metadata->'imageAnalysis'->'registrationMatch'->>'status', 'pending') IN ('pending', 'retrying')
           )
         )
       ORDER BY a.id
    `
    for (const row of rows) {
      try {
        await processAttachment(prisma, minio, row.id)
      } catch (error) {
        console.error(`[native-chat:image] 附件 ${row.id} 图片识别/匹配失败：`, error instanceof Error ? error.stack || error.message : error)
      }
    }
  } finally {
    workerTicking = false
  }
}

export function startNativeChatImageAnalysisWorker(prisma: PrismaClient, minio: Minio.Client): void {
  if (workerTimer) return
  void prisma.$executeRaw`
    UPDATE native_chat_attachments
       SET source_metadata = jsonb_set(
         source_metadata,
         '{imageAnalysis,status}',
         to_jsonb(CASE
           WHEN COALESCE((source_metadata->'imageAnalysis'->>'attemptCount')::integer, 0) < ${MAX_ATTEMPTS} THEN 'retrying'
           ELSE 'failed'
         END),
         true
       )
     WHERE source_metadata->'imageAnalysis'->>'status' = 'processing'
  `.catch((error) => console.error('[native-chat:image] 恢复中断的图片识别状态失败：', error))
  void prisma.$executeRaw`
    UPDATE native_chat_attachments
       SET source_metadata = jsonb_set(
         source_metadata,
         '{imageAnalysis,registrationMatch,status}',
         to_jsonb(CASE
           WHEN COALESCE((source_metadata->'imageAnalysis'->'registrationMatch'->>'attemptCount')::integer, 0) < ${MAX_ATTEMPTS} THEN 'retrying'
           ELSE 'failed'
         END),
         true
       )
     WHERE source_metadata->'imageAnalysis'->>'status' = 'completed'
       AND source_metadata->'imageAnalysis'->'registrationMatch'->>'status' = 'processing'
  `.catch((error) => console.error('[native-chat:image] 恢复中断的挂号匹配状态失败：', error))
  workerTimer = setInterval(() => void recoverAvailableImages(prisma, minio), WORKER_INTERVAL_MS)
  setTimeout(() => void recoverAvailableImages(prisma, minio), 1_000)
}

export function notifyNativeChatImageReady(prisma: PrismaClient, minio: Minio.Client, attachmentId: number): void {
  if (concurrentAnalysisCount >= MAX_CONCURRENT_ANALYSIS) return
  void processAttachment(prisma, minio, attachmentId).catch((error) => {
    console.error(`[native-chat:image] 附件 ${attachmentId} 图片处理失败：`, error instanceof Error ? error.stack || error.message : error)
  })
}
