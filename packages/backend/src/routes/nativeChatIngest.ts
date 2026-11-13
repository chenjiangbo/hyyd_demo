import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { NativeChatAttachment, NativeChatMessage } from '@huanyu/shared-types'
import { resolveNativeMessageBusinessLinks } from '../services/nativeChatMessageLink.js'
import { isEscortSummaryEligibleText } from '../services/escortSummaryEligibility.js'

type IngestBody = {
  conversation: {
    channel: 'wechat' | 'wxwork'
    accountId: string
    sourceConversationId: string
    title: string | null
    kind: 'group' | 'single' | 'service' | 'unknown'
    sourceMetadata?: Record<string, unknown> | null
  }
  messages: NativeChatMessage[]
}

const MESSAGE_KINDS = new Set([
  'text', 'image', 'file', 'video', 'audio', 'voice', 'link', 'location', 'emoji', 'system', 'merged', 'unknown'
])
const DIRECTIONS = new Set(['incoming', 'outgoing', 'system', 'unknown'])
const ATTACHMENT_KINDS = new Set(['image', 'file', 'video', 'audio', 'voice', 'other'])
const ATTACHMENT_STATES = new Set([
  'available', 'not_downloaded', 'not_found', 'ambiguous', 'invalid', 'unsupported', 'error'
])

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`)
  return value.trim()
}

function nullableText(value: unknown, label: string): string | null {
  if (value == null) return null
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`)
  return value
}

function validDate(value: unknown, label: string): Date {
  if (typeof value !== 'string') throw new Error(`${label}必须是 ISO 时间字符串`)
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(`${label}不是有效时间`)
  return date
}

