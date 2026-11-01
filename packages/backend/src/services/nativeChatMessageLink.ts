import { Prisma, type PrismaClient } from '@prisma/client'
import { parseEscortDispatchTemplate } from '../lib/escortTemplateMatch.js'
import type { NativeChatApplicationLink } from './nativeChatApplicationLink.js'

export type MessageBusinessLink = Omit<NativeChatApplicationLink, 'status'> & {
  status: NativeChatApplicationLink['status'] | 'conflict'
  orderId: number | null
  source: string | null
  evidence: Record<string, unknown>
}

export async function resolveNativeMessageBusinessLinks(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  messages: Array<{ sourceMessageId: string; text?: string | null }>,
  conversationLink: Omit<NativeChatApplicationLink, 'status'> & { status: NativeChatApplicationLink['status'] | 'conflict' }
): Promise<Map<string, MessageBusinessLink>> {
  return resolveNativeMessageBusinessLinksBatch(prisma, messages.map((message) => ({ message, conversationLink })))
}

export async function resolveNativeMessageBusinessLinksBatch(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  entries: Array<{
    message: { sourceMessageId: string; text?: string | null; key?: string }
    conversationLink: Omit<NativeChatApplicationLink, 'status'> & { status: NativeChatApplicationLink['status'] | 'conflict' }
  }>
): Promise<Map<string, MessageBusinessLink>> {
  const dispatches = entries.map(({ message, conversationLink }) => ({
    message,
    conversationLink,
    parsed: parseEscortDispatchTemplate(message.text)
  })).filter((entry) => entry.parsed.matched && entry.parsed.channelOrderNo)
  const candidates = [...new Set(dispatches.map((entry) => entry.parsed.channelOrderNo!.trim().toLocaleLowerCase()))]
  const orders = candidates.length
    ? await prisma.$queryRaw<Array<{ id: number; source_order_no: string; application_no: string | null }>>(Prisma.sql`
        SELECT id, source_order_no, raw_json->>'crmApplyNo' AS application_no
          FROM orders
         WHERE lower(source_order_no) IN (${Prisma.join(candidates)})
      `)
    : []
  const orderByCandidate = new Map<string, Array<(typeof orders)[number]>>()
  for (const order of orders) {
    const key = order.source_order_no.toLocaleLowerCase()
    const group = orderByCandidate.get(key) ?? []
    group.push(order)
    orderByCandidate.set(key, group)
  }

  const links = new Map<string, MessageBusinessLink>()
  for (const { message, conversationLink, parsed } of dispatches) {
    const candidate = parsed.channelOrderNo!.trim()
    const matches = orderByCandidate.get(candidate.toLocaleLowerCase()) ?? []
    const unique = new Map(matches.map((order) => [order.id, order]))
    const selected = unique.size === 1 ? [...unique.values()][0]! : null
    if (selected?.application_no?.trim()) {
      const conflict = conversationLink.status === 'matched'
        && conversationLink.applicationNo !== selected.application_no.trim()
      links.set(message.key ?? message.sourceMessageId, {
        applicationNo: conflict ? null : selected.application_no.trim(),
        candidate,
        status: conflict ? 'conflict' : 'matched',
        orderId: conflict ? null : selected.id,
        source: 'dispatch_channel_order_no',
        evidence: {
          channelOrderNo: candidate,
          matchedOrderId: selected.id,
          ...(conflict ? { titleApplicationNo: conversationLink.applicationNo, dispatchApplicationNo: selected.application_no.trim() } : {})
        }
      })
    } else {
      links.set(message.key ?? message.sourceMessageId, {
        applicationNo: null,
        candidate,
        status: unique.size > 1 ? 'ambiguous' : 'unmatched',
        orderId: null,
        source: 'dispatch_channel_order_no',
        evidence: {
          channelOrderNo: candidate,
          matchingOrderCount: unique.size,
          ...(unique.size === 1 ? { matchedOrderId: [...unique.values()][0]!.id, missingApplicationNo: true } : {})
        }
      })
    }
  }

  for (const { message, conversationLink } of entries) {
    const key = message.key ?? message.sourceMessageId
    if (links.has(key)) continue
    links.set(key, {
      ...conversationLink,
      orderId: null,
      source: conversationLink.status === 'matched' ? 'conversation_title' : null,
      evidence: conversationLink.candidate ? { titleCandidate: conversationLink.candidate } : {}
    })
  }
  return links
}
