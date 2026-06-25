import { useEffect, useMemo, useState } from 'react'
import { fetchOrders, type Order } from '../api'
import {
  LANES,
  laneOf,
  bizType,
  bizChipClass,
  bizPalette,
  sourceLabel,
  sourceStyle,
  relativeTime,
  monthDay,
  type LaneKey
} from '../lib/orderMapping'

type View = 'board' | 'list'

const REFRESH_INTERVAL_MS = 30_000
const BOARD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

// 临时模拟：当前真实数据里没有「已完成」订单，造两张用于预览已完成卡片样式。
// 接入真实完成态数据后删除这段。
const MOCK_DONE: Order[] = [
  {
    id: -1,
    source: 'taikang',
    sourceOrderNo: 'MOCK-DONE-1',
    customerName: '赵敏',
    customerPhone: '13800001111',
    hospital: '四川大学华西医院',
    dept: '骨科',
    doctor: '',
    status: '服务完成·已回填',
    intendDate: null,
    claimedAt: '2026-06-05 10:00:00',
    updatedAt: '2026-06-08T09:00:00.000Z',
    materialCount: 5,
    audioCount: 1,
    textCount: 3,
    imageCount: 1,
    rawJson: { poolType: 'general', serviceType: '第二诊疗' }
  },
  {
    id: -2,
    source: 'pingan',
    sourceOrderNo: 'MOCK-DONE-2',
    customerName: '孙立',
    customerPhone: '13900002222',
    hospital: '上海瑞金医院',
    dept: '神经外科',
    doctor: '',
    status: '服务完成',
    intendDate: null,
    claimedAt: '2026-06-06 14:00:00',
    updatedAt: '2026-06-09T15:00:00.000Z',
    materialCount: 2,
    audioCount: 0,
    textCount: 2,
    imageCount: 0,
    rawJson: { poolType: 'general', serviceType: '住院协调' }
  }
]

let cachedOrders: Order[] | null = null
let cachedEmployeeCode: string | null = null
let inflightOrders: Promise<Order[]> | null = null
let inflightEmployeeCode: string | null = null

function getCachedOrders(employeeCode: string): Order[] | null {
  return cachedEmployeeCode === employeeCode ? cachedOrders : null
}

function loadOrders(employeeCode: string, force = false): Promise<Order[]> {
  if (!force && getCachedOrders(employeeCode)) return Promise.resolve(cachedOrders!)
  if (inflightOrders && inflightEmployeeCode === employeeCode) return inflightOrders

  let trackedRequest: Promise<Order[]>
  trackedRequest = fetchOrders()
    .then((list) => {
      cachedEmployeeCode = employeeCode
      cachedOrders = [...list, ...MOCK_DONE]
      return cachedOrders
    })
    .finally(() => {
      if (inflightOrders === trackedRequest) {
        inflightOrders = null
        inflightEmployeeCode = null
      }
    })

  inflightOrders = trackedRequest
  inflightEmployeeCode = employeeCode
  return trackedRequest
}

function isBoardVisibleOrder(order: Order): boolean {
  const updatedAt = Date.parse(order.updatedAt)
  if (!Number.isFinite(updatedAt)) return false
  return Date.now() - updatedAt <= BOARD_WINDOW_MS
}

