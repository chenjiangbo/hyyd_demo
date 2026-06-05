import { useCallback, useEffect, useState } from 'react'
import { api, getClientConfig, type Order } from '../api/client'

const COLUMNS: { status: Order['status']; label: string; color: string }[] = [
  { status: '已申领', label: '已申领', color: 'border-blue-400' },
  { status: '进行中', label: '进行中', color: 'border-violet-400' },
  { status: '完成', label: '完成', color: 'border-emerald-400' }
]

export default function MyWorkbenchView(): React.JSX.Element {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.listOrders({ assignedEmployeeCode: getClientConfig().employeeCode })
      setOrders(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const byStatus = (s: Order['status']) => orders.filter((o) => o.status === s)

  return (
    <div className="p-6">
      <header className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">我的工作台</h1>
          <p className="text-sm text-slate-500 mt-1">
            员工 {getClientConfig().employeeCode} 名下所有订单，按状态分列。
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-md shadow-sm"
        >
          {loading ? '刷新中…' : '🔄 刷新'}
        </button>
      </header>

      {error && (
        <div className="mb-4 px-4 py-2 bg-red-50 border border-red-200 text-sm text-red-700 rounded-md">
          ❌ {error}
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        {COLUMNS.map((col) => {
          const list = byStatus(col.status)
          return (
            <section
              key={col.status}
              className={`bg-white rounded-md shadow-sm border-t-4 ${col.color}`}
            >
              <header className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                <h2 className="font-medium text-slate-700">{col.label}</h2>
                <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
                  {list.length}
                </span>
              </header>
              <div className="p-3 space-y-2 max-h-[calc(100vh-220px)] overflow-y-auto">
                {list.length === 0 ? (
                  <p className="text-center text-slate-400 text-xs py-6">暂无订单</p>
                ) : (
                  list.map((o) => <OrderCard key={o.id} order={o} />)
                )}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function OrderCard({ order }: { order: Order }): React.JSX.Element {
  return (
    <article className="p-3 bg-slate-50 rounded border border-slate-200 hover:border-slate-300 cursor-pointer">
      <div className="flex items-center justify-between mb-1">
        <code className="text-[11px] text-slate-500">{order.sourceOrderNo}</code>
        <span className="text-[11px] text-slate-400">
          {new Date(order.updatedAt).toLocaleDateString('zh-CN')}
        </span>
      </div>
      <div className="font-medium text-sm text-slate-800">{order.customerName}</div>
      {(order.hospital || order.dept) && (
        <div className="text-xs text-slate-500 mt-1">
          {order.hospital ?? ''} {order.dept ?? ''}
        </div>
      )}
    </article>
  )
}
