export type PickerOrder = { id: number; applicationNo?: string | null; rawJson?: { crmApplyNo?: unknown } | null; sourceOrderNo: string; huanyuOrderNo?: string | null; customerName: string; serviceType?: string | null; hospital: string | null; dept: string | null; doctor: string | null; status: string; intendDate?: string | null }
export type PickerPage = { data: PickerOrder[]; total: number; page: number; totalPages: number }

export function applicationNoOf(order: PickerOrder): string {
  const value = order.rawJson?.crmApplyNo ?? order.applicationNo
  return typeof value === 'string' ? value.trim() : ''
}

export function parsePickerPage(value: unknown, page: number): PickerPage {
  if (!value || typeof value !== 'object') throw new Error('订单列表返回格式无效')
  const result = value as PickerPage
  if (!Array.isArray(result.data) || !Number.isSafeInteger(result.total) || result.total < 0 || !Number.isSafeInteger(result.totalPages) || result.totalPages < 0 || result.page !== page) throw new Error('订单列表返回格式无效')
  return result
}

export async function loadApplicationOrders(applicationNo: string, fetchPage: (page: number, applicationNo: string) => Promise<unknown>): Promise<PickerOrder[]> {
  const orders: PickerOrder[] = []
  let page = 1
  let totalPages: number
  do {
    const result = parsePickerPage(await fetchPage(page, applicationNo), page)
    orders.push(...result.data.filter((order) => applicationNoOf(order) === applicationNo))
    totalPages = result.totalPages
    page++
  } while (page <= totalPages)
  return orders
}
