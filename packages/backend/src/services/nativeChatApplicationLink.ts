import type { PrismaClient } from '@prisma/client'
import { extractOrderCandidate, resolveOrder, type OrderNoEntry } from '../lib/orderNoMatch.js'

export type NativeChatApplicationLinkStatus = 'matched' | 'no_candidate' | 'unmatched' | 'ambiguous' | 'name_mismatch'

export type NativeChatApplicationLink = {
  applicationNo: string | null
  candidate: string | null
  status: NativeChatApplicationLinkStatus
}

export type NativeChatOrderSnapshot = {
  crmApplicationOrders: Map<string, Array<{ id: number; customerName: string | null }>>
  resolverIdToApplicationNo: Map<number, string>
  resolverEntries: OrderNoEntry[]
  orderById: Map<number, string>
  orderCount: number
}

/** A snapshot is scoped to one directory sync and uses the same order data as the legacy matcher. */
export async function loadNativeChatOrderSnapshot(prisma: PrismaClient): Promise<NativeChatOrderSnapshot> {
  const orders = await prisma.order.findMany({ select: { id: true, rawJson: true, customerName: true } })
  const crmApplicationOrders = new Map<string, Array<{ id: number; customerName: string | null }>>()
  const orderById = new Map<number, string>()
  for (const order of orders) {
    const raw = order.rawJson && typeof order.rawJson === 'object' && !Array.isArray(order.rawJson)
      ? order.rawJson as Record<string, unknown> : {}
    const applicationNo = typeof raw.crmApplyNo === 'string' ? raw.crmApplyNo.trim() : null
    if (!applicationNo) continue
    orderById.set(order.id, applicationNo)
    const group = crmApplicationOrders.get(applicationNo) ?? []
    group.push({ id: order.id, customerName: order.customerName })
    crmApplicationOrders.set(applicationNo, group)
  }
  const resolverIdToApplicationNo = new Map<number, string>()
  let nextResolverId = 1
  const resolverEntries: OrderNoEntry[] = [...crmApplicationOrders.entries()].map(([applicationNo, group]) => {
    const resolverId = nextResolverId++
    resolverIdToApplicationNo.set(resolverId, applicationNo)
    return { orderId: resolverId, nos: [applicationNo], name: group.map((order) => order.customerName).find(Boolean) ?? null }
  })
  return { crmApplicationOrders, resolverIdToApplicationNo, resolverEntries, orderById, orderCount: orders.length }
}

/** Resolve one title through the same candidate and CRM application matching used by the old capture path. */
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

/**
 * Resolve a whole directory with one order read, while preserving the legacy matcher exactly:
 * candidate extraction, OCR character normalization, edit-distance tolerance, tail handling,
 * customer-name disambiguation, and ambiguity results all come from orderNoMatch.ts.
 */
export async function resolveNativeChatApplicationLinks(
  prisma: PrismaClient,
  employeeId: number,
  titles: Array<string | null>,
  onProgress?: (stage: string, details: Record<string, number>) => void,
  getSnapshot?: () => Promise<NativeChatOrderSnapshot>
): Promise<NativeChatApplicationLink[]> {
  const startedAt = Date.now()
  const candidates = titles.map((title) => extractOrderCandidate(title))
  const candidateValues = [...new Set(candidates.flatMap((candidate) => candidate ? [candidate.raw] : []))]
  onProgress?.('candidate_extraction_completed', {
    titleCount: titles.length,
    candidateCount: candidateValues.length,
    elapsedMs: Date.now() - startedAt
  })

  if (candidateValues.length === 0) {
    onProgress?.('bulk_application_lookup_completed', {
      candidateCount: 0,
      crmApplicationCount: 0,
      orderCount: 0,
      confirmedCandidateCount: 0,
      elapsedMs: Date.now() - startedAt
    })
    return candidates.map(() => ({ applicationNo: null, candidate: null, status: 'no_candidate' }))
  }

  // The previous implementation read all orders once for every candidate title.
  // Read the same CRM application-number and customer-name data once for the entire directory;
  // do not restrict the candidate set or change the legacy resolver's matching behavior.
  const [snapshot, confirmedRows] = await Promise.all([
    getSnapshot ? getSnapshot() : loadNativeChatOrderSnapshot(prisma),
    prisma.unmatchedOrderRef.findMany({
      where: { employeeId, candidate: { in: candidateValues } },
      select: { candidate: true, status: true, resolvedOrderId: true, resolvedApplicationNo: true }
    })
  ])
  const { crmApplicationOrders, resolverIdToApplicationNo, resolverEntries, orderById } = snapshot
  const confirmedByCandidate = new Map(confirmedRows.map((row) => [row.candidate, row]))
  onProgress?.('bulk_application_lookup_completed', {
    candidateCount: candidateValues.length,
    crmApplicationCount: crmApplicationOrders.size,
    orderCount: snapshot.orderCount,
    confirmedCandidateCount: confirmedRows.length,
    elapsedMs: Date.now() - startedAt
  })

  return candidates.map((candidate, index): NativeChatApplicationLink => {
    if (!candidate) return { applicationNo: null, candidate: null, status: 'no_candidate' }

    const confirmed = confirmedByCandidate.get(candidate.raw)
    if (confirmed?.status === 'confirmed') {
      let confirmedApplicationNo = confirmed.resolvedApplicationNo
      if (!confirmedApplicationNo && confirmed.resolvedOrderId) {
        const confirmedOrder = orderById.get(confirmed.resolvedOrderId)
        confirmedApplicationNo = confirmedOrder ?? null
      }
      if (confirmedApplicationNo) {
        return { applicationNo: confirmedApplicationNo, candidate: candidate.raw, status: 'matched' }
      }
    }

    const resolution = resolveOrder(candidate.raw, resolverEntries, 2, titles[index])
    if (resolution.status === 'matched') {
      const applicationNo = resolverIdToApplicationNo.get(resolution.orderId)
      if (!applicationNo) throw new Error(`旧申领号解析器返回未知候选 ID：${resolution.orderId}`)
      return { applicationNo, candidate: candidate.raw, status: 'matched' }
    }
    if (resolution.status === 'ambiguous') {
      return { applicationNo: null, candidate: candidate.raw, status: 'ambiguous' }
    }
    if (resolution.status === 'name_mismatch') {
      return { applicationNo: null, candidate: candidate.raw, status: 'name_mismatch' }
    }
    return { applicationNo: null, candidate: candidate.raw, status: 'unmatched' }
  })
}
