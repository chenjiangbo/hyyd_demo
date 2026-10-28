import type { PrismaClient } from '@prisma/client'
import type * as Minio from 'minio'
import { matchNativeRegistrationProofToOrders } from './registrationProofService.js'
import { understandImage } from './imageUnderstanding.js'

const BUCKET = 'materials'
const WORKER_INTERVAL_MS = 15_000
const PROMPT_VERSION = 'image-understanding-v1'
const MAX_ATTEMPTS = 2
const activeAttachments = new Set<number>()
let workerTimer: ReturnType<typeof setInterval> | null = null
let workerTicking = false

export type NativeImageType =
  | '挂号凭证'
  | '出行订单'
  | '导航截图'
  | '医院小程序'
  | '医院公众号'
  | '缴费或检查材料'
  | '聊天截图'
  | '其他'
  | '无法判断'

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
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}

function imageDataUrl(mimeType: string | null, buffer: Buffer): string {
  const supported = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/bmp', 'image/gif'])
  const normalized = mimeType?.trim().toLowerCase()
  if (!normalized || !supported.has(normalized)) throw new Error(`不支持的图片格式：${mimeType || '未提供 MIME 类型'}`)
  const canonical = normalized === 'image/jpg' ? 'image/jpeg' : normalized
  return `data:${canonical};base64,${buffer.toString('base64')}`
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
    application_link_status: string
    employee_id: number
  }>>`
    SELECT a.id, a.message_id, m.conversation_id, a.kind, a.mime_type, a.storage_key, a.state, a.source_metadata,
           c.application_no, c.application_link_status, c.employee_id
      FROM native_chat_attachments a
      JOIN native_chat_messages m ON m.id = a.message_id
      JOIN native_chat_conversations c ON c.id = m.conversation_id
     WHERE a.id = ${id}
  `
  return rows[0] ?? null
}

