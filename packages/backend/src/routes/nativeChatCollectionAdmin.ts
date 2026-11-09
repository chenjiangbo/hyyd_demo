import type { FastifyInstance } from 'fastify'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { Client } from 'minio'
import { convertNativeChatWxgfToJpeg, getNativeChatWxgfPreviewUrl, removeNativeChatWxgfPreview } from '../services/nativeChatWxgfPreview.js'
import { getNativeChatImageAnalysisStartAt, getOrderAiAutomationConfig } from '../services/orderAiAutomationConfig.js'
import { imageDataUrl, MAX_IMAGE_ANALYSIS_ATTEMPTS } from '../services/nativeChatImageAnalysis.js'
import { understandImage } from '../services/imageUnderstanding.js'
import { matchNativeRegistrationProofToOrders } from '../services/registrationProofService.js'
import {
  getNativeChatCollectionConfig,
  saveNativeChatCollectionConfig,
  validateNativeChatCollectionRules
} from '../services/nativeChatCollectionConfig.js'

const PAGE_SIZE = 50
const ATTACHMENT_BUCKET = 'materials'

type ConversationCursor = { id: number }
type MessageCursor = { occurredAt: string; sourceItemIndex: number; id: number }
type AdminMessageRow = {
  id: number
  source_message_id: string
  parent_source_message_id: string | null
  source_item_index: number | null
  direction: string
  sender_id: string | null
  sender_name: string | null
  kind: string
  source_type_code: string | null
  text: string | null
  source_metadata: Record<string, unknown> | null
  occurred_at: Date
  observed_at: Date
  application_no: string | null
  order_id: number | null
  application_link_status: string
  application_link_source: string | null
  application_link_evidence: Record<string, unknown> | null
}

function encodeCursor(value: ConversationCursor | MessageCursor): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decodeCursor<T extends ConversationCursor | MessageCursor>(value: unknown, kind: 'conversation' | 'message'): T | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 512) throw new Error('分页游标格式无效')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new Error('分页游标格式无效')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('分页游标格式无效')
  const cursor = parsed as Record<string, unknown>
  if (!Number.isSafeInteger(cursor.id) || Number(cursor.id) <= 0) throw new Error('分页游标 ID 无效')
  if (kind === 'message') {
    if (Object.keys(cursor).length !== 3 || !('occurredAt' in cursor) || !('sourceItemIndex' in cursor)) {
      throw new Error('消息分页游标字段不完整')
    }
    if (typeof cursor.occurredAt !== 'string' || !Number.isFinite(Date.parse(cursor.occurredAt))
      || !Number.isSafeInteger(cursor.sourceItemIndex) || Number(cursor.sourceItemIndex) < -1) {
      throw new Error('消息分页游标无效')
    }
  } else if (Object.keys(cursor).length !== 1) {
    throw new Error('会话分页游标字段无效')
  }
  return cursor as T
}

function safeCount(value: bigint): number {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('消息总数超出安全范围')
  return count
}

