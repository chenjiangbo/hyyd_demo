type Page = { list: unknown[]; hasNextPage: boolean }
type LookupResult = { status: 'found' | 'not_found' | 'conflict'; applicationNo?: string; source?: 'personal' | 'tracking' }
type RequestPage = (pool: 'personal' | 'tracking', sourceOrderNo: string, page: number) => Promise<unknown>

/** 任务查完后等待下一次北京时间 5 点，跨日期边界不依赖电脑本地时区。 */
export function nextRegistrationRun(now = Date.now()): number {
  const shanghai = new Date(now + 8 * 60 * 60 * 1000)
  let next = Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate(), 5) - 8 * 60 * 60 * 1000
  if (next <= now) next += 24 * 60 * 60 * 1000
  return next
}

export class RegistrationIdleGate {
  private idle: { account: string; until: number } | null = null
  shouldPoll(hasToken: boolean, account: string | null, now = Date.now()): boolean {
    if (!hasToken) { this.idle = null; return false }
    return !this.idle || this.idle.account !== account || now >= this.idle.until
  }
  defer(account: string, availability: 'waiting' | 'retry' | 'done', now = Date.now()): void {
    this.idle = { account, until: availability === 'done' ? nextRegistrationRun(now) : now + (availability === 'retry' ? 10 * 60_000 : 2 * 60_000) }
  }
}

/** 分页查询两个挂号池，始终以子订单号精确匹配；不同申请号不得自动选择。 */
export async function lookupRegistrationApplication(sourceOrderNo: string, requestPage: RequestPage, maxPages = 100): Promise<LookupResult> {
  if (!/^[A-Za-z0-9-]{1,50}$/.test(sourceOrderNo)) throw new Error('挂号协助子订单号无效')
  const found = new Map<string, 'personal' | 'tracking'>()
  for (const pool of ['personal', 'tracking'] as const) {
    for (let page = 1; page <= maxPages; page++) {
      const response = await requestPage(pool, sourceOrderNo, page) as { code?: unknown; success?: unknown; data?: Page }
      if (Number(response?.code) !== 200 || response?.success === false || !Array.isArray(response?.data?.list) || typeof response?.data?.hasNextPage !== 'boolean') throw new Error('挂号协助池查询失败')
      for (const value of response.data.list) {
        if (!value || typeof value !== 'object') continue
        const item = value as Record<string, unknown>
        if (String(item.subOrderNo ?? '').trim() !== sourceOrderNo) continue
        const applicationNo = typeof item.crmApplyNo === 'string' ? item.crmApplyNo.trim() : ''
        if (applicationNo.length > 50) throw new Error('申请号超过长度限制')
        if (applicationNo && !found.has(applicationNo)) found.set(applicationNo, pool)
      }
      if (!response.data.hasNextPage) break
      if (page === maxPages) throw new Error('挂号协助池分页未完成')
    }
  }
  if (found.size > 1) return { status: 'conflict' }
  const first = found.entries().next().value as [string, 'personal' | 'tracking'] | undefined
  return first ? { status: 'found', applicationNo: first[0], source: first[1] } : { status: 'not_found' }
}