async function processAttachment(prisma: PrismaClient, minio: Minio.Client, id: number): Promise<void> {
  if (activeAttachments.has(id)) return
  activeAttachments.add(id)
  try {
    const attachment = await getAttachment(prisma, id)
    if (!attachment || attachment.kind !== 'image' || attachment.state !== 'available' || !attachment.storage_key) return
    const metadata = asRecord(attachment.source_metadata) ?? {}
    if (metadata.rendition !== 'non_thumbnail') return
    let analysis = asRecord(metadata.imageAnalysis)
    let dataUrl: string | null = null
    if (analysis?.status !== 'completed') {
      if (analysis?.status === 'failed') return
      const attemptCount = typeof analysis?.attemptCount === 'number' ? analysis.attemptCount : 0
      if (attemptCount >= MAX_ATTEMPTS) return
      const attempt = attemptCount + 1
      await writeImageAnalysis(prisma, id, {
        status: 'processing', attemptCount: attempt, promptVersion: PROMPT_VERSION, startedAt: new Date().toISOString()
      }, false)
      try {
        const stream = await minio.getObject(BUCKET, attachment.storage_key)
        const buffer = await streamToBuffer(stream)
        dataUrl = imageDataUrl(attachment.mime_type, buffer)
        const parsed = parseAnalysis(await understandImage(dataUrl), attempt)
        const latest = await getAttachment(prisma, id)
        const latestMetadata = asRecord(latest?.source_metadata) ?? {}
        if (!latest || latest.storage_key !== attachment.storage_key
          || latestMetadata.content_hash !== metadata.content_hash) {
          console.info(`[native-chat:image] 附件 ${id} 在识别期间被更新，丢弃旧图片的识别结果`)
          return
        }
        await writeImageAnalysis(prisma, id, parsed, true)
        analysis = parsed as unknown as Record<string, unknown>
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await writeImageAnalysis(prisma, id, {
          status: attempt < MAX_ATTEMPTS ? 'retrying' : 'failed',
          attemptCount: attempt,
          promptVersion: PROMPT_VERSION,
          error: message,
          lastAttemptAt: new Date().toISOString()
        }, attempt >= MAX_ATTEMPTS)
        throw error
      }
    }

    if (analysis?.imageType !== '挂号凭证') return
    const priorMatch = asRecord(analysis.registrationMatch)
    if (priorMatch?.status === 'completed' || priorMatch?.status === 'failed') return
    const matchAttemptCount = typeof priorMatch?.attemptCount === 'number' ? priorMatch.attemptCount : 0
    if (matchAttemptCount >= MAX_ATTEMPTS) return
    const matchAttempt = matchAttemptCount + 1
    const currentAnalysis = { ...analysis, registrationMatch: {
      status: 'processing', attemptCount: matchAttempt, startedAt: new Date().toISOString()
    } }
    await writeImageAnalysis(prisma, id, currentAnalysis, false)
    try {
      if (!dataUrl) {
        const stream = await minio.getObject(BUCKET, attachment.storage_key)
        dataUrl = imageDataUrl(attachment.mime_type, await streamToBuffer(stream))
      }
      const matching = await matchNativeRegistrationProofToOrders(prisma, dataUrl, analysis as unknown as NativeChatImageAnalysis, {
        applicationNo: attachment.application_link_status === 'matched' ? attachment.application_no : null,
        conversationId: attachment.conversation_id,
      })
      const latest = await getAttachment(prisma, id)
      const latestMetadata = asRecord(latest?.source_metadata) ?? {}
      if (!latest || latest.storage_key !== attachment.storage_key || latestMetadata.content_hash !== metadata.content_hash) {
        console.info(`[native-chat:image] 附件 ${id} 在订单匹配期间被更新，丢弃旧图片的匹配结果`)
        return
      }
      if (!attachment.application_no && matching.applicationDecision === 'matched' && matching.applicationNo) {
        const changed = await prisma.$executeRaw`
          UPDATE native_chat_conversations c
             SET application_no = ${matching.applicationNo},
                 application_link_status = 'matched',
                 application_linked_at = NOW()
            FROM native_chat_messages m
           WHERE m.id = ${attachment.message_id}
             AND c.id = m.conversation_id
             AND c.application_no IS NULL
        `
        if (changed !== 1) {
          const latest = await getAttachment(prisma, id)
          if (latest?.application_no !== matching.applicationNo) {
            throw new Error('会话申领号在图片分析期间被其他操作更新，请重新核对')
          }
        }
      }
      await writeImageAnalysis(prisma, id, { ...analysis, registrationMatch: {
        ...matching, status: 'completed', attemptCount: matchAttempt, completedAt: new Date().toISOString()
      } }, true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await writeImageAnalysis(prisma, id, { ...analysis, registrationMatch: {
        status: matchAttempt < MAX_ATTEMPTS ? 'retrying' : 'failed',
        attemptCount: matchAttempt,
        error: message,
        lastAttemptAt: new Date().toISOString()
      } }, matchAttempt >= MAX_ATTEMPTS)
      throw error
    }
  } finally {
    activeAttachments.delete(id)
  }
}

async function recoverAvailableImages(prisma: PrismaClient, minio: Minio.Client): Promise<void> {
  if (workerTicking) return
  workerTicking = true
  try {
    const rows = await prisma.$queryRaw<Array<{ id: number }>>`
      SELECT id
        FROM native_chat_attachments
       WHERE kind = 'image'
         AND state = 'available'
         AND storage_key IS NOT NULL
         AND source_metadata->>'rendition' = 'non_thumbnail'
         AND (
           source_metadata->'imageAnalysis' IS NULL
           OR source_metadata->'imageAnalysis'->>'status' IN ('retrying', 'pending')
           OR (
             source_metadata->'imageAnalysis'->>'status' = 'completed'
             AND source_metadata->'imageAnalysis'->>'imageType' = '挂号凭证'
             AND COALESCE(source_metadata->'imageAnalysis'->'registrationMatch'->>'status', 'pending') IN ('pending', 'retrying')
           )
         )
       ORDER BY id
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
  void processAttachment(prisma, minio, attachmentId).catch((error) => {
    console.error(`[native-chat:image] 附件 ${attachmentId} 图片处理失败：`, error instanceof Error ? error.stack || error.message : error)
  })
}
