import { useEffect, useMemo, useState } from 'react'
import { fetchOrders, type Order } from '../api'
import { bizType, bizChipClass, sourceLabel, monthDay, relativeTime, initials } from '../lib/orderMapping'

/**
 * 客户档案：按客户聚合其所有历史与在途订单，给专员一个 360° 视图。
 * 数据来自当前员工名下订单（HTTP fetchOrders），按客户姓名聚合（手机号有则展示）。
 * 重点："第二次接触这个客户时，能迅速回忆起他是谁、上次发生过什么。"
 * 沟通偏好/病情等"AI 逐步沉淀"项后续接入（依赖跨订单简报聚合）。
 */
interface Customer {
  key: string
  name: string
  phone: string | null
  orders: Order[]
  sources: string[]
  bizTypes: string[]
  lastActiveAt: string
}

function groupByCustomer(orders: Order[]): Customer[] {
  const map = new Map<string, Customer>()
  for (const o of orders) {
    const name = o.customerName || '未知客户'
    const key = name
    let c = map.get(key)
    if (!c) {
      c = { key, name, phone: null, orders: [], sources: [], bizTypes: [], lastActiveAt: o.updatedAt }
      map.set(key, c)
    }
    c.orders.push(o)
    if (!c.phone && o.customerPhone) c.phone = o.customerPhone
    const sl = sourceLabel(o)
    if (!c.sources.includes(sl)) c.sources.push(sl)
    const bt = bizType(o)
    if (!c.bizTypes.includes(bt)) c.bizTypes.push(bt)
    if (new Date(o.updatedAt).getTime() > new Date(c.lastActiveAt).getTime()) c.lastActiveAt = o.updatedAt
  }
  return [...map.values()].sort(
    (a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
  )
}

const DONE_STATUS = /已完成|已结束|已交付|结案/

export default function CustomersPage({ onOpenOrder }: { onOpenOrder: (o: Order) => void }): React.JSX.Element {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selKey, setSelKey] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    fetchOrders()
      .then((list) => {
        setOrders(list)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : '加载客户失败'))
      .finally(() => setLoading(false))
  }, [])

  const customers = useMemo(() => groupByCustomer(orders), [orders])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return customers
    return customers.filter((c) => c.name.toLowerCase().includes(q) || (c.phone || '').includes(q))
  }, [customers, query])

  const selected = useMemo(
    () => filtered.find((c) => c.key === selKey) || filtered[0] || null,
    [filtered, selKey]
  )

  return (
    <div className="flex-1 min-h-0 flex bg-surface-bg">
      {/* 左：客户列表 */}
      <div className="w-72 shrink-0 border-r border-border-subtle bg-white flex flex-col">
        <div className="p-3 border-b border-border-subtle">
          <h1 className="text-h3-title text-text-main mb-2">客户档案</h1>
          <div className="relative">
            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-outline" style={{ fontSize: '17px' }}>search</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索客户姓名 / 手机号…"
              className="w-full pl-8 pr-3 py-1.5 bg-surface-bg border border-border-subtle rounded-lg text-body-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-body-sm text-text-muted">加载中…</div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-body-sm text-text-muted">{query ? '无匹配客户' : '暂无客户'}</div>
          ) : (
            filtered.map((c) => (
              <button
                key={c.key}
                onClick={() => setSelKey(c.key)}
                className={
                  'w-full text-left px-3 py-2.5 border-b border-border-subtle flex items-center gap-2.5 transition-colors ' +
                  (selected?.key === c.key ? 'bg-primary/10' : 'hover:bg-surface-container-low')
                }
              >
                <span className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-body-sm font-semibold shrink-0">
                  {initials(c.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-body-md font-medium text-text-main truncate">{c.name}</span>
                  <span className="block text-label-caps text-text-muted truncate">
                    {c.orders.length} 单 · {relativeTime(c.lastActiveAt)}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* 右：客户 360° */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {error ? (
          <div className="m-6 text-body-sm text-red-600 bg-red-50 rounded px-3 py-2">⚠ {error}</div>
        ) : !selected ? (
          <div className="h-full flex items-center justify-center text-body-sm text-text-muted">选择左侧客户查看档案</div>
        ) : (
          <CustomerProfile customer={selected} onOpenOrder={onOpenOrder} />
        )}
      </div>
    </div>
  )
}

function CustomerProfile({ customer, onOpenOrder }: { customer: Customer; onOpenOrder: (o: Order) => void }): React.JSX.Element {
  const active = customer.orders.filter((o) => !DONE_STATUS.test(o.status))
  const done = customer.orders.filter((o) => DONE_STATUS.test(o.status))

  return (
    <div className="p-6 max-w-3xl">
      {/* 头 */}
      <div className="flex items-center gap-4 mb-5">
        <span className="w-14 h-14 rounded-full bg-primary/10 text-primary flex items-center justify-center text-h3-title font-bold shrink-0">
          {initials(customer.name)}
        </span>
        <div className="min-w-0">
          <h2 className="text-h2-header text-text-main">{customer.name}</h2>
          <div className="flex items-center gap-3 text-body-sm text-text-muted mt-0.5">
            <span className="inline-flex items-center gap-1">
              <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>call</span>
              {customer.phone || '手机号待补全'}
            </span>
            <span>·</span>
            <span>共 {customer.orders.length} 单</span>
            <span>·</span>
            <span>{customer.sources.join(' / ')}</span>
          </div>
        </div>
      </div>

      {/* 概览卡 */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        <StatCard label="在途订单" value={active.length} icon="pending_actions" />
        <StatCard label="历史订单" value={done.length} icon="history" />
        <StatCard label="涉及业务" value={customer.bizTypes.length} icon="medical_services" />
      </div>

      {/* 业务标签 */}
      {customer.bizTypes.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-5">
          {customer.bizTypes.map((b) => (
            <span key={b} className="text-label-caps px-2 py-0.5 rounded bg-surface-container text-text-muted">{b}</span>
          ))}
        </div>
      )}

      <OrderGroup title="在途订单" orders={active} onOpenOrder={onOpenOrder} emptyText="无在途订单" />
      <OrderGroup title="历史订单" orders={done} onOpenOrder={onOpenOrder} emptyText="无历史订单" />

      <div className="mt-6 rounded-lg border border-dashed border-border-subtle p-4 text-body-sm text-text-muted">
        <span className="material-symbols-outlined align-middle mr-1 text-ai-purple" style={{ fontSize: '16px' }}>auto_awesome</span>
        客户病情/就诊历史、沟通偏好等将由 AI 从各订单的沟通数据中逐步沉淀（规划中）。
      </div>
    </div>
  )
}

function StatCard({ label, value, icon }: { label: string; value: number; icon: string }): React.JSX.Element {
  return (
    <div className="bg-white rounded-lg border border-border-subtle p-3 flex items-center gap-3">
      <span className="material-symbols-outlined text-primary" style={{ fontSize: '22px' }}>{icon}</span>
      <div>
        <div className="text-h3-title text-text-main leading-none">{value}</div>
        <div className="text-label-caps text-text-muted mt-1">{label}</div>
      </div>
    </div>
  )
}

function OrderGroup({
  title,
  orders,
  onOpenOrder,
  emptyText
}: {
  title: string
  orders: Order[]
  onOpenOrder: (o: Order) => void
  emptyText: string
}): React.JSX.Element {
  return (
    <div className="mb-4">
      <div className="text-label-caps text-text-muted mb-1.5">{title}（{orders.length}）</div>
      {orders.length === 0 ? (
        <p className="text-body-sm text-text-muted/60 py-2">{emptyText}</p>
      ) : (
        <div className="space-y-2">
          {orders.map((o) => (
            <button
              key={o.id}
              onClick={() => onOpenOrder(o)}
              className="w-full text-left bg-white rounded-lg border border-border-subtle p-3 flex items-center gap-3 hover:shadow-sm hover:border-primary/40 transition-all"
            >
              <span className={'text-label-caps px-1.5 py-0.5 rounded shrink-0 ' + bizChipClass(o)}>{bizType(o)}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-body-sm font-mono-data text-text-main truncate">{o.sourceOrderNo}</span>
                <span className="block text-label-caps text-text-muted truncate">
                  {o.hospital ? o.hospital + (o.dept ? ` · ${o.dept}` : '') : '医院待定'}
                </span>
              </span>
              <span className="text-label-caps text-text-muted shrink-0">{monthDay(o.updatedAt)}</span>
              <span className="px-2 py-0.5 rounded-full bg-primary-container/15 text-primary text-label-caps shrink-0 whitespace-nowrap">
                {o.status}
              </span>
              <span className="material-symbols-outlined text-text-muted shrink-0" style={{ fontSize: '18px' }}>chevron_right</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
