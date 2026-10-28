import type { FastifyInstance } from 'fastify'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { Client } from 'minio'
import { getNativeChatWxgfPreviewUrl } from '../services/nativeChatWxgfPreview.js'
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
         AND EXISTS (
         SELECT 1 FROM native_chat_messages m WHERE m.conversation_id = c.id
       )
       ORDER BY e.name, c.employee_id, c.account_id
    `
    return reply.send({ data: accounts.map((account) => ({
      employeeId: account.employee_id,
      employeeName: account.employee_name,
      accountId: account.account_id
    })) })
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
               m.kind, m.source_type_code, m.text, m.source_metadata, m.occurred_at, m.observed_at
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
                 m.kind, m.source_type_code, m.text, m.source_metadata, m.occurred_at, m.observed_at
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
