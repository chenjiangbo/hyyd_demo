import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { resolveNativeChatApplicationLink } from '../services/nativeChatApplicationLink.js'

type DiscoveredSession = {
  channel: 'wechat' | 'wxwork'
  accountId: string
  sourceConversationId: string
  title: string | null
  kind: 'group' | 'single' | 'service' | 'unknown'
  sourceMetadata?: Record<string, unknown> | null
}

function parseSessions(input: unknown): DiscoveredSession[] {
  if (!Array.isArray(input)) throw new Error('sessions 必须是数组')
  return input.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`sessions[${index}] 必须是对象`)
    const s = raw as Record<string, unknown>
    if (s.channel !== 'wechat' && s.channel !== 'wxwork') throw new Error(`sessions[${index}].channel 无效`)
    if (!['group', 'single', 'service', 'unknown'].includes(String(s.kind))) throw new Error(`sessions[${index}].kind 无效`)
    const accountId = typeof s.accountId === 'string' ? s.accountId.trim() : ''
    const sourceConversationId = typeof s.sourceConversationId === 'string' ? s.sourceConversationId.trim() : ''
    if (!accountId || !sourceConversationId) throw new Error(`sessions[${index}] 缺少账号或会话标识`)
    if (s.title != null && typeof s.title !== 'string') throw new Error(`sessions[${index}].title 必须是字符串或 null`)
    const metadata = s.sourceMetadata == null ? null : s.sourceMetadata
    if (metadata != null && (typeof metadata !== 'object' || Array.isArray(metadata))) throw new Error(`sessions[${index}].sourceMetadata 必须是对象`)
    return {
      channel: s.channel,
      accountId,
      sourceConversationId,
      title: s.title as string | null,
      kind: s.kind as DiscoveredSession['kind'],
      sourceMetadata: metadata as Record<string, unknown> | null
    }
  })
}

export function registerNativeChatDiscoveryRoutes(fastify: FastifyInstance, prisma: PrismaClient): void {
  fastify.post<{ Body: { sessions?: unknown } }>('/api/v1/native-chat/discovery', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录或缺少工号' })
    let sessions: DiscoveredSession[]
    try {
      sessions = parseSessions(request.body?.sessions)
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '会话目录格式错误' })
    }
    const employeeId = request.employee.id
    const observedAt = new Date()
    const linkedSessions: Array<{
      session: DiscoveredSession
      link: Awaited<ReturnType<typeof resolveNativeChatApplicationLink>>
    }> = []
    for (const session of sessions) {
      linkedSessions.push({ session, link: await resolveNativeChatApplicationLink(prisma, employeeId, session.title) })
    }
    await prisma.$transaction(async (tx) => {
      for (const { session, link } of linkedSessions) {
        await tx.$queryRaw<Array<{ id: number }>>`
          INSERT INTO native_chat_conversations (
            employee_id, channel, account_id, source_conversation_id, title,
            conversation_kind, application_no, application_candidate, application_link_status,
            source_metadata, first_observed_at, last_observed_at
          ) VALUES (
            ${employeeId}, ${session.channel}, ${session.accountId}, ${session.sourceConversationId},
            ${session.title}, ${session.kind}, ${link.applicationNo}, ${link.candidate}, ${link.status},
            ${session.sourceMetadata == null ? null : JSON.stringify(session.sourceMetadata)}::jsonb,
            NOW(), NOW()
          )
          ON CONFLICT (employee_id, channel, account_id, source_conversation_id)
          DO UPDATE SET title = EXCLUDED.title,
                        conversation_kind = EXCLUDED.conversation_kind,
                        application_no = EXCLUDED.application_no,
                        application_candidate = EXCLUDED.application_candidate,
                        application_link_status = EXCLUDED.application_link_status,
                        application_linked_at = CASE
                          WHEN EXCLUDED.application_no IS DISTINCT FROM native_chat_conversations.application_no
                            OR EXCLUDED.application_link_status IS DISTINCT FROM native_chat_conversations.application_link_status
                          THEN NOW() ELSE native_chat_conversations.application_linked_at END,
                        source_metadata = EXCLUDED.source_metadata,
                        last_observed_at = NOW()
          RETURNING id
        `
      }
    })
    return reply.send({ data: { discovered: sessions.length } })
  })
}