function orderNoCandidates(o: Order): string[] {
  const raw = (o.rawJson ?? {}) as Record<string, unknown>
  const values = [
    o.sourceOrderNo,
    raw.applyNo,
    raw.crmApplyNo,
    raw.subOrderNo,
    raw.orderId
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
  return [...new Set(values.map((v) => v.trim()))]
}

function orderTail8(no: string): string | null {
  const compact = no.replace(/\s+/g, '')
  return compact.length >= 8 ? compact.slice(-8) : null
}

export default function WorkbenchKanban({
  employeeCode,
  onOpenOrder
}: {
  employeeCode: string
  onOpenOrder: (o: Order) => void
}): React.JSX.Element {
  const [orders, setOrders] = useState<Order[]>(() => getCachedOrders(employeeCode) ?? [])
  const [loading, setLoading] = useState(getCachedOrders(employeeCode) === null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<View>('board')
  const [typeFilter, setTypeFilter] = useState<string>('all')

  useEffect(() => {
    let alive = true

    function refresh(showLoading: boolean, force = false): void {
      if (showLoading) setLoading(true)
      loadOrders(employeeCode, force)
        .then((list) => alive && (setOrders(list), setError(null)))
        .catch((e) => alive && setError(e instanceof Error ? e.message : '加载失败'))
        .finally(() => alive && showLoading && setLoading(false))
    }

    refresh(getCachedOrders(employeeCode) === null)
    const timer = window.setInterval(() => refresh(false, true), REFRESH_INTERVAL_MS)

    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [employeeCode])

  // 订单类型标签（按当前订单实际出现的业务类型动态生成，带计数）
  const typeTags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const o of orders) {
      const t = bizType(o)
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count }))
  }, [orders])

  // 类型过滤失效（订单刷新后该类型已不存在）时回到全部
  useEffect(() => {
    if (typeFilter !== 'all' && !typeTags.some((t) => t.label === typeFilter)) setTypeFilter('all')
  }, [typeTags, typeFilter])

  // 搜索 + 类型过滤（客户名 / 医院 / 单号 / 手机号）
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return orders.filter((o) => {
      if (typeFilter !== 'all' && bizType(o) !== typeFilter) return false
      if (!q) return true
      return Boolean(
        o.customerName?.toLowerCase().includes(q) ||
          o.hospital?.toLowerCase().includes(q) ||
          orderNoCandidates(o).some((no) => no.toLowerCase().includes(q)) ||
          o.customerPhone?.includes(q)
      )
    })
  }, [orders, query, typeFilter])

  const boardOrders = useMemo(() => filtered.filter(isBoardVisibleOrder), [filtered])

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 工具条：搜索 + 视图切换 + 类型标签筛选 + 新建 */}
      <div className="shrink-0 bg-white border-b border-border-subtle px-6 py-3 flex items-start justify-between gap-4">
        <div className="flex gap-3 items-center flex-wrap flex-1 min-w-0">
          {/* 搜索框（收窄，给类型标签让出空间） */}
          <div className="relative w-56 shrink-0">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-[20px]">
              search
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索客户 / 医院 / 单号…"
              className="w-full pl-10 pr-3 py-2 bg-surface-bg border border-border-subtle rounded-lg text-body-md focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
            />
          </div>
          {/* 视图切换：看板 / 列表 */}
          <div className="flex items-center bg-surface-bg border border-border-subtle rounded-lg p-0.5 shrink-0">
            {(['board', 'list'] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={
                  'flex items-center gap-1 px-3 py-1.5 rounded-md text-body-sm transition-colors ' +
                  (view === v ? 'bg-white text-primary shadow-sm font-medium' : 'text-text-muted hover:text-text-main')
                }
              >
                <span className="material-symbols-outlined text-[18px]">
                  {v === 'board' ? 'view_kanban' : 'view_list'}
                </span>
                {v === 'board' ? '看板' : '列表'}
              </button>
            ))}
          </div>
          {/* 订单类型标签筛选（动态、可换行） */}
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <TypeTag label="全部" count={orders.length} on={typeFilter === 'all'} onClick={() => setTypeFilter('all')} />
            {typeTags.map((t) => (
              <TypeTag
                key={t.label}
                label={t.label}
                count={t.count}
                on={typeFilter === t.label}
                onClick={() => setTypeFilter(t.label)}
              />
            ))}
          </div>
        </div>
        <button className="shrink-0 bg-primary text-white px-4 py-2 rounded-lg text-body-md font-medium hover:opacity-90 transition-opacity flex items-center gap-1.5">
          <span className="material-symbols-outlined filled text-[18px]">add</span>
          新建工单
        </button>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-text-muted gap-2">
          <span className="material-symbols-outlined animate-spin">progress_activity</span>
          加载订单中…
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center text-error gap-2">
          <span className="material-symbols-outlined">error</span>
          {error}
        </div>
      ) : view === 'board' ? (
        <BoardView orders={boardOrders} onOpen={onOpenOrder} />
      ) : (
        <ListView orders={filtered} onOpen={onOpenOrder} />
      )}
    </div>
  )
}

