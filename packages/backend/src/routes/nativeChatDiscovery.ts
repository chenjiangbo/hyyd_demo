import type { FastifyInstance } from 'fastify'
import { Prisma, type PrismaClient } from '@prisma/client'
import { loadNativeChatOrderSnapshot, resolveNativeChatApplicationLinks, type NativeChatOrderSnapshot } from '../services/nativeChatApplicationLink.js'

const syncSnapshots = new Map<string, { snapshot: Promise<NativeChatOrderSnapshot> | null; lastAccess: number }>()
const SNAPSHOT_IDLE_MS = 60 * 60_000

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
  fastify.post<{ Body: { sessions?: unknown; syncId?: unknown; startSnapshot?: unknown; lastBatch?: unknown } }>('/api/v1/native-chat/discovery', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录或缺少工号' })
    const requestStartedAt = Date.now()
    const employeeId = request.employee.id
    const syncId = request.body?.syncId
    if (syncId !== undefined && (typeof syncId !== 'string' || !/^[a-f0-9-]{36}$/i.test(syncId))) {
      return reply.status(400).send({ error: '目录同步标识无效' })
    }
    const snapshotKey = typeof syncId === 'string' ? `${employeeId}:${syncId}` : null
    const now = Date.now()
    for (const [key, entry] of syncSnapshots) if (now - entry.lastAccess > SNAPSHOT_IDLE_MS) syncSnapshots.delete(key)
    let snapshot = snapshotKey ? syncSnapshots.get(snapshotKey) : undefined
    if (snapshotKey && !snapshot) {
      if (request.body?.startSnapshot !== true) return reply.status(409).send({ error: '本轮会话目录匹配数据已失效，请重新开始未完成的批次', code: 'discovery_snapshot_expired' })
      // Delay the database read until a title actually contains a candidate.
      snapshot = { snapshot: null, lastAccess: now }
      syncSnapshots.set(snapshotKey, snapshot)
    }
    if (snapshot) snapshot.lastAccess = now
    const getSnapshot = snapshot ? () => {
      if (!snapshot!.snapshot) {
        snapshot!.snapshot = loadNativeChatOrderSnapshot(prisma).catch((error) => {
          if (snapshotKey) syncSnapshots.delete(snapshotKey)
          throw error
        })
      }
      return snapshot!.snapshot
    } : undefined
    const rawSessionCount = Array.isArray(request.body?.sessions) ? request.body.sessions.length : null
    let sessions: DiscoveredSession[]
    try {
      sessions = parseSessions(request.body?.sessions)
    } catch (error) {
      request.log.warn({
        event: 'native_chat_discovery_rejected',
        employeeId,
        requestSessionCount: rawSessionCount,
        elapsedMs: Date.now() - requestStartedAt,
        error: error instanceof Error ? error.message : String(error)
      })
      return reply.status(400).send({ error: error instanceof Error ? error.message : '会话目录格式错误' })
    }
    const channelCounts = sessions.reduce<Record<string, number>>((counts, session) => {
      counts[session.channel] = (counts[session.channel] ?? 0) + 1
      return counts
    }, {})
    const accountCount = new Set(sessions.map((session) => `${session.channel}\u0000${session.accountId}`)).size
    request.log.info({
      event: 'native_chat_discovery_started',
      employeeId,
      requestId: request.id,
      submittedSessionCount: sessions.length,
      channelCounts,
      accountCount
    })
    const orderedSessions = [...sessions].sort((a, b) => {
      const aKey = `${a.channel}\u0000${a.accountId}\u0000${a.sourceConversationId}`
      const bKey = `${b.channel}\u0000${b.accountId}\u0000${b.sourceConversationId}`
      return aKey.localeCompare(bKey)
    })
    let stage = 'application_link_resolution'
    let activeBatchNumber: number | null = null
    let completedBatchCount = 0
    const linkStartedAt = Date.now()
    try {
      request.log.info({
        event: 'native_chat_discovery_stage_started',
        employeeId,
        requestId: request.id,
        stage,
        submittedSessionCount: sessions.length
      })
      const links = await resolveNativeChatApplicationLinks(
        prisma,
        employeeId,
        orderedSessions.map((session) => session.title),
        (linkStage, details) => request.log.info({
          event: 'native_chat_discovery_link_progress',
          employeeId,
          requestId: request.id,
          stage: linkStage,
          ...details
        }),
        getSnapshot
      )
      const linkElapsedMs = Date.now() - linkStartedAt
      const linkStatusCounts = links.reduce<Record<string, number>>((counts, link) => {
        counts[link.status] = (counts[link.status] ?? 0) + 1
        return counts
      }, {})
      request.log.info({
        event: 'native_chat_discovery_stage_completed',
        employeeId,
        requestId: request.id,
        stage,
        elapsedMs: linkElapsedMs,
        resolvedLinkCount: links.length,
        linkStatusCounts
      })

      stage = 'database_persist'
      let persistedSessionCount = 0
      await prisma.$transaction(async (tx) => {
        for (let offset = 0; offset < orderedSessions.length; offset += 200) {
          const batchNumber = Math.floor(offset / 200) + 1
          const values = orderedSessions.slice(offset, offset + 200).map((session, batchIndex) => {
            const link = links[offset + batchIndex]
            if (!link) throw new Error(`会话 ${session.sourceConversationId} 缺少业务关联解析结果`)
            return Prisma.sql`(
            ${employeeId}, ${session.channel}, ${session.accountId}, ${session.sourceConversationId},
            ${session.title}, ${session.kind}, ${link.applicationNo}, ${link.candidate}, ${link.status},
            ${session.sourceMetadata == null ? null : JSON.stringify(session.sourceMetadata)}::jsonb,
            NOW(), NOW()
          )`
          })
          if (values.length === 0) continue
          activeBatchNumber = batchNumber
          const batchStartedAt = Date.now()
          request.log.info({
            event: 'native_chat_discovery_batch_started',
            employeeId,
            requestId: request.id,
            batchNumber,
            batchCount: Math.ceil(orderedSessions.length / 200),
            batchSessionCount: values.length,
            persistedSessionCount
          })
          const persistedRows = await tx.$queryRaw<Array<{ id: number; channel: string; account_id: string; source_conversation_id: string; application_no: string | null; application_link_status: string }>>(Prisma.sql`
          INSERT INTO native_chat_conversations (
            employee_id, channel, account_id, source_conversation_id, title,
            conversation_kind, application_no, application_candidate, application_link_status,
            source_metadata, first_observed_at, last_observed_at
          ) VALUES ${Prisma.join(values)}
          ON CONFLICT (employee_id, channel, account_id, source_conversation_id)
          DO UPDATE SET title = EXCLUDED.title,
                        conversation_kind = EXCLUDED.conversation_kind,
                        application_no = CASE
                          WHEN native_chat_conversations.title IS DISTINCT FROM EXCLUDED.title THEN EXCLUDED.application_no
                          WHEN EXCLUDED.application_link_status = 'conflict' THEN NULL
                          WHEN native_chat_conversations.application_link_status = 'conflict' THEN NULL
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_conversations.application_no IS NOT NULL
                            AND native_chat_conversations.application_no <> EXCLUDED.application_no THEN NULL
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_conversations.application_no IS NULL THEN EXCLUDED.application_no
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_conversations.application_no = EXCLUDED.application_no THEN EXCLUDED.application_no
                          ELSE native_chat_conversations.application_no END,
                        application_candidate = CASE
                          WHEN native_chat_conversations.title IS DISTINCT FROM EXCLUDED.title THEN EXCLUDED.application_candidate
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_conversations.application_no IS NOT NULL
                            AND native_chat_conversations.application_no <> EXCLUDED.application_no
                          THEN native_chat_conversations.application_candidate
                          WHEN EXCLUDED.application_link_status = 'matched' OR native_chat_conversations.application_no IS NULL
                          THEN EXCLUDED.application_candidate
                          ELSE native_chat_conversations.application_candidate END,
                        application_link_status = CASE
                          WHEN native_chat_conversations.title IS DISTINCT FROM EXCLUDED.title THEN EXCLUDED.application_link_status
                          WHEN EXCLUDED.application_link_status = 'conflict' THEN 'conflict'
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_conversations.application_no IS NOT NULL
                            AND native_chat_conversations.application_no <> EXCLUDED.application_no THEN 'conflict'
                          WHEN native_chat_conversations.application_link_status = 'conflict' THEN 'conflict'
                          WHEN EXCLUDED.application_link_status = 'matched' THEN 'matched'
                          WHEN native_chat_conversations.application_link_status = 'matched' THEN 'matched'
                          ELSE EXCLUDED.application_link_status END,
                        application_linked_at = CASE
                          WHEN native_chat_conversations.title IS DISTINCT FROM EXCLUDED.title THEN NOW()
                          WHEN EXCLUDED.application_link_status = 'conflict' THEN NOW()
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND native_chat_conversations.application_no IS NOT NULL
                            AND native_chat_conversations.application_no <> EXCLUDED.application_no THEN NOW()
                          WHEN EXCLUDED.application_link_status = 'matched'
                            AND (native_chat_conversations.application_no IS NULL
                              OR native_chat_conversations.application_no <> EXCLUDED.application_no
                              OR native_chat_conversations.application_link_status <> 'matched')
                          THEN NOW() ELSE native_chat_conversations.application_linked_at END,
                        source_metadata = EXCLUDED.source_metadata,
                        last_observed_at = NOW()
          RETURNING id, channel, account_id, source_conversation_id, application_no, application_link_status
        `)
          if (persistedRows.length !== values.length) {
            throw new Error(`会话目录批次入库数不匹配：提交 ${values.length}，确认 ${persistedRows.length}`)
          }
          persistedSessionCount += persistedRows.length
          const batchLinks = new Map(orderedSessions.slice(offset, offset + 200).map((session, index) => [
            JSON.stringify([session.channel, session.accountId, session.sourceConversationId]), links[offset + index]
          ]))
          const linkedConversationValues = persistedRows.flatMap((row) => {
            const link = batchLinks.get(JSON.stringify([row.channel, row.account_id, row.source_conversation_id]))
            if (!link) throw new Error(`会话 ${row.source_conversation_id} 缺少业务关联解析结果`)
            return row.application_link_status === 'matched' && row.application_no
              ? [Prisma.sql`(${row.id}, ${row.application_no}, ${link.candidate}::text)`]
              : []
          })
          const backfilledMessageCount = linkedConversationValues.length > 0
            ? await tx.$executeRaw(Prisma.sql`
              UPDATE native_chat_messages AS m
                 SET application_no = matched.application_no,
                     application_link_status = 'matched',
                     application_link_source = 'conversation_title',
                     application_link_evidence = jsonb_build_object(
                       'titleCandidate', matched.candidate,
                       'previousEvidence', m.application_link_evidence
                     ),
                     application_linked_at = NOW()
                FROM (VALUES ${Prisma.join(linkedConversationValues)}) AS matched(conversation_id, application_no, candidate)
               WHERE m.conversation_id = matched.conversation_id
                 AND m.application_link_status IN ('unmatched', 'no_candidate', 'ambiguous', 'name_mismatch')
                 AND m.application_link_source IS DISTINCT FROM 'dispatch_channel_order_no'
            `)
            : 0
          const conflictedConversationValues = persistedRows.flatMap((row) =>
            row.application_link_status === 'conflict' ? [Prisma.sql`(${row.id})`] : [])
          const conflictedMessageCount = conflictedConversationValues.length > 0
            ? await tx.$executeRaw(Prisma.sql`
              UPDATE native_chat_messages AS m
                 SET application_no = NULL,
                     order_id = NULL,
                     application_link_status = 'conflict',
                     application_link_evidence = jsonb_build_object(
                       'previous', m.application_link_evidence,
                       'conversationLinkStatus', 'conflict'
                     ),
                     application_linked_at = NOW()
                FROM (VALUES ${Prisma.join(conflictedConversationValues)}) AS conflicted(conversation_id)
               WHERE m.conversation_id = conflicted.conversation_id
                 AND m.application_link_source = 'conversation_title'
                 AND m.application_link_status = 'matched'
            `)
            : 0
          completedBatchCount = batchNumber
          activeBatchNumber = null
          request.log.info({
            event: 'native_chat_discovery_batch_completed',
            employeeId,
            requestId: request.id,
            batchNumber,
            batchCount: Math.ceil(orderedSessions.length / 200),
            batchSessionCount: values.length,
            persistedSessionCount,
            titleLinkedSessionCount: linkedConversationValues.length,
            titleLinkedExistingMessageCount: backfilledMessageCount,
            conflictedTitleMessageCount: conflictedMessageCount,
            elapsedMs: Date.now() - batchStartedAt
          })
        }
      }, { timeout: 60_000, maxWait: 10_000 })
      request.log.info({
        event: 'native_chat_discovery_completed',
        employeeId,
        requestId: request.id,
        submittedSessionCount: sessions.length,
        persistedSessionCount,
        applicationLinkResolutionMs: linkElapsedMs,
        completedBatchCount,
        elapsedMs: Date.now() - requestStartedAt,
        clientDisconnected: request.raw.aborted
      })
      if (snapshotKey && request.body?.lastBatch === true) syncSnapshots.delete(snapshotKey)
      return reply.send({ data: { discovered: sessions.length, persisted: persistedSessionCount } })
    } catch (error) {
      request.log.error({
        event: 'native_chat_discovery_failed',
        employeeId,
        requestId: request.id,
        stage,
        submittedSessionCount: sessions.length,
        completedBatchCount,
        activeBatchNumber,
        elapsedMs: Date.now() - requestStartedAt,
        clientDisconnected: request.raw.aborted,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  })
}