function jsonValue(value: unknown, label: string): string | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`)
  return JSON.stringify(value)
}

function validateBody(input: unknown): IngestBody {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求内容必须是对象')
  const body = input as Record<string, unknown>
  const rawConversation = body.conversation
  if (!rawConversation || typeof rawConversation !== 'object' || Array.isArray(rawConversation)) {
    throw new Error('conversation 必须是对象')
  }
  const c = rawConversation as Record<string, unknown>
  if (c.channel !== 'wechat' && c.channel !== 'wxwork') throw new Error('conversation.channel 无效')
  const kind = c.kind
  if (kind !== 'group' && kind !== 'single' && kind !== 'service' && kind !== 'unknown') {
    throw new Error('conversation.kind 无效')
  }
  if (!Array.isArray(body.messages)) throw new Error('messages 必须是数组')
  const conversation = {
    channel: c.channel,
    accountId: requiredText(c.accountId, 'accountId'),
    sourceConversationId: requiredText(c.sourceConversationId, 'sourceConversationId'),
    title: nullableText(c.title, 'title'),
    kind,
    sourceMetadata: c.sourceMetadata == null ? null : c.sourceMetadata as Record<string, unknown>
  } as IngestBody['conversation']

  const ids = new Set<string>()
  const messages = (body.messages as unknown[]).map((raw, index): NativeChatMessage => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`messages[${index}] 必须是对象`)
    const m = raw as Record<string, unknown>
    const sourceMessageId = requiredText(m.sourceMessageId, `messages[${index}].sourceMessageId`)
    if (ids.has(sourceMessageId)) throw new Error(`批次中源消息 ID 重复：${sourceMessageId}`)
    ids.add(sourceMessageId)
    if (!MESSAGE_KINDS.has(String(m.kind))) throw new Error(`messages[${index}].kind 无效`)
    if (!DIRECTIONS.has(String(m.direction))) throw new Error(`messages[${index}].direction 无效`)
    const messageChannel = m.channel
    if (messageChannel !== conversation.channel || m.accountId !== conversation.accountId || m.sourceConversationId !== conversation.sourceConversationId) {
      throw new Error(`messages[${index}] 会话身份与本批 conversation 不一致`)
    }
    const sourceItemIndex = m.sourceItemIndex == null ? null : Number(m.sourceItemIndex)
    if (sourceItemIndex != null && (!Number.isSafeInteger(sourceItemIndex) || sourceItemIndex < 0)) {
      throw new Error(`messages[${index}].sourceItemIndex 必须是非负整数`)
    }
    const attachments = m.attachments == null ? [] : m.attachments
    if (!Array.isArray(attachments)) throw new Error(`messages[${index}].attachments 必须是数组`)
    const attachmentIds = new Set<string>()
    return {
      channel: conversation.channel,
      accountId: conversation.accountId,
      sourceConversationId: conversation.sourceConversationId,
      sourceMessageId,
      parentSourceMessageId: nullableText(m.parentSourceMessageId, `messages[${index}].parentSourceMessageId`),
      sourceItemIndex,
      direction: m.direction as NativeChatMessage['direction'],
      senderId: nullableText(m.senderId, `messages[${index}].senderId`),
      senderName: nullableText(m.senderName, `messages[${index}].senderName`),
      kind: m.kind as NativeChatMessage['kind'],
      sourceTypeCode: nullableText(m.sourceTypeCode, `messages[${index}].sourceTypeCode`),
      text: nullableText(m.text, `messages[${index}].text`),
      occurredAt: validDate(m.occurredAt, `messages[${index}].occurredAt`).toISOString(),
      observedAt: validDate(m.observedAt, `messages[${index}].observedAt`).toISOString(),
      sourceMetadata: m.sourceMetadata == null ? null : m.sourceMetadata as Record<string, unknown>,
      attachments: (attachments as unknown[]).map((attachment, attachmentIndex) => {
        if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
          throw new Error(`messages[${index}].attachments[${attachmentIndex}] 必须是对象`)
        }
        const a = attachment as Record<string, unknown>
        if (!ATTACHMENT_KINDS.has(String(a.kind))) throw new Error(`附件类型无效：messages[${index}].attachments[${attachmentIndex}]`)
        if (!ATTACHMENT_STATES.has(String(a.state))) throw new Error(`附件状态无效：messages[${index}].attachments[${attachmentIndex}]`)
        const byteSize = a.byteSize == null ? null : Number(a.byteSize)
        if (byteSize != null && (!Number.isSafeInteger(byteSize) || byteSize < 0)) throw new Error('附件大小必须是非负安全整数')
        const sourceAttachmentId = requiredText(a.sourceAttachmentId, 'sourceAttachmentId')
        if (attachmentIds.has(sourceAttachmentId)) throw new Error(`消息内附件 ID 重复：${sourceAttachmentId}`)
        attachmentIds.add(sourceAttachmentId)
        return {
          sourceAttachmentId,
          kind: a.kind as NativeChatAttachment['kind'],
          fileName: nullableText(a.fileName, 'fileName'),
          mimeType: nullableText(a.mimeType, 'mimeType'),
          byteSize,
          state: a.state as NativeChatAttachment['state'],
          sourceMetadata: a.sourceMetadata == null ? null : a.sourceMetadata as Record<string, unknown>
        }
      })
    }
  })
  return { conversation, messages }
}

export function registerNativeChatIngestRoutes(fastify: FastifyInstance, prisma: PrismaClient): void {
  fastify.post<{ Body: unknown }>('/api/v1/native-chat/ingest', async (request, reply) => {
    const requestStart = Date.now()
    if (!request.employee) return reply.status(401).send({ error: '未登录或缺少工号' })
    let batch: IngestBody
    try {
      batch = validateBody(request.body)
      jsonValue(batch.conversation.sourceMetadata, 'conversation.sourceMetadata')
      for (const message of batch.messages) jsonValue(message.sourceMetadata, 'message.sourceMetadata')
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '消息批次格式错误' })
    }

    const employeeId = request.employee.id
    const result = await prisma.$transaction(async (tx) => {
      const existingConversation = await tx.$queryRaw<Array<{
        id: number
        application_no: string | null
        application_candidate: string | null
        application_link_status: 'matched' | 'no_candidate' | 'unmatched' | 'ambiguous' | 'name_mismatch' | 'conflict'
      }>>`
        SELECT id, application_no, application_candidate, application_link_status
          FROM native_chat_conversations
         WHERE employee_id = ${employeeId}
           AND channel = ${batch.conversation.channel}
           AND account_id = ${batch.conversation.accountId}
           AND source_conversation_id = ${batch.conversation.sourceConversationId}
         FOR UPDATE
      `
      const previousLink = existingConversation[0]
      if (!previousLink) return null
      const effectiveLink = {
        applicationNo: previousLink.application_no,
        candidate: previousLink.application_candidate,
        status: previousLink.application_link_status
      }
      const messageLinks = await resolveNativeMessageBusinessLinks(tx, batch.messages, effectiveLink)
      const conversationId = previousLink.id
      await tx.$executeRaw`UPDATE native_chat_conversations SET last_observed_at = NOW() WHERE id = ${conversationId}`

      let inserted = 0
      let updated = 0
      let attachmentCount = 0
      const attachmentRefs: Array<{ messageSourceId: string; sourceAttachmentId: string; id: number }> = []
      for (const message of batch.messages) {
        const messageMetadata = jsonValue(message.sourceMetadata, 'message.sourceMetadata')
        const businessLink = messageLinks.get(message.sourceMessageId)
        if (!businessLink) throw new Error(`消息 ${message.sourceMessageId} 缺少业务关联解析结果`)
        const businessEvidence = JSON.stringify(businessLink.evidence)
        const occurredAt = new Date(message.occurredAt)
        const observedAt = new Date(message.observedAt)
        const rows = await tx.$queryRaw<Array<{ id: number; inserted: boolean }>>`
          INSERT INTO native_chat_messages (
            conversation_id, source_message_id, parent_source_message_id, source_item_index,
            direction, sender_id, sender_name, kind, source_type_code, text,
            occurred_at, observed_at, source_metadata, application_no, order_id,
            application_link_status, application_link_source, application_link_evidence, application_linked_at
          ) VALUES (
            ${conversationId}, ${message.sourceMessageId}, ${message.parentSourceMessageId ?? null},
            ${message.sourceItemIndex ?? null}, ${message.direction}, ${message.senderId ?? null},
            ${message.senderName ?? null}, ${message.kind}, ${message.sourceTypeCode ?? null},
            ${message.text ?? null}, ${occurredAt}, ${observedAt}, ${messageMetadata}::jsonb,
            ${businessLink.applicationNo}, ${businessLink.orderId}, ${businessLink.status},
            ${businessLink.source}, ${businessEvidence}::jsonb,
            ${businessLink.status === 'matched' ? new Date() : null}
          )
          ON CONFLICT (conversation_id, source_message_id)
          DO UPDATE SET parent_source_message_id = EXCLUDED.parent_source_message_id,
                        source_item_index = EXCLUDED.source_item_index,
                        direction = EXCLUDED.direction,
                        sender_id = EXCLUDED.sender_id,
                        sender_name = EXCLUDED.sender_name,
                        kind = EXCLUDED.kind,
                        source_type_code = EXCLUDED.source_type_code,
                        text = EXCLUDED.text,
                        occurred_at = EXCLUDED.occurred_at,
                        observed_at = GREATEST(native_chat_messages.observed_at, EXCLUDED.observed_at),
                        source_metadata = EXCLUDED.source_metadata,
                        application_no = CASE
                          WHEN native_chat_messages.application_link_source = 'manager_confirmation'
                          THEN native_chat_messages.application_no
                          WHEN EXCLUDED.application_link_status = 'conflict' THEN NULL
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_messages.application_link_status = 'matched'
                            AND (native_chat_messages.application_no IS DISTINCT FROM EXCLUDED.application_no
                              OR (native_chat_messages.order_id IS NOT NULL AND EXCLUDED.order_id IS NOT NULL
                                  AND native_chat_messages.order_id <> EXCLUDED.order_id))
                          THEN NULL
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_messages.application_link_status IN ('unmatched', 'no_candidate', 'ambiguous', 'name_mismatch')
                          THEN EXCLUDED.application_no
                          ELSE native_chat_messages.application_no END,
                        order_id = CASE
                          WHEN native_chat_messages.application_link_source = 'manager_confirmation'
                          THEN native_chat_messages.order_id
                          WHEN EXCLUDED.application_link_status = 'conflict' THEN NULL
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_messages.application_link_status = 'matched'
                            AND (native_chat_messages.application_no IS DISTINCT FROM EXCLUDED.application_no
                              OR (native_chat_messages.order_id IS NOT NULL AND EXCLUDED.order_id IS NOT NULL
                                  AND native_chat_messages.order_id <> EXCLUDED.order_id))
                          THEN NULL
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_messages.application_link_status = 'matched'
                            AND native_chat_messages.application_no = EXCLUDED.application_no
                            AND native_chat_messages.order_id IS NULL AND EXCLUDED.order_id IS NOT NULL
                          THEN EXCLUDED.order_id
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_messages.application_link_status IN ('unmatched', 'no_candidate', 'ambiguous', 'name_mismatch')
                          THEN EXCLUDED.order_id
                          ELSE native_chat_messages.order_id END,
                        application_link_status = CASE
                          WHEN native_chat_messages.application_link_source = 'manager_confirmation'
                          THEN native_chat_messages.application_link_status
                          WHEN EXCLUDED.application_link_status = 'conflict' THEN 'conflict'
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_messages.application_link_status = 'matched'
                            AND (native_chat_messages.application_no IS DISTINCT FROM EXCLUDED.application_no
                              OR (native_chat_messages.order_id IS NOT NULL AND EXCLUDED.order_id IS NOT NULL
                                  AND native_chat_messages.order_id <> EXCLUDED.order_id))
                          THEN 'conflict'
                          WHEN native_chat_messages.application_link_status = 'conflict' THEN 'conflict'
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_messages.application_link_status IN ('unmatched', 'no_candidate', 'ambiguous', 'name_mismatch')
                          THEN 'matched'
                          ELSE native_chat_messages.application_link_status END,
                        application_link_source = CASE
                          WHEN native_chat_messages.application_link_source = 'manager_confirmation'
                          THEN native_chat_messages.application_link_source
                          WHEN EXCLUDED.application_link_status = 'conflict' THEN EXCLUDED.application_link_source
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_messages.application_link_status = 'matched'
                            AND native_chat_messages.application_no = EXCLUDED.application_no
                            AND native_chat_messages.order_id IS NULL AND EXCLUDED.order_id IS NOT NULL
                          THEN EXCLUDED.application_link_source
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_messages.application_link_status IN ('unmatched', 'no_candidate', 'ambiguous', 'name_mismatch')
                          THEN EXCLUDED.application_link_source ELSE native_chat_messages.application_link_source END,
                        application_link_evidence = CASE
                          WHEN native_chat_messages.application_link_source = 'manager_confirmation'
                          THEN native_chat_messages.application_link_evidence
                          WHEN EXCLUDED.application_link_status = 'conflict'
                          THEN jsonb_build_object('existing', native_chat_messages.application_link_evidence,
                                                  'incoming', EXCLUDED.application_link_evidence)
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_messages.application_link_status = 'matched'
                            AND (native_chat_messages.application_no IS DISTINCT FROM EXCLUDED.application_no
                              OR (native_chat_messages.order_id IS NOT NULL AND EXCLUDED.order_id IS NOT NULL
                                  AND native_chat_messages.order_id <> EXCLUDED.order_id))
                          THEN jsonb_build_object('existing', native_chat_messages.application_link_evidence,
                                                  'incoming', EXCLUDED.application_link_evidence)
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_messages.application_link_status = 'matched'
                            AND native_chat_messages.application_no = EXCLUDED.application_no
                            AND native_chat_messages.order_id IS NULL AND EXCLUDED.order_id IS NOT NULL
                          THEN EXCLUDED.application_link_evidence
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_messages.application_link_status IN ('unmatched', 'no_candidate', 'ambiguous', 'name_mismatch')
                          THEN EXCLUDED.application_link_evidence ELSE native_chat_messages.application_link_evidence END,
                        application_linked_at = CASE
                          WHEN native_chat_messages.application_link_source = 'manager_confirmation'
                          THEN native_chat_messages.application_linked_at
                          WHEN EXCLUDED.application_link_status = 'conflict' THEN NOW()
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_messages.application_link_status = 'matched'
                            AND native_chat_messages.application_no = EXCLUDED.application_no
                            AND native_chat_messages.order_id IS NULL AND EXCLUDED.order_id IS NOT NULL
                          THEN NOW()
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_messages.application_link_status IN ('unmatched', 'no_candidate', 'ambiguous', 'name_mismatch')
                          THEN NOW()
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_messages.application_link_status = 'matched'
                            AND (native_chat_messages.application_no IS DISTINCT FROM EXCLUDED.application_no
                              OR (native_chat_messages.order_id IS NOT NULL AND EXCLUDED.order_id IS NOT NULL
                                  AND native_chat_messages.order_id <> EXCLUDED.order_id))
                          THEN NOW() ELSE native_chat_messages.application_linked_at END
          RETURNING id, (xmax = 0) AS inserted
        `
        const row = rows[0]
        if (!row) throw new Error(`源消息写入后未返回记录：${message.sourceMessageId}`)
        if (row.inserted) inserted++
        else updated++

        // Only newly sent messages after the feature's installation are queued.
        // Matching runs independently after the message transaction commits.
        if (row.inserted && message.text) {
          let eligible = false
          try { eligible = isEscortSummaryEligibleText(message.text) }
          catch (error) {
            request.log.error({ event: 'escort_summary_text_error', messageId: row.id, error: error instanceof Error ? error.message : String(error) }, '陪诊小结文字无法解析，请核查原消息')
          }
          if (eligible) {
            await tx.$executeRaw`
              INSERT INTO escort_summary_jobs (message_id)
              SELECT ${row.id} FROM escort_summary_settings
               WHERE id = 1 AND ${occurredAt}::timestamp >= enabled_since
              ON CONFLICT (message_id) DO NOTHING
            `
          }
        }

        for (const attachment of message.attachments ?? []) {
          const attachmentId = attachment.sourceAttachmentId
          const attachmentMetadata = jsonValue(attachment.sourceMetadata, 'attachment.sourceMetadata')
          const attachmentRows = await tx.$queryRaw<Array<{ id: number }>>`
            INSERT INTO native_chat_attachments (
              message_id, source_attachment_id, kind, file_name, mime_type, byte_size,
              content_hash, state, source_metadata, created_at, updated_at
            ) VALUES (
              ${row.id}, ${attachmentId}, ${attachment.kind}, ${attachment.fileName ?? null},
              ${attachment.mimeType ?? null}, ${attachment.byteSize == null ? null : BigInt(attachment.byteSize)},
              NULL, ${attachment.state}, ${attachmentMetadata}::jsonb, NOW(), NOW()
            )
            ON CONFLICT (message_id, source_attachment_id)
            DO UPDATE SET kind = EXCLUDED.kind,
                          file_name = EXCLUDED.file_name,
                          mime_type = EXCLUDED.mime_type,
                          byte_size = EXCLUDED.byte_size,
                          content_hash = CASE
                            WHEN native_chat_attachments.source_metadata->>'content_hash' IS NOT NULL
                             AND EXCLUDED.source_metadata->>'content_hash' IS NOT NULL
                             AND native_chat_attachments.source_metadata->>'content_hash' <> EXCLUDED.source_metadata->>'content_hash'
                            THEN NULL ELSE native_chat_attachments.content_hash END,
                          state = CASE WHEN native_chat_attachments.storage_key IS NOT NULL
                                         AND native_chat_attachments.source_metadata->>'content_hash' IS NOT NULL
                                         AND EXCLUDED.source_metadata->>'content_hash' IS NOT NULL
                                         AND native_chat_attachments.source_metadata->>'content_hash' <> EXCLUDED.source_metadata->>'content_hash'
                                       THEN EXCLUDED.state
                                       WHEN native_chat_attachments.storage_key IS NOT NULL
                                       THEN 'available' ELSE EXCLUDED.state END,
                          storage_key = CASE
                            WHEN native_chat_attachments.source_metadata->>'content_hash' IS NOT NULL
                             AND EXCLUDED.source_metadata->>'content_hash' IS NOT NULL
                             AND native_chat_attachments.source_metadata->>'content_hash' <> EXCLUDED.source_metadata->>'content_hash'
                            THEN NULL ELSE native_chat_attachments.storage_key END,
                          source_metadata = CASE
                            WHEN EXCLUDED.source_metadata IS NULL
                            THEN native_chat_attachments.source_metadata
                            WHEN native_chat_attachments.source_metadata->>'content_hash' IS NOT NULL
                             AND EXCLUDED.source_metadata->>'content_hash' IS NOT NULL
                             AND native_chat_attachments.source_metadata->>'content_hash' <> EXCLUDED.source_metadata->>'content_hash'
                            THEN COALESCE(EXCLUDED.source_metadata, '{}'::jsonb) - 'imageAnalysis'
                            ELSE
                              jsonb_set(
                                COALESCE(EXCLUDED.source_metadata, '{}'::jsonb),
                                '{content_hash}',
                                COALESCE(EXCLUDED.source_metadata->'content_hash', native_chat_attachments.source_metadata->'content_hash', 'null'::jsonb),
                                true
                              ) || CASE
                                WHEN EXCLUDED.source_metadata->'imageAnalysis' IS NULL
                                 AND native_chat_attachments.source_metadata->'imageAnalysis' IS NOT NULL
                                THEN jsonb_build_object('imageAnalysis', native_chat_attachments.source_metadata->'imageAnalysis')
                                ELSE '{}'::jsonb
                              END
                          END,
                          updated_at = CASE
                            WHEN native_chat_attachments.kind IS DISTINCT FROM EXCLUDED.kind
                              OR native_chat_attachments.file_name IS DISTINCT FROM EXCLUDED.file_name
                              OR native_chat_attachments.mime_type IS DISTINCT FROM EXCLUDED.mime_type
                              OR native_chat_attachments.byte_size IS DISTINCT FROM EXCLUDED.byte_size
                              OR (native_chat_attachments.storage_key IS NULL
                                  AND native_chat_attachments.state IS DISTINCT FROM EXCLUDED.state)
                              OR (EXCLUDED.source_metadata->>'content_hash' IS NOT NULL
                                  AND native_chat_attachments.source_metadata IS DISTINCT FROM EXCLUDED.source_metadata)
                              OR (EXCLUDED.source_metadata->>'content_hash' IS NULL
                                  AND (native_chat_attachments.source_metadata - 'content_hash')
                                      IS DISTINCT FROM (EXCLUDED.source_metadata - 'content_hash'))
                            THEN NOW() ELSE native_chat_attachments.updated_at END
            RETURNING id
          `
          const attachmentRow = attachmentRows[0]
          if (!attachmentRow) throw new Error(`附件写入后未返回记录：${attachmentId}`)
          attachmentRefs.push({ messageSourceId: message.sourceMessageId, sourceAttachmentId: attachmentId, id: attachmentRow.id })
          attachmentCount++
        }
      }
      return { conversationId, inserted, updated, attachmentCount, attachmentRefs, messageLinks: [...messageLinks.values()] }
    })

    if (!result) return reply.status(409).send({
      error: '会话目录尚未登记，请先同步会话目录',
      code: 'conversation_not_registered',
      conversationId: batch.conversation.sourceConversationId
    })
    const linkCounts = result.messageLinks.reduce((counts, link) => {
      counts[link.status] = (counts[link.status] ?? 0) + 1
      if (link.source) counts[link.source] = (counts[link.source] ?? 0) + 1
      return counts
    }, {} as Record<string, number>)
    request.log.info({
      event: 'native_chat_ingest_completed',
      employeeId,
      requestId: request.id,
      channel: batch.conversation.channel,
      accountId: batch.conversation.accountId,
      sourceConversationId: batch.conversation.sourceConversationId,
      receivedMessageCount: batch.messages.length,
      insertedMessageCount: result.inserted,
      updatedMessageCount: result.updated,
      receivedAttachmentCount: result.attachmentCount,
      ...Object.fromEntries(Object.entries(linkCounts).map(([key, value]) => [`messageLink_${key}`, value])),
      elapsedMs: Date.now() - requestStart
    })
    const { messageLinks: _messageLinks, ...response } = result
    return reply.send({ data: { ...response, acknowledged: true } })
  })
}
