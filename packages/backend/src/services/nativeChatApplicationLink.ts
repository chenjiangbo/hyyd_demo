import type { PrismaClient } from '@prisma/client'
import { extractOrderCandidate, resolveOrder, type OrderNoEntry } from '../lib/orderNoMatch.js'

export type NativeChatApplicationLinkStatus = 'matched' | 'no_candidate' | 'unmatched' | 'ambiguous' | 'name_mismatch'

export type NativeChatApplicationLink = {
  applicationNo: string | null
  candidate: string | null
  status: NativeChatApplicationLinkStatus
}

type LinkOrder = { id: number; rawJson: unknown; customerName: string | null }

function applicationNoOf(rawJson: unknown): string | null {
  if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) return null
  const value = (rawJson as Record<string, unknown>).crmApplyNo
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Resolve the conversation's CRM application scope. Order-level selection remains with the existing AI. */
export async function resolveNativeChatApplicationLink(
  prisma: PrismaClient,
  employeeId: number,
  title: string | null
): Promise<NativeChatApplicationLink> {
  const links = await resolveNativeChatApplicationLinks(prisma, employeeId, [title])
  const link = links[0]
  if (!link) throw new Error('会话业务关联解析没有返回结果')
  return link
}

/** Resolve a discovery snapshot with one order lookup and one confirmation lookup for the whole batch. */
export async function resolveNativeChatApplicationLinks(
  prisma: PrismaClient,
  employeeId: number,
  titles: Array<string | null>
): Promise<NativeChatApplicationLink[]> {
  const extracted = titles.map((title) => extractOrderCandidate(title))
  const candidateValues = [...new Set(extracted.flatMap((item) => item ? [item.raw] : []))]
  if (candidateValues.length === 0) {
    return titles.map((): NativeChatApplicationLink => ({ applicationNo: null, candidate: null, status: 'no_candidate' }))
  }

  const confirmedRows = await prisma.unmatchedOrderRef.findMany({
    where: { employeeId, candidate: { in: candidateValues } },
    select: { candidate: true, status: true, resolvedOrderId: true, resolvedApplicationNo: true }
  })
  const confirmedByCandidate = new Map(confirmedRows.map((row) => [row.candidate, row]))
  const needsOrderResolution = candidateValues.some((candidate) => {
    const row = confirmedByCandidate.get(candidate)
    return row?.status !== 'confirmed' || !row.resolvedApplicationNo
  })
  const confirmedOrderIds = confirmedRows.flatMap((row) =>
    row.status === 'confirmed' && row.resolvedOrderId && !row.resolvedApplicationNo ? [row.resolvedOrderId] : [])
  const orders: LinkOrder[] = needsOrderResolution
    ? await prisma.order.findMany({ select: { id: true, rawJson: true, customerName: true } })
    : confirmedOrderIds.length
      ? await prisma.order.findMany({ where: { id: { in: confirmedOrderIds } }, select: { id: true, rawJson: true, customerName: true } })
      : []
  const orderById = new Map(orders.map((order) => [order.id, order]))
  const applicationOrders = new Map<string, typeof orders>()
  for (const order of orders) {
    const applicationNo = applicationNoOf(order.rawJson)
    if (!applicationNo) continue
    const grouped = applicationOrders.get(applicationNo) ?? []
    grouped.push(order)
    applicationOrders.set(applicationNo, grouped)
  }

  let syntheticId = 1
  const idToApplication = new Map<number, string>()
  const entries: OrderNoEntry[] = [...applicationOrders.entries()].map(([applicationNo, grouped]) => {
    const id = syntheticId++
    idToApplication.set(id, applicationNo)
    return {
      orderId: id,
      nos: [applicationNo],
      name: grouped.map((order) => order.customerName).find(Boolean) ?? null
    }
  })
  return titles.map((title, index): NativeChatApplicationLink => {
    const item = extracted[index]
    if (!item) return { applicationNo: null, candidate: null, status: 'no_candidate' }
    const confirmed = confirmedByCandidate.get(item.raw)
    if (confirmed?.status === 'confirmed') {
      if (confirmed.resolvedApplicationNo) {
        return { applicationNo: confirmed.resolvedApplicationNo, candidate: item.raw, status: 'matched' }
      }
      const applicationNo = confirmed.resolvedOrderId ? applicationNoOf(orderById.get(confirmed.resolvedOrderId)?.rawJson) : null
      if (applicationNo) return { applicationNo, candidate: item.raw, status: 'matched' }
    }
    const result = resolveOrder(item.raw, entries, 2, title)
    if (result.status === 'matched') {
      const applicationNo = idToApplication.get(result.orderId)
      if (!applicationNo) throw new Error(`订单候选匹配成功但未找到申领号映射：${item.raw}`)
      return { applicationNo, candidate: item.raw, status: 'matched' }
    }
    return {
      applicationNo: null,
      candidate: item.raw,
      status: result.status === 'ambiguous' ? 'ambiguous' : result.status === 'name_mismatch' ? 'name_mismatch' : 'unmatched'
    }
  })
}