// 订单类型筛选标签（pill）
function TypeTag({
  label,
  count,
  on,
  onClick
}: {
  label: string
  count: number
  on: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={
        'px-2.5 py-1 rounded-full text-body-sm transition-colors flex items-center gap-1 shrink-0 ' +
        (on
          ? 'bg-primary text-white'
          : 'bg-surface-bg border border-border-subtle text-text-muted hover:text-text-main')
      }
    >
      {label}
      <span className={'text-label-caps ' + (on ? 'opacity-80' : 'text-text-muted/60')}>{count}</span>
    </button>
  )
}

// ─── 看板视图 ──────────────────────────────────────────
function BoardView({ orders, onOpen }: { orders: Order[]; onOpen: (o: Order) => void }): React.JSX.Element {
  const grouped = useMemo(() => {
    const g: Record<LaneKey, Order[]> = { todo: [], doing: [], await_backfill: [], done: [] }
    for (const o of orders) g[laneOf(o)].push(o)
    return g
  }, [orders])

  return (
    <div className="flex-1 min-h-0 overflow-hidden p-6">
      <div className="flex gap-4 items-stretch h-full w-full">
        {LANES.map((lane) => {
          const items = grouped[lane.key]
          const isAi = lane.key === 'await_backfill'
          return (
            <div
              key={lane.key}
              className={
                'flex-1 min-w-0 flex flex-col gap-3 h-full min-h-0 ' +
                (isAi ? 'bg-secondary-fixed/30 rounded-xl p-2 border border-secondary-fixed-dim' : '') +
                (lane.key === 'done' ? ' opacity-70 hover:opacity-100 transition-opacity' : '')
              }
            >
              <div className="flex items-center justify-between px-2 shrink-0">
                <h3 className="text-h3-title flex items-center gap-2 text-text-main">
                  {isAi ? (
                    <span className="material-symbols-outlined filled text-ai-purple text-[18px]">smart_toy</span>
                  ) : (
                    <span className={'w-2 h-2 rounded-full ' + lane.dotClass} />
                  )}
                  {lane.label}
                </h3>
                <span className="text-body-sm text-text-muted bg-surface-variant px-2 py-0.5 rounded-full">
                  共 {items.length} 条（近一周）
                </span>
              </div>

              <div className="flex flex-col gap-3 overflow-y-auto pr-1 min-h-0">
                {items.length === 0 ? (
                  <div className="text-body-sm text-text-muted/70 px-2 py-6 text-center">
                    {isAi ? 'AI 提取完成的订单会出现在这里' : '暂无'}
                  </div>
                ) : (
                  items.map((o) => <OrderCard key={o.id} order={o} lane={lane.key} onOpen={onOpen} />)
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 点击复制：复制到剪贴板，短暂显示对勾；阻止冒泡以免触发卡片点击 */
function Copyable({
  value,
  className,
  children
}: {
  value: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title={`复制 ${value}`}
      onClick={(e) => {
        e.stopPropagation()
        if (!value) return
        navigator.clipboard?.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
      className={'group inline-flex items-center gap-1 hover:text-trust-blue transition-colors ' + (className || '')}
    >
      {children}
      <span
        className={
          'material-symbols-outlined shrink-0 transition-opacity ' +
          (copied ? 'opacity-100 text-action-green' : 'opacity-0 group-hover:opacity-60')
        }
        style={{ fontSize: '13px' }}
      >
        {copied ? 'check' : 'content_copy'}
      </span>
    </button>
  )
}

function OrderNoCopyMenu({
  order,
  className,
  placement = 'top'
}: {
  order: Order
  className?: string
  placement?: 'top' | 'bottom'
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const nos = orderNoCandidates(order)
  const primary = nos[0] ?? order.sourceOrderNo

  const copy = (value: string): void => {
    if (!value) return
    void navigator.clipboard?.writeText(value)
    setCopied(value)
    setTimeout(() => setCopied(null), 1200)
  }

  return (
    <div className={'relative inline-flex min-w-0 ' + (className || '')}>
      <button
        type="button"
        title="复制订单号"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        className="group inline-flex items-center gap-1 min-w-0 hover:text-trust-blue transition-colors"
      >
        <span className="material-symbols-outlined shrink-0" style={{ fontSize: '13px' }}>tag</span>
        <span className="truncate font-mono-data">{primary}</span>
        <span className="material-symbols-outlined shrink-0 opacity-60 group-hover:opacity-100" style={{ fontSize: '13px' }}>
          expand_more
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className={
              'absolute left-0 w-80 max-w-[80vw] bg-white border border-border-subtle rounded-lg shadow-lg z-50 py-1 ' +
              (placement === 'bottom' ? 'top-full mt-1' : 'bottom-full mb-1')
            }
            onClick={(e) => e.stopPropagation()}
          >
            {nos.map((no) => {
              const tail = orderTail8(no)
              const tailValue = tail ? `#${tail}` : null
              return (
                <div key={no} className="px-1 py-1 border-b border-border-subtle last:border-b-0">
                  <button
                    type="button"
                    onClick={() => copy(no)}
                    className="w-full min-w-0 px-2 py-1.5 rounded hover:bg-surface-container-low flex items-center gap-2 text-left"
                  >
                    <span className="material-symbols-outlined text-text-muted shrink-0" style={{ fontSize: '14px' }}>
                      {copied === no ? 'check' : 'content_copy'}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[11px] text-text-muted">完整订单号</span>
                      <span className="block text-body-sm font-mono-data text-text-main truncate">{no}</span>
                    </span>
                  </button>
                  {tailValue && (
                    <button
                      type="button"
                      onClick={() => copy(tailValue)}
                      className="w-full min-w-0 px-2 py-1.5 rounded hover:bg-surface-container-low flex items-center gap-2 text-left"
                    >
                      <span className="material-symbols-outlined text-text-muted shrink-0" style={{ fontSize: '14px' }}>
                        {copied === tailValue ? 'check' : 'content_copy'}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[11px] text-text-muted">备注尾号</span>
                        <span className="block text-body-sm font-mono-data text-text-main truncate">{tailValue}</span>
                      </span>
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function OrderCard({
  order: o,
  lane,
  onOpen
}: {
  order: Order
  lane: LaneKey
  onOpen: (o: Order) => void
}): React.JSX.Element {
  const isAi = lane === 'await_backfill'
  const isDone = lane === 'done'
  const palette = bizPalette(o)

  // 待结束卡片：弱化、信息聚焦在「回填/观察」状态，不再显示来源/更新时间/素材
  if (isDone) {
    const backfilled = o.status.includes('回填') || o.status.includes('归档')
    return (
      <div
        onClick={() => onOpen(o)}
        className="shrink-0 bg-surface-bg border border-border-subtle border-l-4 border-l-action-green rounded-lg px-3 py-2 flex flex-col gap-1 cursor-pointer hover:bg-white transition-colors"
      >
        <div className="flex justify-between items-center gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-body-md font-medium text-text-muted truncate">{o.customerName}</span>
            <span className="shrink-0 text-label-caps px-1.5 py-0.5 rounded bg-surface-container text-text-muted">
              {bizType(o)}
            </span>
          </div>
          <span className="material-symbols-outlined filled text-action-green shrink-0" style={{ fontSize: '16px' }}>check_circle</span>
        </div>
        {o.hospital && (
          <div className="text-body-sm text-text-muted/80 truncate">
            {o.hospital}
            {o.dept ? ` · ${o.dept}` : ''}
          </div>
        )}
        <div className="flex items-center gap-2 text-[12px] text-text-muted/80">
          <span>更新于 {monthDay(o.updatedAt)}</span>
          <span
            className={
              'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded ' +
              (backfilled ? 'text-action-green bg-action-green/10' : 'text-alert-orange bg-alert-orange/10')
            }
          >
            <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>
              {backfilled ? 'task_alt' : 'pending'}
            </span>
            {backfilled ? '已回填' : '待回填'}
          </span>
        </div>
      </div>
    )
  }

  const hexColor = palette.accent.match(/#[0-9a-f]{6}/i)?.[0]
  return (
    <div
      onClick={() => onOpen(o)}
      className={
        'shrink-0 bg-white border border-border-subtle border-l-4 rounded-lg px-3 py-2.5 flex flex-col gap-2 shadow-sm cursor-pointer transition-all relative overflow-hidden ' +
        (isAi
          ? 'border-l-ai-purple hover:shadow-[0_4px_12px_rgba(139,92,246,0.15)]'
          : palette.accent + ' hover:shadow-[0_4px_12px_rgba(0,0,0,0.08)]')
      }
    >
      {isAi && (
        <div className="absolute top-0 right-0 w-14 h-14 bg-gradient-to-bl from-ai-purple/10 to-transparent rounded-bl-full pointer-events-none" />
      )}

      {/* 行1：客户名 + 业务 chip | 右上角来源 */}
      <div className="flex justify-between items-start gap-2 relative z-10">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-body-md font-semibold truncate text-text-main">{o.customerName}</span>
          <span className={'shrink-0 text-label-caps px-1.5 py-0.5 rounded ' + bizChipClass(o)}>{bizType(o)}</span>
        </div>
        <span className={'shrink-0 text-[10px] font-medium flex items-center gap-0.5 ' + sourceStyle(o).text}>
          <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>
            verified
          </span>
          {sourceStyle(o).label}
        </span>
      </div>

      {/* 医院·科室（整行） */}
      {o.hospital && (
        <div className="flex items-center gap-1 min-w-0 relative z-10 text-body-sm text-text-muted">
          <span className="material-symbols-outlined shrink-0" style={{ color: hexColor, fontSize: '14px' }}>
            local_hospital
          </span>
          <span className="truncate">
            {o.hospital}
            {o.dept ? ` · ${o.dept}` : ''}
          </span>
        </div>
      )}

      {/* 手机号（左，可复制） · 素材数（右） */}
      <div className="flex items-center justify-between gap-2 relative z-10 text-body-sm text-text-muted">
        <Copyable value={o.customerPhone || ''} className="min-w-0">
          <span className="material-symbols-outlined shrink-0" style={{ fontSize: '14px' }}>call</span>
          <span className="truncate font-mono-data">{o.customerPhone || '—'}</span>
        </Copyable>
        {o.materialCount > 0 && (
          <span className="shrink-0 flex items-center gap-0.5 text-text-muted">
            <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>attach_file</span>
            {o.materialCount}
          </span>
        )}
      </div>

      {/* AI 核对入口（仅待确认回填） */}
      {isAi && (
        <button className="self-start text-[12px] text-trust-blue hover:underline font-medium flex items-center gap-0.5 relative z-10">
          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>fact_check</span>
          查看并核对
        </button>
      )}

      {/* 订单号（左，可复制） · 日期（恒定右下角） */}
      <div className="flex items-center justify-between gap-2 min-w-0 relative z-10 text-[11px] text-text-muted/80">
        <OrderNoCopyMenu order={o} className="min-w-0" />
        <span className="shrink-0 px-1.5 py-0.5 rounded bg-surface-bg text-text-muted">
          {monthDay(o.updatedAt)}
        </span>
      </div>
    </div>
  )
}

// ─── 列表视图（密集、可排序、可按泳道筛选）──────────────
type SortKey = 'customerName' | 'hospital' | 'status' | 'updatedAt'

function ListView({ orders, onOpen }: { orders: Order[]; onOpen: (o: Order) => void }): React.JSX.Element {
  const [laneFilter, setLaneFilter] = useState<LaneKey | 'all'>('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'updatedAt', dir: 'desc' })

  // 各泳道计数（用于筛选条徽标）
  const laneCounts = useMemo(() => {
    const c: Record<LaneKey, number> = { todo: 0, doing: 0, await_backfill: 0, done: 0 }
    for (const o of orders) c[laneOf(o)]++
    return c
  }, [orders])

  const rows = useMemo(() => {
    let r = laneFilter === 'all' ? orders : orders.filter((o) => laneOf(o) === laneFilter)
    const dir = sort.dir === 'asc' ? 1 : -1
    r = [...r].sort((a, b) => {
      const va = (a[sort.key] ?? '') as string
      const vb = (b[sort.key] ?? '') as string
      return va < vb ? -dir : va > vb ? dir : 0
    })
    return r
  }, [orders, laneFilter, sort])

  function toggleSort(key: SortKey): void {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }

  const FILTERS: { key: LaneKey | 'all'; label: string; count: number }[] = [
    { key: 'all', label: '全部', count: orders.length },
    ...LANES.map((l) => ({ key: l.key, label: l.label, count: laneCounts[l.key] }))
  ]

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 泳道筛选条 */}
      <div className="shrink-0 px-6 py-2.5 flex items-center gap-2 border-b border-border-subtle bg-surface-bg">
        {FILTERS.map((f) => {
          const on = laneFilter === f.key
          return (
            <button
              key={f.key}
              onClick={() => setLaneFilter(f.key)}
              className={
                'px-3 py-1 rounded-full text-body-sm transition-colors flex items-center gap-1.5 ' +
                (on ? 'bg-primary text-white' : 'bg-white border border-border-subtle text-text-muted hover:text-text-main')
              }
            >
              {f.label}
              <span className={'text-label-caps ' + (on ? 'opacity-80' : 'text-text-muted/70')}>{f.count}</span>
            </button>
          )
        })}
      </div>

      {/* 表格 */}
      <div className="flex-1 min-h-0 overflow-auto px-6 py-4">
        <table className="w-full border-collapse text-body-sm">
          <thead className="sticky top-0 bg-surface-bg z-10">
            <tr className="text-left text-text-muted border-b border-border-subtle">
              <SortHead label="客户" k="customerName" sort={sort} onSort={toggleSort} />
              <th className="py-2 px-3 font-medium">订单号</th>
              <th className="py-2 px-3 font-medium">手机号</th>
              <th className="py-2 px-3 font-medium">业务类型</th>
              <th className="py-2 px-3 font-medium">来源</th>
              <SortHead label="医院 · 科室" k="hospital" sort={sort} onSort={toggleSort} />
              <SortHead label="状态" k="status" sort={sort} onSort={toggleSort} />
              <th className="py-2 px-3 font-medium text-center">素材</th>
              <SortHead label="更新时间" k="updatedAt" sort={sort} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-12 text-center text-text-muted">
                  暂无订单
                </td>
              </tr>
            ) : (
              rows.map((o) => (
                <tr
                  key={o.id}
                  onClick={() => onOpen(o)}
                  className="border-b border-border-subtle hover:bg-white cursor-pointer transition-colors"
                >
                  <td className="py-2 px-3 font-medium text-text-main whitespace-nowrap">{o.customerName}</td>
                  <td className="py-2 px-3 text-text-muted max-w-[220px]">
                    <OrderNoCopyMenu order={o} placement="bottom" className="max-w-full" />
                  </td>
                  <td className="py-2 px-3 text-text-muted font-mono-data whitespace-nowrap">{o.customerPhone || '—'}</td>
                  <td className="py-2 px-3">
                    <span className={'text-label-caps px-2 py-0.5 rounded ' + bizChipClass(o)}>{bizType(o)}</span>
                  </td>
                  <td className="py-2 px-3 text-text-muted whitespace-nowrap">{sourceLabel(o)}</td>
                  <td className="py-2 px-3 text-text-muted max-w-[260px] truncate">
                    {o.hospital ? o.hospital + (o.dept ? ` - ${o.dept}` : '') : '—'}
                  </td>
                  <td className="py-2 px-3 whitespace-nowrap">
                    <LaneBadge order={o} />
                  </td>
                  <td className="py-2 px-3 text-center text-text-muted font-mono-data">
                    {o.materialCount > 0 ? o.materialCount : '—'}
                  </td>
                  <td className="py-2 px-3 text-text-muted whitespace-nowrap">{relativeTime(o.updatedAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SortHead({
  label,
  k,
  sort,
  onSort
}: {
  label: string
  k: SortKey
  sort: { key: SortKey; dir: 'asc' | 'desc' }
  onSort: (k: SortKey) => void
}): React.JSX.Element {
  const active = sort.key === k
  return (
    <th className="py-2 px-3 font-medium">
      <button onClick={() => onSort(k)} className="flex items-center gap-1 hover:text-text-main transition-colors">
        {label}
        <span className={'material-symbols-outlined text-[16px] ' + (active ? 'text-primary' : 'text-text-muted/40')}>
          {active ? (sort.dir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}
        </span>
      </button>
    </th>
  )
}

function LaneBadge({ order }: { order: Order }): React.JSX.Element {
  const key = laneOf(order)
  const lane = LANES.find((l) => l.key === key)!
  const color =
    key === 'todo'
      ? 'text-text-muted bg-surface-variant'
      : key === 'doing'
        ? 'text-primary bg-primary-container/15'
        : key === 'await_backfill'
          ? 'text-ai-purple bg-ai-purple/10'
          : 'text-action-green bg-action-green/10'
  return (
    <span className={'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-label-caps ' + color} title={order.status}>
      {lane.label}
    </span>
  )
}