export function registerNativeChatCollectionAdminRoutes(
  fastify: FastifyInstance,
  prisma: PrismaClient,
  minioClient: Client,
  minioPublicClient: Client
): void {
  fastify.get<{ Params: { source: string; id: string } }>('/api/v1/admin/image-analysis-records/:source/:id/tests', async (request, reply) => {
    const { source } = request.params
    const id = Number(request.params.id)
    if (!['wechat', 'wxwork', 'pet'].includes(source) || !Number.isSafeInteger(id) || id <= 0) return reply.status(400).send({ error: '图片记录无效' })
    const rows = await prisma.$queryRaw<Array<{ id: bigint; status: string; result: unknown; created_at: Date }>>`
      SELECT id, status, result, created_at FROM image_analysis_test_runs WHERE source = ${source} AND source_id = ${id} ORDER BY id DESC
    `
    return reply.send({ data: rows.map((row) => ({ ...row, id: String(row.id) })) })
  })

  fastify.post<{ Params: { source: string; id: string } }>('/api/v1/admin/image-analysis-records/:source/:id/tests', async (request, reply) => {
    const { source } = request.params
    const id = Number(request.params.id)
    if (!['wechat', 'wxwork', 'pet'].includes(source) || !Number.isSafeInteger(id) || id <= 0) return reply.status(400).send({ error: '图片记录无效' })
    const rows = source === 'pet'
      ? await prisma.$queryRaw<Array<{ storage_key: string | null; mime_type: string | null; application_no: string | null }>>`
          SELECT image_storage_key AS storage_key, image_mime_type AS mime_type, NULL::text AS application_no FROM pet_image_analysis_records WHERE id = ${id}`
      : await prisma.$queryRaw<Array<{ storage_key: string | null; mime_type: string | null; application_no: string | null }>>`
          SELECT a.storage_key, a.mime_type,
                 CASE WHEN a.application_link_status = 'matched' THEN a.application_no
                      WHEN m.application_link_status = 'matched' THEN m.application_no ELSE NULL END AS application_no
            FROM native_chat_attachments a JOIN native_chat_messages m ON m.id = a.message_id
            JOIN native_chat_conversations c ON c.id = m.conversation_id
           WHERE a.id = ${id} AND c.channel = ${source} AND a.kind = 'image' AND a.state = 'available'`
    if (!rows[0]) return reply.status(404).send({ error: '图片记录不存在' })
    if (!rows[0].storage_key) return reply.status(409).send({ error: '图片尚未取得，暂时无法测试' })
    const [run] = await prisma.$queryRaw<Array<{ id: bigint }>>`
      INSERT INTO image_analysis_test_runs (source, source_id, status) VALUES (${source}, ${id}, 'running') RETURNING id`
    let result: Record<string, unknown> = { image: null, imageResponse: null, match: null, matchTrace: null }
    const save = async (status: 'running' | 'completed' | 'failed') => {
      await prisma.$executeRaw`UPDATE image_analysis_test_runs SET status = ${status}, result = ${JSON.stringify(result)}::jsonb, updated_at = NOW() WHERE id = ${run.id}`
    }
    try {
      const stream = await minioClient.getObject(ATTACHMENT_BUCKET, rows[0].storage_key)
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const buffer = Buffer.concat(chunks)
      const dataUrl = buffer.subarray(0, 4).toString('ascii') === 'wxgf'
        ? imageDataUrl('image/jpeg', await convertNativeChatWxgfToJpeg(buffer))
        : imageDataUrl(rows[0].mime_type, buffer)
      const { imageAnalysisModel } = await getOrderAiAutomationConfig(prisma)
      const image = await understandImage(dataUrl, imageAnalysisModel, async (response) => {
        result = { ...result, imageResponse: response }
        await save('running')
      })
      result = { ...result, image }
      await save('running')
      if ((image.imageType === '挂号凭证' || image.imageType === '就诊签到记录')) {
        const match = await matchNativeRegistrationProofToOrders(prisma, '', image, {
          applicationNo: rows[0].application_no,
          onAiTrace: async (trace) => { result = { ...result, matchTrace: trace }; await save('running') }
        })
        result = { ...result, match }
      }
      await save('completed')
      return reply.send({ data: { id: String(run.id), status: 'completed', result } })
    } catch (error) {
      result = { ...result, error: error instanceof Error ? error.message : String(error) }
      await save('failed')
      return reply.send({ data: { id: String(run.id), status: 'failed', result } })
    }
  })

  fastify.get<{ Querystring: { cursor?: string; filter?: string } }>('/api/v1/admin/image-analysis-records', async (request, reply) => {
    const filter = request.query.filter ?? 'all'
    if (!['all', 'awaiting', 'waiting_image', 'completed'].includes(filter)) return reply.status(400).send({ error: '图片记录筛选条件无效' })
    let cursor: { time: string; source: string; id: number } | null = null
    if (request.query.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(request.query.cursor, 'base64url').toString('utf8')) as { time: string; source: string; id: number }
        if (!cursor || !Number.isFinite(Date.parse(cursor.time)) || !['wechat', 'wxwork', 'pet'].includes(cursor.source) || !Number.isSafeInteger(cursor.id) || cursor.id <= 0) throw new Error('invalid')
      } catch { return reply.status(400).send({ error: '分页游标无效' }) }
    }
    const startAt = await getNativeChatImageAnalysisStartAt(prisma)
    const records = Prisma.sql`
      WITH image_records AS (
        SELECT a.id, c.channel AS source, e.name AS employee_name, c.title,
               m.occurred_at, a.state, a.source_metadata->'imageAnalysis' AS image_analysis,
               CASE WHEN a.application_link_source = 'manager_confirmation'
                 THEN COALESCE(a.source_metadata->'imageAnalysis'->'registrationMatch', '{}'::jsonb)
                      || jsonb_build_object('managerResolution', a.application_link_evidence)
                 ELSE a.source_metadata->'imageAnalysis'->'registrationMatch' END AS registration_match,
               NULL::text AS error, a.order_id,
               (a.state = 'available' AND a.storage_key IS NOT NULL) AS image_available,
               (root.occurred_at IS NULL) AS received_time_unknown,
               a.source_metadata->>'rendition' AS image_rendition,
               a.source_metadata->>'nonThumbnailState' AS full_image_state,
               (a.state = 'available' AND a.storage_key IS NOT NULL
                AND a.source_metadata->>'rendition' = 'non_thumbnail'
                AND root.occurred_at IS NOT NULL
                AND root.direction = 'outgoing'
                AND COALESCE(c.title, '') NOT LIKE '%护工%'
                AND (a.source_metadata->'imageAnalysis' IS NULL
                     OR a.source_metadata->'imageAnalysis'->>'status' IN ('pending', 'retrying'))
                AND CASE WHEN jsonb_typeof(a.source_metadata->'imageAnalysis'->'attemptCount') = 'number'
                     THEN (a.source_metadata->'imageAnalysis'->>'attemptCount')::numeric < ${MAX_IMAGE_ANALYSIS_ATTEMPTS}
                     ELSE TRUE END) AS awaiting_ai,
               (COALESCE(a.source_metadata->'imageAnalysis'->>'status', '') <> 'completed'
                AND (a.state <> 'available' OR a.storage_key IS NULL
                     OR COALESCE(a.source_metadata->>'rendition', '') <> 'non_thumbnail')) AS waiting_image
          FROM native_chat_attachments a
          JOIN native_chat_messages m ON m.id = a.message_id
          JOIN native_chat_conversations c ON c.id = m.conversation_id
          JOIN employees e ON e.id = c.employee_id
          LEFT JOIN LATERAL (
            WITH RECURSIVE ancestors AS (
              SELECT m.conversation_id, m.source_message_id, m.parent_source_message_id, m.occurred_at, m.direction, ARRAY[m.id] AS visited
              UNION ALL
              SELECT p.conversation_id, p.source_message_id, p.parent_source_message_id, p.occurred_at, p.direction, ancestors.visited || p.id
                FROM ancestors
                JOIN native_chat_messages p ON p.conversation_id = ancestors.conversation_id
                  AND p.source_message_id = ancestors.parent_source_message_id
               WHERE NOT p.id = ANY(ancestors.visited)
            )
            SELECT occurred_at, direction FROM ancestors WHERE parent_source_message_id IS NULL
          ) root ON TRUE
         WHERE a.kind = 'image'
           AND (root.occurred_at IS NULL OR root.occurred_at >= (${startAt}::timestamptz AT TIME ZONE 'Asia/Shanghai'))
        UNION ALL
        SELECT p.id, 'pet'::text, e.name, NULL::text, p.created_at, p.status,
               p.image_analysis, p.registration_match, p.error, p.order_id, (p.image_storage_key IS NOT NULL), false, NULL::text, NULL::text, false, false
          FROM pet_image_analysis_records p JOIN employees e ON e.id = p.employee_id
         WHERE p.created_at >= (${startAt}::timestamptz AT TIME ZONE 'Asia/Shanghai')
      )
    `
    const filterCondition = filter === 'awaiting' ? Prisma.sql`awaiting_ai` : filter === 'waiting_image' ? Prisma.sql`waiting_image` : filter === 'completed' ? Prisma.sql`(image_analysis->>'status' = 'completed' OR (source = 'pet' AND image_analysis IS NOT NULL))` : Prisma.sql`TRUE`
    const [rows, counts] = await prisma.$transaction([
      prisma.$queryRaw<Array<{ id: number; source: string; employee_name: string; title: string | null; occurred_at: Date; state: string; image_analysis: unknown; registration_match: unknown; error: string | null; order_id: number | null; image_available: boolean; received_time_unknown: boolean }>>(Prisma.sql`
        ${records}
        SELECT * FROM image_records
        WHERE ${filterCondition}
        ${cursor ? Prisma.sql`AND (occurred_at < ${new Date(cursor.time)}::timestamp OR (occurred_at = ${new Date(cursor.time)}::timestamp AND (source > ${cursor.source} OR (source = ${cursor.source} AND id < ${cursor.id}))))` : Prisma.empty}
        ORDER BY occurred_at DESC, source ASC, id DESC LIMIT ${PAGE_SIZE + 1}
      `),
      prisma.$queryRaw<Array<{ total: bigint; awaiting_ai: bigint; filtered_total: bigint }>>(Prisma.sql`${records} SELECT COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE awaiting_ai)::bigint AS awaiting_ai, COUNT(*) FILTER (WHERE ${filterCondition})::bigint AS filtered_total FROM image_records`)
    ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
    const items = rows.slice(0, PAGE_SIZE)
    const last = items.at(-1)
    const nextCursor = rows.length > PAGE_SIZE && last ? Buffer.from(JSON.stringify({ time: last.occurred_at.toISOString(), source: last.source, id: last.id })).toString('base64url') : null
    return reply.send({ data: { items, nextCursor, total: safeCount(counts[0]?.total ?? 0n), awaitingAi: safeCount(counts[0]?.awaiting_ai ?? 0n), filteredTotal: safeCount(counts[0]?.filtered_total ?? 0n) } })
  })

  fastify.get<{ Params: { recordId: string } }>('/api/v1/admin/image-analysis-records/pet/:recordId/url', async (request, reply) => {
    const id = Number(request.params.recordId)
    if (!Number.isSafeInteger(id) || id <= 0) return reply.status(400).send({ error: '图片记录无效' })
    const rows = await prisma.$queryRaw<Array<{ image_storage_key: string | null }>>`
      SELECT image_storage_key FROM pet_image_analysis_records WHERE id = ${id}
    `
    if (!rows[0]) return reply.status(404).send({ error: '图片记录不存在' })
    if (!rows[0].image_storage_key) return reply.status(404).send({ error: '这条记录没有保存原图' })
    const url = await minioPublicClient.presignedGetObject(ATTACHMENT_BUCKET, rows[0].image_storage_key, 60 * 60)
    return reply.send({ data: { url } })
  })

  fastify.get('/api/v1/admin/native-chat-collection-config', async (_request, reply) => {
    return reply.send({ data: await getNativeChatCollectionConfig(prisma) })
  })

  fastify.get('/api/v1/admin/native-chat-sessions', async (_request, reply) => {
    const sessions = await prisma.$queryRaw<Array<{
      channel: string
      account_id: string
      source_conversation_id: string
      title: string | null
      conversation_kind: string
      application_no: string | null
      application_candidate: string | null
      application_link_status: string
      employee_id: number
      employee_name: string
      last_observed_at: Date
    }>>`
      SELECT DISTINCT ON (c.channel, c.account_id, c.source_conversation_id)
             c.channel, c.account_id, c.source_conversation_id, c.title,
             c.conversation_kind, c.application_no, c.application_candidate, c.application_link_status,
             c.employee_id, e.name AS employee_name, c.last_observed_at
        FROM native_chat_conversations c
        JOIN employees e ON e.id = c.employee_id
       ORDER BY c.channel, c.account_id, c.source_conversation_id, c.last_observed_at DESC
    `
    return reply.send({ data: sessions.map((session) => ({
      channel: session.channel,
      accountId: session.account_id,
      sourceConversationId: session.source_conversation_id,
      title: session.title,
      kind: session.conversation_kind,
      applicationNo: session.application_no,
      applicationCandidate: session.application_candidate,
      applicationLinkStatus: session.application_link_status,
      employeeId: session.employee_id,
      employeeName: session.employee_name,
      lastObservedAt: session.last_observed_at.toISOString()
    })) })
  })

  fastify.get<{
    Querystring: { channel?: string }
  }>('/api/v1/admin/native-chat-accounts', async (request, reply) => {
    const channel = request.query.channel
    if (channel !== 'wechat' && channel !== 'wxwork') {
      return reply.status(400).send({ error: '消息渠道无效' })
    }
    const accounts = await prisma.$queryRaw<Array<{ employee_id: number; employee_name: string; account_id: string }>>`
      SELECT DISTINCT c.employee_id, e.name AS employee_name, c.account_id
        FROM native_chat_conversations c
        JOIN employees e ON e.id = c.employee_id
       WHERE c.channel = ${channel}
       ORDER BY e.name, c.employee_id, c.account_id
    `
    return reply.send({ data: accounts.map((account) => ({
      employeeId: account.employee_id,
      employeeName: account.employee_name,
      accountId: account.account_id
    })) })
  })

  fastify.post<{
    Body: { channel?: unknown; employeeId?: unknown; accountId?: unknown }
  }>('/api/v1/admin/native-chat-accounts/clear-messages', async (request, reply) => {
    const { channel, employeeId, accountId } = request.body ?? {}
    if (channel !== 'wechat' && channel !== 'wxwork') {
      return reply.status(400).send({ error: '消息渠道无效' })
    }
    if (!Number.isSafeInteger(employeeId) || Number(employeeId) <= 0) {
      return reply.status(400).send({ error: '员工选择无效' })
    }
    if (typeof accountId !== 'string' || !accountId.trim() || accountId.length > 200) {
      return reply.status(400).send({ error: '采集账号无效' })
    }

    const scope = { channel, employeeId: Number(employeeId), accountId: accountId.trim() }
    const [counts, storageRows] = await Promise.all([
      prisma.$queryRaw<Array<{ attachment_count: bigint }>>`
        SELECT COUNT(DISTINCT a.id)::bigint AS attachment_count
          FROM native_chat_conversations c
          LEFT JOIN native_chat_messages m ON m.conversation_id = c.id
          LEFT JOIN native_chat_attachments a ON a.message_id = m.id
         WHERE c.channel = ${scope.channel}
           AND c.employee_id = ${scope.employeeId}
           AND c.account_id = ${scope.accountId}
      `,
      prisma.$queryRaw<Array<{ id: number; storage_key: string; kind: string }>>`
        SELECT a.id, a.storage_key, a.kind
          FROM native_chat_attachments a
          JOIN native_chat_messages m ON m.id = a.message_id
          JOIN native_chat_conversations c ON c.id = m.conversation_id
         WHERE c.channel = ${scope.channel}
           AND c.employee_id = ${scope.employeeId}
           AND c.account_id = ${scope.accountId}
           AND a.storage_key IS NOT NULL
      `
    ])

    const deletedMessages = await prisma.nativeChatMessage.deleteMany({
      where: { conversation: { is: scope } }
    })

    let storageCleanupFailures = 0
    for (let offset = 0; offset < storageRows.length; offset += 20) {
      const batch = storageRows.slice(offset, offset + 20)
      const results = await Promise.allSettled(batch.map(async (row) => {
        await minioClient.removeObject(ATTACHMENT_BUCKET, row.storage_key)
        if (row.kind === 'image') await removeNativeChatWxgfPreview(minioClient, row.id)
      }))
      storageCleanupFailures += results.filter((result) => result.status === 'rejected').length
    }
    if (storageCleanupFailures > 0) {
      request.log.error({ ...scope, storageCleanupFailures }, 'Native chat account message records cleared, but some attachment objects could not be removed')
    }

    const count = counts[0]
    request.log.info({
      ...scope,
      deletedMessages: deletedMessages.count,
      deletedAttachments: safeCount(count?.attachment_count ?? 0n),
      storageCleanupFailures
    }, 'Native chat account messages cleared by admin')
    return reply.send({ data: {
      deletedMessages: deletedMessages.count,
      deletedAttachments: safeCount(count?.attachment_count ?? 0n),
      storageObjectsRemoved: storageRows.length - storageCleanupFailures,
      storageCleanupFailures
    } })
  })

  fastify.get<{
    Querystring: { cursor?: string; channel?: string; search?: string; employeeId?: string; accountId?: string }
  }>('/api/v1/admin/native-chat-conversations', async (request, reply) => {
    let cursor: ConversationCursor | null
    try {
      cursor = decodeCursor<ConversationCursor>(request.query.cursor, 'conversation')
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '分页游标无效' })
    }
    const channel = request.query.channel || null
    if (channel !== null && channel !== 'wechat' && channel !== 'wxwork') {
      return reply.status(400).send({ error: '消息渠道无效' })
    }
    const search = request.query.search?.trim() || null
    if (search && search.length > 200) return reply.status(400).send({ error: '搜索内容不能超过 200 个字符' })
    const employeeId = request.query.employeeId === undefined ? null : Number(request.query.employeeId)
    if (employeeId !== null && (!Number.isSafeInteger(employeeId) || employeeId <= 0)) {
      return reply.status(400).send({ error: '员工选择无效' })
    }
    const accountId = request.query.accountId?.trim() || null
    if (accountId !== null && (accountId.length > 200 || employeeId === null || channel === null)) {
      return reply.status(400).send({ error: '采集账号筛选条件无效' })
    }
    const rows = await prisma.$queryRaw<Array<{
      id: number
      channel: string
      account_id: string
      source_conversation_id: string
      title: string | null
      conversation_kind: string
      application_no: string | null
      application_candidate: string | null
      application_link_status: string
      employee_id: number
      employee_name: string
      first_observed_at: Date
      last_observed_at: Date
      message_count: bigint
      attachment_count: bigint
      last_message_at: Date | null
    }>>`
      SELECT c.id, c.channel, c.account_id, c.source_conversation_id, c.title,
             c.conversation_kind, c.application_no, c.application_candidate, c.application_link_status,
             c.employee_id, e.name AS employee_name,
             c.first_observed_at, c.last_observed_at,
             COALESCE(mc.message_count, 0)::bigint AS message_count,
             COALESCE(ac.attachment_count, 0)::bigint AS attachment_count,
             mc.last_message_at
        FROM native_chat_conversations c
        JOIN employees e ON e.id = c.employee_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS message_count, MAX(m.occurred_at) AS last_message_at
            FROM native_chat_messages m WHERE m.conversation_id = c.id
        ) mc ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS attachment_count
            FROM native_chat_attachments a
            JOIN native_chat_messages m ON m.id = a.message_id
           WHERE m.conversation_id = c.id
        ) ac ON TRUE
       WHERE (${cursor?.id ?? null}::integer IS NULL OR c.id < ${cursor?.id ?? null})
         AND (${channel}::text IS NULL OR c.channel = ${channel})
         AND (${employeeId}::integer IS NULL OR c.employee_id = ${employeeId})
         AND (${accountId}::text IS NULL OR c.account_id = ${accountId})
         AND EXISTS (SELECT 1 FROM native_chat_messages m WHERE m.conversation_id = c.id)
         AND (
           ${search}::text IS NULL
           OR COALESCE(c.title, '') ILIKE '%' || ${search} || '%'
           OR e.name ILIKE '%' || ${search} || '%'
           OR c.account_id ILIKE '%' || ${search} || '%'
         )
       ORDER BY c.id DESC
       LIMIT ${PAGE_SIZE + 1}
    `
    const hasMore = rows.length > PAGE_SIZE
    const page = rows.slice(0, PAGE_SIZE)
    const last = page.at(-1)
    return reply.send({ data: {
      items: page.map((row) => ({
        id: row.id,
        channel: row.channel,
        accountId: row.account_id,
        sourceConversationId: row.source_conversation_id,
        title: row.title,
        kind: row.conversation_kind,
        applicationNo: row.application_no,
        applicationCandidate: row.application_candidate,
        applicationLinkStatus: row.application_link_status,
        employeeId: row.employee_id,
        employeeName: row.employee_name,
        firstObservedAt: row.first_observed_at.toISOString(),
        lastObservedAt: row.last_observed_at.toISOString(),
        messageCount: safeCount(row.message_count),
        attachmentCount: safeCount(row.attachment_count),
        lastMessageAt: row.last_message_at?.toISOString() ?? null
      })),
      nextCursor: hasMore && last ? encodeCursor({ id: last.id }) : null
    } })
  })

  fastify.get<{
    Params: { conversationId: string }
    Querystring: { before?: string }
  }>('/api/v1/admin/native-chat-conversations/:conversationId/messages', async (request, reply) => {
    const conversationId = Number(request.params.conversationId)
    if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
      return reply.status(400).send({ error: '会话 ID 无效' })
    }
    let before: MessageCursor | null
    try {
      before = decodeCursor<MessageCursor>(request.query.before, 'message')
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '消息分页游标无效' })
    }

    const conversation = await prisma.nativeChatConversation.findUnique({
      where: { id: conversationId },
      include: { employee: { select: { name: true } } }
    })
    if (!conversation) return reply.status(404).send({ error: '会话记录不存在' })

    const [totalMessages, rows] = await Promise.all([
      prisma.nativeChatMessage.count({ where: { conversationId } }),
      prisma.$queryRaw<AdminMessageRow[]>`
        SELECT m.id, m.source_message_id, m.parent_source_message_id,
               m.source_item_index, m.direction, m.sender_id, m.sender_name,
               m.kind, m.source_type_code, m.text, m.source_metadata, m.occurred_at, m.observed_at,
               m.application_no, m.order_id, m.application_link_status, m.application_link_source, m.application_link_evidence
          FROM native_chat_messages m
         WHERE m.conversation_id = ${conversationId}
           AND (
             ${before?.occurredAt ?? null}::timestamptz IS NULL
             OR (m.occurred_at, COALESCE(m.source_item_index, -1), m.id)
                < (${before?.occurredAt ?? null}::timestamptz,
                   ${before?.sourceItemIndex ?? null}::integer,
                   ${before?.id ?? null}::integer)
           )
         ORDER BY m.occurred_at DESC, COALESCE(m.source_item_index, -1) DESC, m.id DESC
         LIMIT ${PAGE_SIZE + 1}
      `
    ])
    const hasMore = rows.length > PAGE_SIZE
    const pageDescending = rows.slice(0, PAGE_SIZE)
    const mergedParentIds = [...new Set(pageDescending.filter((row) => row.kind === 'merged').map((row) => row.source_message_id))]
    const mergedChildren = mergedParentIds.length
      ? await prisma.$queryRaw<AdminMessageRow[]>`
          SELECT m.id, m.source_message_id, m.parent_source_message_id,
                 m.source_item_index, m.direction, m.sender_id, m.sender_name,
                 m.kind, m.source_type_code, m.text, m.source_metadata, m.occurred_at, m.observed_at,
                 m.application_no, m.order_id, m.application_link_status, m.application_link_source, m.application_link_evidence
            FROM native_chat_messages m
           WHERE m.conversation_id = ${conversationId}
             AND m.parent_source_message_id IN (${Prisma.join(mergedParentIds)})
           ORDER BY m.parent_source_message_id, m.source_item_index, m.id
        `
      : []
    const rowsById = new Map([...pageDescending, ...mergedChildren].map((row) => [row.id, row]))
    const visibleRows = [...pageDescending].filter((row) => row.parent_source_message_id === null)
    const messageIds = [...rowsById.keys()]
    const attachments = messageIds.length
      ? await prisma.nativeChatAttachment.findMany({
        where: { messageId: { in: messageIds } },
        orderBy: [{ messageId: 'asc' }, { id: 'asc' }]
      })
      : []
    const attachmentsByMessage = new Map<number, typeof attachments>()
    for (const attachment of attachments) {
      const list = attachmentsByMessage.get(attachment.messageId) ?? []
      list.push(attachment)
      attachmentsByMessage.set(attachment.messageId, list)
    }

    const serializedChildren = new Map<string, AdminMessageRow[]>()
    for (const child of rowsById.values()) {
      if (!child.parent_source_message_id || !mergedParentIds.includes(child.parent_source_message_id)) continue
      const children = serializedChildren.get(child.parent_source_message_id) ?? []
      children.push(child)
      serializedChildren.set(child.parent_source_message_id, children)
    }
    const serializeMessage = (message: AdminMessageRow) => ({
      id: message.id,
      sourceMessageId: message.source_message_id,
      parentSourceMessageId: message.parent_source_message_id,
      sourceItemIndex: message.source_item_index,
      direction: message.direction,
      senderId: message.sender_id,
      senderName: message.sender_name,
      kind: message.kind,
      sourceTypeCode: message.source_type_code,
      text: message.text,
      sourceMetadata: message.source_metadata,
      applicationNo: message.application_no,
      orderId: message.order_id,
      applicationLinkStatus: message.application_link_status,
      applicationLinkSource: message.application_link_source,
      applicationLinkEvidence: message.application_link_evidence,
      occurredAt: message.occurred_at.toISOString(),
      observedAt: message.observed_at.toISOString(),
      attachments: (attachmentsByMessage.get(message.id) ?? []).map((attachment) => ({
        id: attachment.id,
        kind: attachment.kind,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        byteSize: attachment.byteSize?.toString() ?? null,
        state: attachment.state,
        sourceMetadata: attachment.sourceMetadata as Record<string, unknown> | null,
        applicationNo: attachment.applicationNo,
        orderId: attachment.orderId,
        applicationLinkStatus: attachment.applicationLinkStatus,
        applicationLinkSource: attachment.applicationLinkSource,
        applicationLinkEvidence: attachment.applicationLinkEvidence as Record<string, unknown> | null,
        availableInStorage: attachment.state === 'available' && attachment.storageKey !== null
      }))
    })
    const last = pageDescending.at(-1)
    const items = [...visibleRows].reverse().map((message) => ({
      ...serializeMessage(message),
      ...(message.kind === 'merged'
        ? { children: (serializedChildren.get(message.source_message_id) ?? []).map(serializeMessage) }
        : {})
    }))

    return reply.send({ data: {
      conversation: {
        id: conversation.id,
        channel: conversation.channel,
        title: conversation.title,
        applicationNo: conversation.applicationNo,
        applicationCandidate: conversation.applicationCandidate,
        applicationLinkStatus: conversation.applicationLinkStatus,
        employeeName: conversation.employee.name
      },
      items,
      totalMessages,
      nextCursor: hasMore && last ? encodeCursor({
        occurredAt: last.occurred_at.toISOString(),
        sourceItemIndex: last.source_item_index ?? -1,
        id: last.id
      }) : null
    } })
  })

  fastify.post<{
    Params: { messageId: string }
    Body: { applicationNo?: string; orderId?: number | null }
  }>('/api/v1/admin/native-chat-messages/:messageId/resolve-business-link', async (request, reply) => {
    const messageId = Number(request.params.messageId)
    const applicationNo = typeof request.body?.applicationNo === 'string' ? request.body.applicationNo.trim() : ''
    const orderId = request.body?.orderId == null ? null : Number(request.body.orderId)
    if (!Number.isSafeInteger(messageId) || messageId <= 0 || !applicationNo) {
      return reply.status(400).send({ error: '消息 ID 或申领号无效' })
    }
    if (orderId !== null && (!Number.isSafeInteger(orderId) || orderId <= 0)) {
      return reply.status(400).send({ error: '订单 ID 无效' })
    }
    const message = await prisma.nativeChatMessage.findUnique({
      where: { id: messageId },
      select: { id: true, applicationNo: true, orderId: true, applicationLinkStatus: true, applicationLinkSource: true, applicationLinkEvidence: true }
    })
    if (!message) return reply.status(404).send({ error: '消息记录不存在' })
    const matchingOrders = await prisma.$queryRaw<Array<{ id: number; application_no: string | null }>>`
      SELECT id, raw_json->>'crmApplyNo' AS application_no
        FROM orders
       WHERE raw_json->>'crmApplyNo' = ${applicationNo}
         ${orderId === null ? Prisma.empty : Prisma.sql`AND id = ${orderId}`}
    `
    if (orderId !== null && !matchingOrders.some((order) => order.id === orderId && order.application_no === applicationNo)) {
      return reply.status(400).send({ error: '所选订单不属于该申领号' })
    }
    if (orderId === null && matchingOrders.length === 0) {
      return reply.status(400).send({ error: '申领号未对应到系统订单' })
    }
    const evidence = {
      status: 'manager_confirmed',
      applicationNo,
      orderId,
      previous: {
        applicationNo: message.applicationNo,
        orderId: message.orderId,
        status: message.applicationLinkStatus,
        source: message.applicationLinkSource,
        evidence: message.applicationLinkEvidence
      },
      confirmedAt: new Date().toISOString()
    }
    await prisma.nativeChatMessage.update({
      where: { id: messageId },
      data: {
        applicationNo,
        orderId,
        applicationLinkStatus: 'matched',
        applicationLinkSource: 'manager_confirmation',
        applicationLinkEvidence: evidence,
        applicationLinkedAt: new Date()
      }
    })
    request.log.info({ event: 'native_chat_message_link_confirmed', messageId, applicationNo, orderId })
    return reply.send({ data: { messageId, applicationNo, orderId, confirmed: true } })
  })

  fastify.get<{ Params: { attachmentId: string } }>(
    '/api/v1/admin/native-chat-attachments/:attachmentId/url',
    async (request, reply) => {
      const attachmentId = Number(request.params.attachmentId)
      if (!Number.isSafeInteger(attachmentId) || attachmentId <= 0) {
        return reply.status(400).send({ error: '附件 ID 无效' })
      }
      const attachment = await prisma.nativeChatAttachment.findUnique({ where: { id: attachmentId } })
      if (!attachment) return reply.status(404).send({ error: '附件记录不存在' })
      if (attachment.state !== 'available' || !attachment.storageKey) {
        return reply.status(409).send({ error: '该附件尚未上传到后台存储' })
      }
      if (attachment.kind === 'image' && attachment.fileName?.toLowerCase().endsWith('.wxgf')) {
        const url = await getNativeChatWxgfPreviewUrl(
          minioClient, minioPublicClient, attachment.id, attachment.storageKey
        )
        return reply.send({ data: { url } })
      }
      const url = await minioPublicClient.presignedGetObject(ATTACHMENT_BUCKET, attachment.storageKey, 60 * 60)
      return reply.send({ data: { url } })
    }
  )

  fastify.put<{ Body: { rules?: unknown } }>(
    '/api/v1/admin/native-chat-collection-config',
    async (request, reply) => {
      try {
        const rules = validateNativeChatCollectionRules(request.body?.rules)
        const config = await saveNativeChatCollectionConfig(prisma, rules)
        return reply.send({ data: config, message: '会话采集规则已保存' })
      } catch (error) {
        return reply.status(400).send({
          error: error instanceof Error ? error.message : '会话采集规则无效'
        })
      }
    }
  )
}
