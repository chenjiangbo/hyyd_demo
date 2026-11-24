export function cancellationWindow(now = new Date()): { start: string; end: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (name: string) => Number(parts.find(part => part.type === name)?.value)
  const year = get('year'), month = get('month'), day = get('day')
  const first = new Date(Date.UTC(year, month - 3, 1))
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  first.setUTCDate(Math.min(day, lastDay))
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1))
  const format = (d: Date) => `${d.toISOString().slice(0, 10)} 00:00:00`
  return { start: format(first), end: format(tomorrow) }
}

export function cancellationPage(response: any): { items: Array<{ sourceOrderNo: string; state: string; stateName: string }>; hasNextPage: boolean } {
  if (Number(response?.code) !== 200 || response?.success === false || !Array.isArray(response?.data?.list) || typeof response?.data?.hasNextPage !== 'boolean') throw new Error('泰康取消追踪池响应异常')
  const items = response.data.list.map((item: any) => {
    const sourceOrderNo = String(item?.subOrderNo ?? '').trim()
    const state = String(item?.orderState ?? '').trim()
    const stateName = String(item?.orderStateName ?? '').trim()
    if (!/^[A-Za-z0-9-]{1,50}$/.test(sourceOrderNo) || !state || stateName !== '已取消') throw new Error('泰康取消追踪池订单状态或编号异常')
    return { sourceOrderNo, state, stateName }
  })
  return { items, hasNextPage: response.data.hasNextPage }
}
