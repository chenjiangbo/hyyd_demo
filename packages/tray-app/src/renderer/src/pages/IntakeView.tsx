import { useCallback, useEffect, useState } from 'react'
import { api, type Order } from '../api/client'

export default function IntakeView(): React.JSX.Element {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [claimingId, setClaimingId] = useState<number | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // MVP 阶段后端把所有泰康订单都存为"已申领"了（status mapping 待修），
      // 这里 fetch all，前端按 status 过滤。
      const data = await api.listOrders({ source: 'taikang' })
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

  const handleClaim = async (orderId: number) => {
    setClaimingId(orderId)
    setToast(null)
    try {
      await api.claim(orderId)
      setToast(`已下发申领指令（订单 #${orderId}），浏览器插件应当自动点"详情"`)
      setTimeout(refresh, 1500)
    } catch (e) {
      setToast(`申领失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setClaimingId(null)
    }
  }

  // 申领台只显示"候选"状态的（实际还要看后端 status mapping）
  // MVP 阶段宽松：候选 + 全部待人工的展示出来
  const candidates = orders.filter((o) => o.status === '候选')
  const others = orders.filter((o) => o.status !== '候选')

  return (
    <div className="p-6">
      <header className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">申领台</h1>
          <p className="text-sm text-slate-500 mt-1">
            展示从泰康追踪池采集到的"候选"订单，点击申领即可下发指令到浏览器。
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

      {toast && (
        <div className="mb-4 px-4 py-2 bg-blue-50 border border-blue-200 text-sm text-blue-800 rounded-md">
          {toast}
        </div>
      )}

      {error && (
        <div className="mb-4 px-4 py-2 bg-red-50 border border-red-200 text-sm text-red-700 rounded-md">
          ❌ {error}
        </div>
      )}

      <OrderTable
        title={`候选订单（${candidates.length}）`}
        orders={candidates}
        showClaim
        onClaim={handleClaim}
        claimingId={claimingId}
      />

      {others.length > 0 && (
        <div className="mt-8">
          <OrderTable
            title={`其他状态订单（${others.length}）`}
            orders={others}
            showClaim={false}
          />
        </div>
      )}

      {!loading && orders.length === 0 && (
        <div className="text-center py-16 text-slate-400 text-sm">
          暂无订单。请确认浏览器插件已采集并上报到后端。
        </div>
      )}
    </div>
  )
}

interface TableProps {
  title: string
  orders: Order[]
  showClaim: boolean
  onClaim?: (id: number) => void
  claimingId?: number | null
}

function OrderTable({ title, orders, showClaim, onClaim, claimingId }: TableProps): React.JSX.Element {
  if (orders.length === 0) return <></>
  return (
    <div className="bg-white rounded-md shadow-sm border border-slate-200 overflow-hidden">
      <div className="px-4 py-2 border-b border-slate-100 text-sm font-medium text-slate-700">
        {title}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <Th>泰康订单号</Th>
              <Th>就诊人</Th>
              <Th>状态</Th>
              <Th>来源</Th>
              <Th>入库时间</Th>
              {showClaim && <Th>操作</Th>}
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-t border-slate-100 hover:bg-slate-50">
                <Td>
                  <code className="text-xs text-slate-700">{o.sourceOrderNo}</code>
                </Td>
                <Td>{o.customerName}</Td>
                <Td>
                  <StatusBadge status={o.status} />
                </Td>
                <Td>{o.source}</Td>
                <Td className="text-slate-500">
                  {new Date(o.createdAt).toLocaleString('zh-CN')}
                </Td>
                {showClaim && (
                  <Td>
                    <button
                      onClick={() => onClaim?.(o.id)}
                      disabled={claimingId === o.id}
                      className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded"
                    >
                      {claimingId === o.id ? '申领中…' : '申领'}
                    </button>
                  </Td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <th className="text-left font-medium px-4 py-2">{children}</th>
}

function Td({
  children,
  className = ''
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return <td className={`px-4 py-2 ${className}`}>{children}</td>
}

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const styles: Record<string, string> = {
    候选: 'bg-amber-100 text-amber-800',
    已申领: 'bg-blue-100 text-blue-800',
    进行中: 'bg-violet-100 text-violet-800',
    完成: 'bg-emerald-100 text-emerald-800'
  }
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs ${
        styles[status] ?? 'bg-slate-100 text-slate-700'
      }`}
    >
      {status}
    </span>
  )
}
