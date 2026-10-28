import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { Client } from 'minio'
import { removeNativeChatWxgfPreview } from '../services/nativeChatWxgfPreview.js'
import { notifyNativeChatImageReady } from '../services/nativeChatImageAnalysis.js'

const BUCKET = 'materials'

async function readAttachment(prisma: PrismaClient, attachmentId: number, employeeId: number) {
  const rows = await prisma.$queryRaw<Array<{
    id: number
    employee_id: number
    message_id: number
    conversation_id: number
    storage_key: string | null
    source_metadata: unknown
    application_no: string | null
    application_link_status: string
  }>>`
    SELECT a.id, c.employee_id, a.storage_key
         , a.message_id, c.id AS conversation_id, a.source_metadata, c.application_no, c.application_link_status
      FROM native_chat_attachments a
      JOIN native_chat_messages m ON m.id = a.message_id
      JOIN native_chat_conversations c ON c.id = m.conversation_id
     WHERE a.id = ${attachmentId}
  `
  const row = rows[0]
  if (!row || row.employee_id !== employeeId) return null
  return row
}

export function registerNativeChatAttachmentRoutes(
  fastify: FastifyInstance,
  prisma: PrismaClient,
  minioClient: Client,
  minioPublicClient: Client
): void {
  fastify.post<{ Params: { id: string }; Body: { replace?: boolean } }>(
    '/api/v1/native-chat/attachments/:id/upload-url',
    async (request, reply) => {
      if (!request.employee) return reply.status(401).send({ error: '未登录或缺少工号' })
      const id = Number(request.params.id)
      if (!Number.isSafeInteger(id) || id <= 0) return reply.status(400).send({ error: '附件 ID 无效' })
      const attachment = await readAttachment(prisma, id, request.employee.id)
      if (!attachment) return reply.status(404).send({ error: '附件不存在' })
      const replace = request.body?.replace === true
      if (attachment.storage_key && !replace) return reply.send({ data: { uploaded: true, storageKey: attachment.storage_key } })
      const storageKey = `native-chat/${request.employee.id}/${id}`
      const url = await minioPublicClient.presignedPutObject(BUCKET, storageKey, 600)
      return reply.send({ data: { uploaded: false, storageKey, url } })
    }
  )

  fastify.post<{ Params: { id: string }; Body: { storageKey?: string; replace?: boolean } }>(
    '/api/v1/native-chat/attachments/:id/complete',
    async (request, reply) => {
      if (!request.employee) return reply.status(401).send({ error: '未登录或缺少工号' })
      const id = Number(request.params.id)
      if (!Number.isSafeInteger(id) || id <= 0) return reply.status(400).send({ error: '附件 ID 无效' })
      const attachment = await readAttachment(prisma, id, request.employee.id)
      if (!attachment) return reply.status(404).send({ error: '附件不存在' })
      const replace = request.body?.replace === true
      if (attachment.storage_key && !replace) return reply.send({ data: { uploaded: true, storageKey: attachment.storage_key } })
      const expectedKey = `native-chat/${request.employee.id}/${id}`
      if (request.body?.storageKey !== expectedKey) return reply.status(400).send({ error: '附件存储标识无效' })

      await minioClient.statObject(BUCKET, expectedKey)
      if (replace) await removeNativeChatWxgfPreview(minioClient, id)
      await prisma.$executeRaw`
        UPDATE native_chat_attachments
           SET storage_key = ${expectedKey}, state = 'available',
               source_metadata = CASE WHEN ${replace}
                 THEN COALESCE(source_metadata, '{}'::jsonb) - 'imageAnalysis'
                 ELSE source_metadata END,
               updated_at = NOW()
         WHERE id = ${id}
      `
      notifyNativeChatImageReady(prisma, minioClient, id)
      return reply.send({ data: { uploaded: true, storageKey: expectedKey } })
    }
  )

  fastify.get('/api/v1/native-chat/pending-image-matches', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录或缺少工号' })
    const rows = await prisma.$queryRaw<Array<{
      id: number
      message_id: number
      file_name: string | null
      storage_key: string
      source_metadata: unknown
      occurred_at: Date
      application_no: string | null
      channel: string
      sender_name: string | null
    }>>`
      SELECT a.id, a.message_id, a.file_name, a.storage_key, a.source_metadata,
             m.occurred_at, c.application_no, c.channel, m.sender_name
        FROM native_chat_attachments a
        JOIN native_chat_messages m ON m.id = a.message_id
        JOIN native_chat_conversations c ON c.id = m.conversation_id
       WHERE c.employee_id = ${request.employee.id}
         AND a.kind = 'image'
         AND a.storage_key IS NOT NULL
         AND a.source_metadata->'imageAnalysis'->>'imageType' = '挂号凭证'
         AND a.source_metadata->'imageAnalysis'->'registrationMatch'->>'status' = 'completed'
         AND a.source_metadata->'imageAnalysis'->'registrationMatch'->'managerResolution' IS NULL
         AND (
           a.source_metadata->'imageAnalysis'->'registrationMatch'->>'applicationDecision' <> 'matched'
           OR a.source_metadata->'imageAnalysis'->'registrationMatch'->>'orderDecision' <> 'matched'
         )
       ORDER BY m.occurred_at, a.id
    `
    const items = await Promise.all(rows.map(async (row) => {
      const source = row.source_metadata && typeof row.source_metadata === 'object' && !Array.isArray(row.source_metadata)
        ? row.source_metadata as Record<string, unknown>
        : {}
      const analysis = source.imageAnalysis && typeof source.imageAnalysis === 'object' && !Array.isArray(source.imageAnalysis)
        ? source.imageAnalysis as Record<string, unknown>
        : {}
      const match = analysis.registrationMatch && typeof analysis.registrationMatch === 'object' && !Array.isArray(analysis.registrationMatch)
        ? analysis.registrationMatch as Record<string, unknown>
        : {}
      return {
        attachmentId: row.id,
        messageId: row.message_id,
        fileName: row.file_name,
        imageUrl: await minioPublicClient.presignedGetObject(BUCKET, row.storage_key, 3600),
        occurredAt: row.occurred_at,
        channel: row.channel,
        senderName: row.sender_name,
        applicationNo: row.application_no,
        description: typeof analysis.description === 'string' ? analysis.description : '',
        candidateApplications: Array.isArray(match.candidateApplications) ? match.candidateApplications : [],
        applicationDecision: match.applicationDecision,
        orderDecision: match.orderDecision,
        reason: typeof match.reason === 'string' ? match.reason : ''
      }
    }))
    return reply.send({ data: items })
  })

  fastify.post<{
    Params: { id: string }
    Body: { applicationNo?: string; orderId?: number | null }
  }>('/api/v1/native-chat/attachments/:id/resolve-image-match', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录或缺少工号' })
    const id = Number(request.params.id)
    const applicationNo = typeof request.body?.applicationNo === 'string' ? request.body.applicationNo.trim() : ''
    const orderId = request.body?.orderId == null ? null : Number(request.body.orderId)
    if (!Number.isSafeInteger(id) || id <= 0 || !applicationNo) return reply.status(400).send({ error: '图片或申领号无效' })
    if (orderId !== null && (!Number.isSafeInteger(orderId) || orderId <= 0)) return reply.status(400).send({ error: '订单 ID 无效' })
    const attachment = await readAttachment(prisma, id, request.employee.id)
    if (!attachment || !attachment.storage_key) return reply.status(404).send({ error: '图片附件不存在' })
    const source = attachment.source_metadata && typeof attachment.source_metadata === 'object' && !Array.isArray(attachment.source_metadata)
      ? attachment.source_metadata as Record<string, unknown>
      : {}
    const analysis = source.imageAnalysis && typeof source.imageAnalysis === 'object' && !Array.isArray(source.imageAnalysis)
      ? source.imageAnalysis as Record<string, unknown>
      : {}
    const match = analysis.registrationMatch && typeof analysis.registrationMatch === 'object' && !Array.isArray(analysis.registrationMatch)
      ? analysis.registrationMatch as Record<string, unknown>
      : {}
    const candidates = Array.isArray(match.candidateApplications) ? match.candidateApplications as Array<Record<string, unknown>> : []
    const selected = candidates.find((candidate) => candidate.applicationNo === applicationNo)
    if (!selected) return reply.status(400).send({ error: '申领号不在本次识别候选中' })
    const candidateOrders = Array.isArray(selected.orders) ? selected.orders as Array<Record<string, unknown>> : []
    if (orderId !== null && !candidateOrders.some((candidate) => Number(candidate.orderId) === orderId)) {
      return reply.status(400).send({ error: '订单不属于所选申领号' })
    }
    if (attachment.application_no && attachment.application_no !== applicationNo) {
      return reply.status(409).send({ error: '图片所在会话已关联到另一个申领号' })
    }
    await prisma.$transaction(async (tx) => {
      if (!attachment.application_no) {
        const changed = await tx.$executeRaw`
          UPDATE native_chat_conversations
             SET application_no = ${applicationNo}, application_link_status = 'matched', application_linked_at = NOW()
           WHERE id = ${attachment.conversation_id} AND application_no IS NULL
        `
        if (changed !== 1) {
          const latest = await tx.$queryRaw<Array<{ application_no: string | null }>>`
            SELECT application_no FROM native_chat_conversations WHERE id = ${attachment.conversation_id}
          `
          if (latest[0]?.application_no !== applicationNo) {
            throw new Error('会话申领号已被其他操作更新，请刷新后重新确认')
          }
        }
      }
      const resolution = {
        status: 'manager_confirmed',
        applicationNo,
        orderId,
        confirmedByEmployeeId: request.employee!.id,
        confirmedAt: new Date().toISOString()
      }
      await tx.$executeRaw`
        UPDATE native_chat_attachments
           SET source_metadata = jsonb_set(
             COALESCE(source_metadata, '{}'::jsonb),
             '{imageAnalysis,registrationMatch,managerResolution}',
             ${JSON.stringify(resolution)}::jsonb,
             true
           ),
           updated_at = NOW()
         WHERE id = ${id}
      `
    })
    return reply.send({ data: { attachmentId: id, applicationNo, orderId, confirmed: true } })
  })
}
