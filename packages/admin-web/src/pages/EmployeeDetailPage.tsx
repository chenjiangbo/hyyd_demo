import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { adminApi } from '../api/client'
import { useCursorQuery } from '../hooks/useCursorQuery'
import { Card, LoadingBlock, ErrorBlock, EmptyBlock, Dot } from '../components/ui'
import { OrderTable } from '../components/OrderTable'
import { MaterialCard } from '../components/MaterialCard'
import { CallCard } from '../components/CallCard'
import { Lightbox } from '../components/Lightbox'
import { LoadMore } from '../components/LoadMore'
import { fmtTimeFull, fmtRelative } from '../lib/format'

type Tab = 'presence' | 'orders' | 'materials' | 'calls'
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'presence', label: 'Presence' },
  { key: 'orders', label: '订单' },
  { key: 'materials', label: '素材' },
  { key: 'calls', label: '通话' }
]

export default function EmployeeDetailPage(): React.JSX.Element {
  const { id } = useParams()
  const empId = Number(id)
  const [tab, setTab] = useState<Tab>('presence')

  const detail = useQuery({
    queryKey: ['employee-detail', empId],
    queryFn: () => adminApi.employeeDetail(empId),
    enabled: Number.isFinite(empId),
    refetchInterval: 15_000
  })

  if (detail.isLoading) return <LoadingBlock />
  if (detail.error) return <ErrorBlock error={detail.error} onRetry={() => void detail.refetch()} />
  if (!detail.data) return <EmptyBlock />

  const d = detail.data

  return (
    <div>
      <div className="mb-4">
        <Link to="/employees" className="text-sm text-fg-muted hover:text-fg">
          ← 返回员工列表
        </Link>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <h1 className="text-xl font-semibold">{d.name}</h1>
        <span className="text-sm text-fg-subtle">{d.token}</span>
        <Dot color={d.presence.online ? 'green' : 'gray'} />
        <span className="text-xs text-fg-muted">{d.presence.online ? '在线' : '离线'}</span>
      </div>

      {/* Tab 头 */}
      <div className="flex gap-1 border-b border-line mb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? 'border-accent text-accent-strong font-medium'
                : 'border-transparent text-fg-muted hover:text-fg'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'presence' && <PresenceTab d={d} />}
      {tab === 'orders' && <OrdersTab empId={empId} />}
      {tab === 'materials' && <MaterialsTab empId={empId} />}
      {tab === 'calls' && <CallsTab empId={empId} />}
    </div>
  )
}

function PresenceTab({ d }: { d: import('../api/types').EmployeeDetail }): React.JSX.Element {
  const p = d.presence
  const s = d.stats
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <Card className="p-4">
        <h2 className="text-sm font-medium mb-2">当前在线状态</h2>
        <RowKV k="综合在线" v={<DotText ok={p.online} on="在线" off="离线" />} />
        <RowKV
          k="Chrome 插件 (WS)"
          v={<DotText ok={p.extConnected} on="已连接" off="未连接" />}
        />
        <RowKV
          k="Tray 桌面端"
          v={
            <span className="inline-flex items-center gap-1.5">
              <DotText ok={p.trayConnected} on="在线" off="离线" />
              {p.trayLastSeenAt && (
                <span className="text-xs text-fg-subtle">· {fmtRelative(p.trayLastSeenAt)}</span>
              )}
            </span>
          }
        />
        <RowKV k="泰康标签页" v={p.taikangTabOpen ? '已打开' : '未打开'} />
        <RowKV k="插件最后心跳" v={p.lastSeenAt ? fmtRelative(p.lastSeenAt) : '—'} />
      </Card>
      <Card className="p-4">
        <h2 className="text-sm font-medium mb-2">泰康 token</h2>
        <RowKV
          k="状态"
          v={p.tokenOk === null ? '未知' : <DotText ok={p.tokenOk} on="有效" off="失效" />}
        />
        {p.tokenReason && <RowKV k="原因" v={p.tokenReason} />}
        <RowKV k="最近检测" v={p.tokenLastCheckAt ? fmtTimeFull(p.tokenLastCheckAt) : '—'} />
      </Card>
      <Card className="p-4 md:col-span-2">
        <h2 className="text-sm font-medium mb-2">累计统计</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
          <Stat n={s.orderCount} label="订单" />
          <Stat n={s.materialText} label="文字素材" />
          <Stat n={s.materialImage} label="图片素材" />
          <Stat n={s.callTotal} label="通话" />
        </div>
        <p className="mt-3 text-xs text-fg-subtle">
          最近素材：{s.lastMaterialAt ? fmtRelative(s.lastMaterialAt) : '从未'}
          {' · '}
          通话状态：
          {Object.entries(s.callByStatus).map(([k, v]) => `${k}:${v}`).join(' / ') || '无'}
        </p>
        <p className="mt-2 text-xs text-fg-subtle">
          注：Chrome 插件走 WebSocket 实时心跳；Tray 桌面端无 WS，靠每 5 秒轮询的 REST
          心跳判断在线（15 秒内无请求即判离线）。Presence 为实时快照，本页每 15 秒刷新。
        </p>
      </Card>
    </div>
  )
}

function OrdersTab({ empId }: { empId: number }): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [input, setInput] = useState('')
  const q = useQuery({
    queryKey: ['employee-orders', empId, search],
    queryFn: () => adminApi.employeeOrders(empId, search || undefined)
  })
  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setSearch(input.trim())
        }}
        className="flex gap-2 mb-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="订单号 / 客户 / 手机 / 医院"
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm w-64"
        />
        <button className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface-2">搜索</button>
      </form>
      {q.isLoading ? (
        <LoadingBlock />
      ) : q.error ? (
        <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data || q.data.length === 0 ? (
        <EmptyBlock label="无订单" />
      ) : (
        <Card className="overflow-hidden">
          <OrderTable rows={q.data} />
        </Card>
      )}
    </div>
  )
}

