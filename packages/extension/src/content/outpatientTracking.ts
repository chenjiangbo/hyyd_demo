export type TrackingMatch = { orderState: string; orderStateName: string }

/** 严格区分接口错误、未查到和唯一匹配；不得以非精确结果更新订单。 */
export function parseTrackingPage(response: any, sourceOrderNo: string): { matches: TrackingMatch[]; hasNextPage: boolean } {
  if (Number(response?.code) !== 200 || response?.success === false || !Array.isArray(response?.data?.list) || typeof response?.data?.hasNextPage !== 'boolean') throw new Error('泰康追踪池响应异常')
  const matches = response.data.list.filter((item: any) => String(item?.subOrderNo ?? '').trim() === sourceOrderNo).map((item: any) => ({ orderState: String(item.orderState ?? '').trim(), orderStateName: String(item.orderStateName ?? '').trim() }))
  return { matches, hasNextPage: response.data.hasNextPage }
}

export function classifyTrackingMatches(matches: TrackingMatch[]): { outcome: 'found' | 'not_found'; state?: string; stateName?: string } {
  if (matches.length > 1) throw new Error('泰康订单号匹配到多条记录')
  if (!matches.length) return { outcome: 'not_found' }
  const { orderState: state, orderStateName: stateName } = matches[0]
  if (!state || !stateName) throw new Error('泰康订单状态不完整')
  if ((state === '2007') !== (stateName === '已完成')) throw new Error('泰康订单状态编码和名称不一致')
  return { outcome: 'found', state, stateName }
}
