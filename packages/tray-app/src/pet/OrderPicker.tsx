import { useEffect, useMemo, useState } from 'react'
import { applicationNoOf, loadApplicationOrders, parsePickerPage, type PickerOrder as Order, type PickerPage as Page } from './order-picker-data'
import './OrderPicker.css'

export function OrderPicker(): React.JSX.Element {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<Page | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [children, setChildren] = useState<Order[]>([])
  const [selected, setSelected] = useState<{ applicationNo: string; orderId: number } | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true); setError(''); setExpanded(null); setChildren([]); setSelected(null)
    void window.api.petSearchOrders({ page, query }).then((value) => { if (active) setResult(parsePickerPage(value, page)) })
      .catch((e: unknown) => { if (active) { setResult(null); setError(e instanceof Error ? e.message : '订单加载失败') } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [page, query])

  const groups = useMemo(() => {
    const map = new Map<string, Order[]>()
    for (const order of result?.data ?? []) {
      const key = applicationNoOf(order) || `order:${order.id}`
      const list = map.get(key) ?? []
      list.push(order); map.set(key, list)
    }
    return [...map.entries()]
  }, [result])

  const openApplication = async (applicationNo: string): Promise<void> => {
    if (expanded === applicationNo) { setExpanded(null); setSelected(null); return }
    setExpanded(applicationNo); setChildren([]); setSelected(null); setLoading(true); setError('')
    try {
      const orders = await loadApplicationOrders(applicationNo, (page, appNo) => window.api.petSearchOrders({ page, applicationNo: appNo }))
      setChildren(orders)
    } catch (e) { setError(e instanceof Error ? e.message : '申领号下的订单加载失败') }
    finally { setLoading(false) }
  }

  return <main className="order-picker">
    <h1>选择订单</h1>
    <form className="order-picker__search" onSubmit={(event) => { event.preventDefault(); setPage(1); setQuery(input.trim()) }}>
      <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="搜索申领号、订单号、客户或医院" aria-label="搜索订单" />
      <button type="submit">搜索</button>
    </form>
    {error && <p role="alert" className="order-picker__error">{error}</p>}
    <div className="order-picker__list" aria-busy={loading}>
      {loading && <p>正在加载订单…</p>}
      {!loading && result?.data.length === 0 && <p>没有找到符合条件的订单</p>}
      {groups.map(([key, orders]) => {
        const applicationNo = applicationNoOf(orders[0])
        return <section key={key} className="order-picker__group">
        <button type="button" className="order-picker__application" disabled={!applicationNo || loading} onClick={() => { void openApplication(applicationNo) }}>
          {applicationNo ? `${expanded === applicationNo ? '▾' : '▸'} ${applicationNo}` : `未提供申领号 · ${orders[0].huanyuOrderNo || orders[0].sourceOrderNo || `订单 ${orders[0].id}`}`} · {orders[0]?.customerName || '客户待确认'}
        </button>
        {applicationNo && expanded === applicationNo && <div className="order-picker__orders">
          {!loading && children.length === 0 && <p>该申领号下没有可选订单</p>}
          {children.map((order) => <label key={order.id} className="order-picker__order">
            <input type="radio" name="order" checked={selected?.orderId === order.id} onChange={() => setSelected({ applicationNo, orderId: order.id })} />
            <span><strong>{order.customerName || '客户待确认'} · {order.serviceType || '服务订单'}</strong><br />
              {[order.hospital, order.dept, order.doctor].filter(Boolean).join(' · ') || '医院和科室待确认'}<br />
              {[order.huanyuOrderNo, order.sourceOrderNo, order.intendDate, order.status].filter(Boolean).join(' · ')}</span>
          </label>)}
        </div>}
      </section>})}
    </div>
    <div className="order-picker__footer">
      <span>共 {result?.total ?? 0} 条订单 · 第 {result?.page ?? page} / {Math.max(1, result?.totalPages ?? 1)} 页</span>
      <button type="button" disabled={loading || page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
      <button type="button" disabled={loading || !result || page >= result.totalPages} onClick={() => setPage(page + 1)}>下一页</button>
      <button type="button" onClick={() => window.api.petFinishOrderPicker(null)}>取消</button>
      <button type="button" disabled={!selected || loading} onClick={() => window.api.petFinishOrderPicker(selected)}>确认订单</button>
    </div>
  </main>
}