// 素材 Tab：主从布局。左边按"客户/订单"分组，右边看选中订单的素材时间线，
// 方便在多个客户之间快速切换。
function MaterialsTab({ empId }: { empId: number }): React.JSX.Element {
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)

  const groups = useQuery({
    queryKey: ['material-orders', empId],
    queryFn: () => adminApi.employeeMaterialOrders(empId)
  })

  // 默认选中第一个客户
  const list = groups.data ?? []
  const activeId = selected ?? list[0]?.orderId ?? null
  const active = list.find((g) => g.orderId === activeId) ?? null

  if (groups.isLoading) return <LoadingBlock />
  if (groups.error) return <ErrorBlock error={groups.error} onRetry={() => void groups.refetch()} />
  if (list.length === 0) return <EmptyBlock label="该员工还没有采集任何素材" />

  return (
    <div className="flex gap-4 items-start">
      {/* 左：客户/订单切换器 */}
      <div className="w-64 shrink-0">
        <div className="text-xs text-fg-subtle mb-2 px-1">共 {list.length} 个客户有素材</div>
        <div className="space-y-1">
          {list.map((g) => {
            const on = g.orderId === activeId
            return (
              <button
                key={g.orderId}
                onClick={() => setSelected(g.orderId)}
                className={`w-full text-left rounded-md border px-3 py-2 transition-colors ${
                  on
                    ? 'border-accent bg-accent-soft'
                    : 'border-line bg-surface hover:bg-surface-2'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm">{g.customerName}</span>
                  <span className="text-xs text-fg-subtle tabular-nums">{g.materialCount} 条</span>
                </div>
                <div className="text-xs text-fg-subtle truncate">{g.sourceOrderNo}</div>
                <div className="text-xs text-fg-subtle">{fmtRelative(g.lastMaterialAt)}</div>
              </button>
            )
          })}
        </div>
      </div>

      {/* 右：选中订单信息 + 素材时间线 */}
      <div className="flex-1 min-w-0">
        {active && (
          <Card className="p-4 mb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold">{active.customerName}</span>
                {active.status && (
                  <span className="text-xs rounded bg-surface-2 text-fg-muted px-1.5 py-0.5">
                    {active.status}
                  </span>
                )}
              </div>
              <Link
                to={`/orders/${active.orderId}`}
                className="text-xs text-accent-strong hover:underline"
              >
                打开订单详情 →
              </Link>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 mt-2 text-sm">
              <KV2 k="订单编号" v={active.sourceOrderNo} />
              <KV2 k="受理编号" v={active.applyNo ?? '—'} />
              <KV2 k="客户电话" v={active.customerPhone ?? '—'} />
              <KV2 k="素材数" v={`${active.materialCount} 条`} />
            </div>
          </Card>
        )}
        {activeId !== null && (
          <OrderMaterialList orderId={activeId} onOpenImage={setLightbox} />
        )}
      </div>

      <Lightbox src={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}

// 单个订单的素材时间线（游标分页）
function OrderMaterialList({
  orderId,
  onOpenImage
}: {
  orderId: number
  onOpenImage: (url: string) => void
}): React.JSX.Element {
  const list = useCursorQuery(['materials-by-order', orderId], (cursor) =>
    adminApi.materials({ orderId, cursor })
  )
  if (list.isLoading) return <LoadingBlock />
  if (list.error) return <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
  if (list.items.length === 0) return <EmptyBlock label="无素材" />
  return (
    <Card className="px-4">
      {list.items.map((m) => (
        <MaterialCard key={m.id} m={m} showOrder={false} onOpenImage={onOpenImage} />
      ))}
      <LoadMore
        hasNext={!!list.hasNextPage}
        loading={list.isFetchingNextPage}
        onLoad={() => void list.fetchNextPage()}
      />
    </Card>
  )
}

function KV2({ k, v }: { k: string; v: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <div className="text-xs text-fg-subtle">{k}</div>
      <div className="break-all">{v}</div>
    </div>
  )
}

function CallsTab({ empId }: { empId: number }): React.JSX.Element {
  const list = useCursorQuery(['employee-calls', empId], (cursor) => adminApi.employeeCalls(empId, cursor))
  return (
    <div>
      {list.isLoading ? (
        <LoadingBlock />
      ) : list.error ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : list.items.length === 0 ? (
        <EmptyBlock label="无通话" />
      ) : (
        <Card className="px-4">
          {list.items.map((c) => (
            <CallCard key={c.id} c={c} />
          ))}
          <LoadMore
            hasNext={!!list.hasNextPage}
            loading={list.isFetchingNextPage}
            onLoad={() => void list.fetchNextPage()}
          />
        </Card>
      )}
    </div>
  )
}

// ── 小工具 ──
function RowKV({ k, v }: { k: string; v: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-fg-muted">{k}</span>
      <span>{v}</span>
    </div>
  )
}
function DotText({ ok, on, off }: { ok: boolean; on: string; off: string }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Dot color={ok ? 'green' : 'gray'} />
      {ok ? on : off}
    </span>
  )
}
function Stat({ n, label }: { n: number; label: string }): React.JSX.Element {
  return (
    <div>
      <div className="text-2xl font-semibold tabular-nums">{n}</div>
      <div className="text-xs text-fg-muted">{label}</div>
    </div>
  )
}
