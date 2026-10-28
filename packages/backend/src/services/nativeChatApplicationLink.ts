import type { PrismaClient } from '@prisma/client'
import { extractOrderCandidate, resolveOrder, type OrderNoEntry } from '../lib/orderNoMatch.js'

export type NativeChatApplicationLinkStatus = 'matched' | 'no_candidate' | 'unmatched' | 'ambiguous' | 'name_mismatch'

export type NativeChatApplicationLink = {
  applicationNo: string | null
  candidate: string | null
  status: NativeChatApplicationLinkStatus
}

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
  const extracted = extractOrderCandidate(title)
  if (!extracted) return { applicationNo: null, candidate: null, status: 'no_candidate' }

  const confirmed = await prisma.unmatchedOrderRef.findUnique({
    where: { employee_candidate: { employeeId, candidate: extracted.raw } },
    select: { status: true, resolvedOrderId: true, resolvedApplicationNo: true }
  })
  if (confirmed?.status === 'confirmed') {
    if (confirmed.resolvedApplicationNo) {
      return { applicationNo: confirmed.resolvedApplicationNo, candidate: extracted.raw, status: 'matched' }
    }
    if (confirmed.resolvedOrderId) {
      const order = await prisma.order.findUnique({
        where: { id: confirmed.resolvedOrderId },
        select: { rawJson: true }
      })
      const applicationNo = applicationNoOf(order?.rawJson)
      if (applicationNo) return { applicationNo, candidate: extracted.raw, status: 'matched' }
    }
  }

  const orders = await prisma.order.findMany({ select: { id: true, rawJson: true, customerName: true } })
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
  const result = resolveOrder(extracted.raw, entries, 2, title)
  if (result.status === 'matched') {
    const applicationNo = idToApplication.get(result.orderId)
    if (!applicationNo) throw new Error(`订单候选匹配成功但未找到申领号映射：${extracted.raw}`)
    return { applicationNo, candidate: extracted.raw, status: 'matched' }
  }
  return {
    applicationNo: null,
    candidate: extracted.raw,
    status: result.status === 'ambiguous' ? 'ambiguous' : result.status === 'name_mismatch' ? 'name_mismatch' : 'unmatched'
  }
}
