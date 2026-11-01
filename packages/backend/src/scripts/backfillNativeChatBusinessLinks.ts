import { createShanghaiPrismaClient } from '../db/shanghaiPrisma.js'
import { Prisma } from '@prisma/client'
import { resolveNativeChatApplicationLinks } from '../services/nativeChatApplicationLink.js'
import { resolveNativeMessageBusinessLinksBatch } from '../services/nativeChatMessageLink.js'

const prisma = createShanghaiPrismaClient()
const APPLY = process.argv.includes('--apply')
const PAGE_SIZE = 100
const AFTER_ID_ARG = process.argv.find((arg) => arg.startsWith('--after-conversation-id='))
const START_AFTER_ID = AFTER_ID_ARG ? Number(AFTER_ID_ARG.split('=')[1]) : 0

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function isVoucher(sourceMetadata: unknown): boolean {
  return record(record(sourceMetadata)?.imageAnalysis)?.imageType === '挂号凭证'
}

function existingApplication(metadata: unknown): { applicationNo: string; orderId: number | null; source: string } | null {
  const analysis = record(record(metadata)?.imageAnalysis)
  if (analysis?.imageType !== '挂号凭证') return null
  const match = record(analysis.registrationMatch)
  const manager = record(match?.managerResolution)
  if (manager?.status === 'manager_confirmed' && typeof manager.applicationNo === 'string') {
    return { applicationNo: manager.applicationNo, orderId: typeof manager.orderId === 'number' ? manager.orderId : null, source: 'manager_confirmation' }
  }
  if (match?.status === 'completed' && match.applicationDecision === 'matched' && typeof match.applicationNo === 'string') {
    return {
      applicationNo: match.applicationNo,
      orderId: match.orderDecision === 'matched' && typeof match.orderId === 'number' ? match.orderId : null,
      source: 'registration_proof_ai'
    }
  }
  return null
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL；回填命令不会改用其他连接配置')
  if (!Number.isSafeInteger(START_AFTER_ID) || START_AFTER_ID < 0) throw new Error('--after-conversation-id 必须是非负整数')
  let afterId = START_AFTER_ID
  console.log(JSON.stringify({ event: 'native_chat_link_backfill_started', mode: APPLY ? 'apply' : 'report_only', pageSize: PAGE_SIZE, afterConversationId: afterId }))
  const totals: Record<string, number> = {
    conversations: 0, messages: 0, attachments: 0,
    titleMatched: 0, dispatchMatched: 0, ambiguous: 0, unmatched: 0,
    voucherMatched: 0, voucherConflict: 0, voucherUnmatched: 0, updated: 0
  }

  while (true) {
    const conversations = await prisma.nativeChatConversation.findMany({
      where: { id: { gt: afterId } }, orderBy: { id: 'asc' }, take: PAGE_SIZE,
      select: { id: true, employeeId: true, title: true }
    })
    if (!conversations.length) break
    afterId = conversations.at(-1)!.id
    totals.conversations += conversations.length
    const linksByEmployee = new Map<number, Awaited<ReturnType<typeof resolveNativeChatApplicationLinks>>>()
    for (const employeeId of new Set(conversations.map((conversation) => conversation.employeeId))) {
      const employeeConversations = conversations.filter((conversation) => conversation.employeeId === employeeId)
      linksByEmployee.set(employeeId, await resolveNativeChatApplicationLinks(
        prisma, employeeId, employeeConversations.map((conversation) => conversation.title)
      ))
    }
    const conversationLinks = new Map<number, Awaited<ReturnType<typeof resolveNativeChatApplicationLinks>>[number]>()
    for (const employeeId of new Set(conversations.map((conversation) => conversation.employeeId))) {
      const employeeConversations = conversations.filter((conversation) => conversation.employeeId === employeeId)
      const links = linksByEmployee.get(employeeId)!
      employeeConversations.forEach((conversation, index) => conversationLinks.set(conversation.id, links[index]!))
    }
    const ids = conversations.map((conversation) => conversation.id)
    const messageRows = await prisma.nativeChatMessage.findMany({
      where: { conversationId: { in: ids } }, orderBy: { id: 'asc' },
      select: {
        id: true, conversationId: true, sourceMessageId: true, text: true,
        applicationNo: true, orderId: true, applicationLinkStatus: true,
        applicationLinkSource: true, applicationLinkEvidence: true
      }
    })
    totals.messages += messageRows.length
    const resolvedMessages = await resolveNativeMessageBusinessLinksBatch(prisma, messageRows.map((message) => ({
      message: { sourceMessageId: message.sourceMessageId, text: message.text, key: String(message.id) },
      conversationLink: conversationLinks.get(message.conversationId) ?? { applicationNo: null, candidate: null, status: 'no_candidate' as const }
    })))
    const attachmentRows = messageRows.length ? await prisma.nativeChatAttachment.findMany({
      where: { messageId: { in: messageRows.map((message) => message.id) }, kind: 'image' },
      select: {
        id: true, messageId: true, sourceMetadata: true, applicationNo: true, orderId: true,
        applicationLinkStatus: true, applicationLinkSource: true, applicationLinkEvidence: true
      }
    }) : []
    totals.attachments += attachmentRows.length

    for (const message of messageRows) {
      const incoming = resolvedMessages.get(String(message.id))
      if (!incoming) throw new Error(`消息 ${message.id} 缺少回填解析结果`)
      if (incoming.status === 'matched') {
        if (incoming.source === 'dispatch_channel_order_no') totals.dispatchMatched++
        else if (incoming.source === 'conversation_title') totals.titleMatched++
      } else if (incoming.status === 'ambiguous') totals.ambiguous++
      else totals.unmatched++
      let next = incoming
      if (message.applicationLinkSource === 'manager_confirmation') continue
      if (message.applicationLinkStatus === 'conflict') continue
      if (message.applicationLinkStatus === 'matched' && message.applicationNo) {
        if (incoming.status === 'matched' && incoming.applicationNo !== message.applicationNo) {
          next = {
            ...incoming, applicationNo: null, orderId: null, status: 'conflict',
            evidence: { existing: message.applicationLinkEvidence, incoming: incoming.evidence }
          }
        } else if (incoming.status !== 'matched') {
          continue
        }
      }
      if (!APPLY || (message.applicationLinkStatus === next.status && message.applicationNo === next.applicationNo
        && message.orderId === next.orderId && message.applicationLinkSource === next.source)) continue
      await prisma.nativeChatMessage.update({
        where: { id: message.id },
        data: {
          applicationNo: next.applicationNo, orderId: next.orderId,
          applicationLinkStatus: next.status, applicationLinkSource: next.source,
          applicationLinkEvidence: next.evidence as Prisma.InputJsonObject, applicationLinkedAt: new Date()
        }
      })
      totals.updated++
    }

    const attachmentIncoming = attachmentRows.map((attachment) => ({ attachment, incoming: isVoucher(attachment.sourceMetadata) ? existingApplication(attachment.sourceMetadata) : null }))
    const candidateOrderIds = [...new Set(attachmentIncoming.flatMap(({ incoming }) => incoming?.orderId ? [incoming.orderId] : []))]
    const candidateOrders = candidateOrderIds.length ? await prisma.order.findMany({
      where: { id: { in: candidateOrderIds } }, select: { id: true, rawJson: true }
    }) : []
    const applicationByOrder = new Map(candidateOrders.map((order) => {
      const raw = record(order.rawJson)
      return [order.id, typeof raw?.crmApplyNo === 'string' ? raw.crmApplyNo : null]
    }))
    for (const { attachment, incoming } of attachmentIncoming) {
      if (!isVoucher(attachment.sourceMetadata)) continue
      if (!incoming) { totals.voucherUnmatched++; continue }
      if (incoming.orderId !== null && applicationByOrder.get(incoming.orderId) !== incoming.applicationNo) {
          totals.voucherConflict++
          if (APPLY) await prisma.nativeChatAttachment.update({
            where: { id: attachment.id },
            data: {
              applicationNo: null, orderId: null, applicationLinkStatus: 'conflict',
              applicationLinkSource: incoming.source,
              applicationLinkEvidence: { reason: 'order_application_mismatch', incoming } as Prisma.InputJsonObject,
              applicationLinkedAt: new Date()
            }
          })
          continue
      }
      if (attachment.applicationLinkStatus === 'conflict') { totals.voucherConflict++; continue }
      if (attachment.applicationLinkSource === 'manager_confirmation') continue
      if (attachment.applicationLinkStatus === 'matched' && attachment.applicationNo === incoming.applicationNo
        && attachment.orderId !== null && incoming.orderId === null) {
        totals.voucherMatched++
        continue
      }
      if (attachment.applicationLinkStatus === 'matched' && attachment.applicationNo
        && (attachment.applicationNo !== incoming.applicationNo
          || (attachment.orderId !== null && incoming.orderId !== null && attachment.orderId !== incoming.orderId))) {
        totals.voucherConflict++
        if (APPLY) await prisma.nativeChatAttachment.update({
          where: { id: attachment.id },
          data: {
            applicationNo: null, orderId: null, applicationLinkStatus: 'conflict',
            applicationLinkEvidence: { existing: attachment.applicationLinkEvidence ?? Prisma.JsonNull, incoming } as Prisma.InputJsonObject,
            applicationLinkedAt: new Date()
          }
        })
        continue
      }
      totals.voucherMatched++
      if (APPLY && (attachment.applicationLinkStatus !== 'matched' || attachment.applicationNo !== incoming.applicationNo
        || attachment.orderId !== incoming.orderId || attachment.applicationLinkSource !== incoming.source)) {
        await prisma.nativeChatAttachment.update({
          where: { id: attachment.id },
          data: {
            applicationNo: incoming.applicationNo, orderId: incoming.orderId,
            applicationLinkStatus: 'matched', applicationLinkSource: incoming.source,
            applicationLinkEvidence: record(record(record(attachment.sourceMetadata)?.imageAnalysis)?.registrationMatch)?.managerResolution
              ?? record(record(attachment.sourceMetadata)?.imageAnalysis)?.registrationMatch
              ?? {},
            applicationLinkedAt: new Date()
          }
        })
        totals.updated++
      }
    }
    console.log(JSON.stringify({ event: 'native_chat_link_backfill_progress', afterConversationId: afterId, ...totals }))
  }
  console.log(JSON.stringify({ event: 'native_chat_link_backfill_completed', ...totals }))
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'native_chat_link_backfill_failed', error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
}).finally(async () => prisma.$disconnect())
