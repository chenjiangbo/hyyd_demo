import { useEffect, useMemo, useState } from 'react'
import { fetchOrders, type Order } from '../api'
import {
  LANES,
  LANE_ACCENT,
  laneOf,
  bizType,
  bizChipClass,
  sourceLabel,
  sourceStyle,
  relativeTime,
  monthDay,
  type LaneKey
} from '../lib/orderMapping'

/** 性别图标：泰康 sex 1=男 2=女（兼容 男/女、M/F），取不到返回 null */
function genderOf(order: Order): 'male' | 'female' | null {
  const raw = (order.rawJson ?? {}) as Record<string, unknown>
  const s = String(raw.sex ?? '').trim().toUpperCase()
  if (s === '1' || s === '男' || s === 'M') return 'male'
  if (s === '2' || s === '女' || s === 'F') return 'female'
  return null
}

type View = 'board' | 'list'
export type ApplicationGroup = {
  key: string
  applicationNo: string | null
  customerName: string
  orders: Order[]
  primary: Order
  updatedAt: string
}

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
    raw.crmApplyNo,
    raw.applyNo,
    raw.subOrderNo,
    raw.orderId
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
  return [...new Set(values.map((v) => v.trim()))]
}

function applicationNoOf(order: Order): string | null {
  const raw = (order.rawJson ?? {}) as Record<string, unknown>
  return typeof raw.crmApplyNo === 'string' && raw.crmApplyNo.trim() ? raw.crmApplyNo.trim() : null
}

function tail8(no: string | null): string | null {
  if (!no) return null
  const compact = no.replace(/\s+/g, '')
  return compact.length >= 8 ? compact.slice(-8) : null
}

function groupOrdersByApplication(orders: Order[]): ApplicationGroup[] {
  const map = new Map<string, Order[]>()
  for (const order of orders) {
    const applicationNo = applicationNoOf(order)
    const key = applicationNo ?? `order:${order.id}`
    const arr = map.get(key) ?? []
    arr.push(order)
    map.set(key, arr)
  }
  return [...map.entries()]
    .map(([key, list]) => {
      const sorted = [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      const primary = sorted[0]
      return {
        key,
        applicationNo: applicationNoOf(primary),
        customerName: primary.customerName,
        orders: sorted,
        primary,
        updatedAt: primary.updatedAt
      }
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

function groupLaneOf(group: ApplicationGroup): LaneKey {
  const priority: LaneKey[] = ['await_backfill', 'doing', 'todo', 'done']
  for (const lane of priority) {
    if (group.orders.some((order) => laneOf(order) === lane)) return lane
  }
  return laneOf(group.primary)
}

function dedupeServices(orders: Order[]): Array<{ label: string; count: number; order: Order }> {
  const map = new Map<string, { label: string; count: number; order: Order }>()
  for (const order of orders) {
    const label = bizType(order)
    const existing = map.get(label)
    if (existing) existing.count += 1
    else map.set(label, { label, count: 1, order })
  }
  return [...map.values()]
}

export default function WorkbenchKanban({
  employeeCode,
  query,
  onOpenApplication
}: {
  employeeCode: string
  query: string
  onOpenApplication: (group: ApplicationGroup) => void
}): React.JSX.Element {
  const [orders, setOrders] = useState<Order[]>(() => getCachedOrders(employeeCode) ?? [])
  const [loading, setLoading] = useState(getCachedOrders(employeeCode) === null)
  const [error, setError] = useState<string | null>(null)
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
  const boardGroups = useMemo(() => groupOrdersByApplication(boardOrders), [boardOrders])
  const filteredGroups = useMemo(() => groupOrdersByApplication(filtered), [filtered])

  // 类型筛选只平铺前 4 个，其余收进「更多」；当前选中的若在溢出里，提到可见区，保证激活态可见
  const { visibleTypes, overflowTypes } = useMemo(() => {
    const VISIBLE = 4
    let visible = typeTags.slice(0, VISIBLE)
    let overflow = typeTags.slice(VISIBLE)
    if (typeFilter !== 'all') {
      const i = overflow.findIndex((t) => t.label === typeFilter)
      if (i >= 0) {
        const sel = overflow[i]
        overflow = [visible[visible.length - 1], ...overflow.slice(0, i), ...overflow.slice(i + 1)]
        visible = [...visible.slice(0, VISIBLE - 1), sel]
      }
    }
    return { visibleTypes: visible, overflowTypes: overflow }
  }, [typeTags, typeFilter])

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 工具条（对齐原型）：标题左 · 右侧 类型筛选(+更多) + 视图切换 + 新建 */}
      <div className="shrink-0 bg-white border-b border-border-subtle px-6 py-4 flex items-center justify-between gap-4">
        <h2 className="text-h2-header text-text-main shrink-0">工作台</h2>
        <div className="flex items-center gap-4 min-w-0">
          {/* 类型筛选：全部 + 前 4 个类型 + 更多 */}
          <div className="flex items-center gap-2 min-w-0">
            <TypeTag label="全部" count={orders.length} on={typeFilter === 'all'} onClick={() => setTypeFilter('all')} />
            {visibleTypes.map((t) => (
              <TypeTag
                key={t.label}
                label={t.label}
                count={t.count}
                on={typeFilter === t.label}
                onClick={() => setTypeFilter(t.label)}
              />
            ))}
            {overflowTypes.length > 0 && (
              <MoreFilters items={overflowTypes} active={typeFilter} onPick={setTypeFilter} />
            )}
          </div>
          {/* 视图切换：列表 / 看板 */}
          <div className="flex bg-surface-container-low rounded-lg p-1 shrink-0">
            {(['list', 'board'] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={
                  'flex items-center gap-2 px-4 py-1.5 rounded text-body-md transition-colors ' +
                  (view === v
                    ? 'bg-white shadow-sm text-primary font-medium'
                    : 'text-on-surface-variant hover:bg-surface-container')
                }
              >
                <span className="material-symbols-outlined text-[18px]">
                  {v === 'board' ? 'view_kanban' : 'list'}
                </span>
                {v === 'board' ? '看板' : '列表'}
              </button>
            ))}
          </div>
        </div>
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
        <BoardView groups={boardGroups} onOpen={onOpenApplication} />
      ) : (
        <ListView groups={filteredGroups} onOpen={onOpenApplication} />
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
        'px-3 py-1.5 rounded-lg text-body-sm transition-colors flex items-center gap-1.5 shrink-0 whitespace-nowrap border ' +
        (on
          ? 'bg-primary text-white border-primary'
          : 'bg-white border-border-subtle text-on-surface-variant hover:bg-surface-container-low')
      }
    >
      {label}
      <span
        className={
          'px-1.5 rounded text-[11px] leading-5 ' + (on ? 'bg-white/20 text-white' : 'bg-surface-variant text-on-surface')
        }
      >
        {count}
      </span>
    </button>
  )
}

// 「更多」筛选下拉：收纳前 4 个之外的订单类型
function MoreFilters({
  items,
  active,
  onPick
}: {
  items: { label: string; count: number }[]
  active: string
  onPick: (label: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const activeInHere = items.some((t) => t.label === active)
  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className={
          'px-3 py-1.5 rounded-lg text-body-sm transition-colors flex items-center gap-1 border ' +
          (activeInHere
            ? 'bg-primary text-white border-primary'
            : 'bg-white border-border-subtle text-on-surface-variant hover:bg-surface-container-low')
        }
      >
        <span className="material-symbols-outlined text-[16px]">filter_list</span>
        更多
        <span className="material-symbols-outlined text-[16px]">{open ? 'arrow_drop_up' : 'arrow_drop_down'}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 bg-white border border-border-subtle rounded-lg shadow-lg py-1 min-w-40 max-h-72 overflow-auto">
            {items.map((t) => (
              <button
                key={t.label}
                onClick={() => {
                  onPick(t.label)
                  setOpen(false)
                }}
                className={
                  'w-full text-left px-3 py-1.5 text-body-sm flex items-center justify-between gap-3 hover:bg-surface-container-low ' +
                  (t.label === active ? 'text-primary font-medium' : 'text-text-main')
                }
              >
                <span className="truncate">{t.label}</span>
                <span className="text-[11px] text-text-muted bg-surface-variant px-1.5 rounded">{t.count}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ─── 看板视图 ──────────────────────────────────────────
function BoardView({ groups, onOpen }: { groups: ApplicationGroup[]; onOpen: (group: ApplicationGroup) => void }): React.JSX.Element {
  const grouped = useMemo(() => {
    const g: Record<LaneKey, ApplicationGroup[]> = { todo: [], doing: [], await_backfill: [], done: [] }
    for (const group of groups) g[groupLaneOf(group)].push(group)
    return g
  }, [groups])

  return (
    <div className="flex-1 min-h-0 overflow-hidden p-6 bg-surface-bg flex gap-4">
      {LANES.map((lane) => {
        const items = grouped[lane.key]
        const isAi = lane.key === 'await_backfill'
        return (
          <div
            key={lane.key}
            className={
              'flex-1 min-w-0 flex flex-col h-full min-h-0 bg-surface-container-low rounded-xl border border-border-subtle ' +
              (lane.key === 'done' ? 'opacity-80 hover:opacity-100 transition-opacity' : '')
            }
          >
            <div className="p-3 border-b border-border-subtle flex justify-between items-center shrink-0 rounded-t-xl">
              <h3 className="text-h3-title flex items-center gap-2 text-text-main">
                {isAi ? (
                  <span className="material-symbols-outlined filled text-ai-purple text-[18px]">smart_toy</span>
                ) : (
                  <span className={'w-2 h-2 rounded-full ' + lane.dotClass} />
                )}
                {lane.label}
              </h3>
              <span className="text-body-sm text-text-muted bg-surface-variant px-2 py-0.5 rounded">{items.length}</span>
            </div>

            <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-3 min-h-0">
              {items.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-text-muted/50 py-8">
                  <span className="material-symbols-outlined text-[48px] mb-2">
                    {isAi ? 'smart_toy' : 'inventory_2'}
                  </span>
                  <p className="text-body-sm">{isAi ? 'AI 提取完成的订单会出现在这里' : '暂无'}</p>
                </div>
              ) : (
                items.map((group) => (
                  <ApplicationCard key={group.key} group={group} lane={lane.key} onOpen={onOpen} />
                ))
              )}
            </div>
          </div>
        )
      })}
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

function ApplicationCopyButtons({
  applicationNo,
  className
}: {
  applicationNo: string | null
  className?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState<string | null>(null)
  const tail = tail8(applicationNo)

  const copy = (value: string): void => {
    void navigator.clipboard?.writeText(value)
    setCopied(value)
    setTimeout(() => setCopied(null), 1200)
  }

  if (!applicationNo) {
    return <span className={'text-text-muted ' + (className || '')}>无申请号</span>
  }

  return (
    <div className={'inline-flex items-center gap-1 min-w-0 ' + (className || '')}>
      <button
        type="button"
        title={`点击复制完整申领号 ${applicationNo}`}
        onClick={(e) => {
          e.stopPropagation()
          copy(applicationNo)
        }}
        className="inline-flex items-center min-w-0 hover:text-primary transition-colors"
      >
        <span className="truncate font-mono-data">{applicationNo}</span>
      </button>
      {tail && (
        <button
          type="button"
          title={`复制申领号尾 8 位 ${tail}`}
          onClick={(e) => {
            e.stopPropagation()
            copy(tail)
          }}
          className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded hover:bg-surface-container-low text-text-muted hover:text-trust-blue transition-colors"
        >
          <span className={'material-symbols-outlined ' + (copied === tail ? 'text-action-green' : '')} style={{ fontSize: '14px' }}>
            {copied === tail ? 'check' : 'content_copy'}
          </span>
        </button>
      )}
    </div>
  )
}

function ApplicationCard({
  group,
  lane,
  onOpen
}: {
  group: ApplicationGroup
  lane: LaneKey
  onOpen: (group: ApplicationGroup) => void
}): React.JSX.Element {
  const primary = group.primary
  const services = dedupeServices(group.orders)
  const visibleServices = services.slice(0, 4)
  const hiddenCount = Math.max(0, services.length - visibleServices.length)
  const totalMaterials = group.orders.reduce((sum, order) => sum + (order.materialCount || 0), 0)
  const gender = genderOf(primary)
  const origin = sourceStyle(primary)

  return (
    <div
      onClick={() => onOpen(group)}
      className={
        'bg-white border border-border-subtle border-l-2 rounded-lg p-compact-padding flex flex-col shadow-sm cursor-pointer hover:border-outline-variant transition-colors group ' +
        LANE_ACCENT[lane]
      }
    >
      {/* 申领号 + 来源 */}
      <div className="flex justify-between items-start gap-2 mb-2">
        <ApplicationCopyButtons applicationNo={group.applicationNo} className="text-data-mono font-data-mono text-on-surface-variant min-w-0" />
        <span className={'shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ' + origin.bg + ' ' + origin.text}>
          {origin.label}
        </span>
      </div>

      {/* 客户名 + 多订单标识 + 服务类型 */}
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <h4 className="text-h3-title text-text-main truncate">{group.customerName}</h4>
          {group.orders.length > 1 && (
            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-alert-orange/10 text-alert-orange font-medium">
              {group.orders.length} 个订单
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1 mb-2">
        {visibleServices.map((service) => (
          <span
            key={service.label}
            className={'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ' + bizChipClass(service.order)}
          >
            {service.label}
            {service.count > 1 ? ` x${service.count}` : ''}
          </span>
        ))}
        {hiddenCount > 0 && (
          <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] text-text-muted bg-surface-container-low">
            +{hiddenCount}
          </span>
        )}
      </div>

      {/* 医院 · 科室 */}
      {primary.hospital && (
        <p className="text-body-sm text-on-surface-variant flex items-center gap-1 mb-0.5 min-w-0">
          <span className="material-symbols-outlined shrink-0 text-[14px]">local_hospital</span>
          <span className="truncate">
            {primary.hospital}
            {primary.dept ? ` · ${primary.dept}` : ''}
          </span>
        </p>
      )}

      {/* 手机号（可复制） */}
      <Copyable value={primary.customerPhone || ''} className="text-body-sm text-on-surface-variant min-w-0">
        <span className="material-symbols-outlined shrink-0 text-[14px]">phone_iphone</span>
        <span className="truncate font-mono-data">{primary.customerPhone || '—'}</span>
      </Copyable>

      {/* 底部：日期 + 素材数 + 性别 */}
      <div className="border-t border-border-subtle pt-2 mt-2 flex justify-between items-center text-[10px] text-outline">
        <span>{monthDay(group.updatedAt)}</span>
        <div className="flex items-center gap-2">
          {totalMaterials > 0 && (
            <span className="text-body-sm text-on-surface-variant flex items-center gap-0.5">
              <span className="material-symbols-outlined text-[12px]">attach_file</span>
              {totalMaterials}
            </span>
          )}
          {gender && (
            <span
              className={
                'w-4 h-4 rounded-full flex items-center justify-center border ' +
                (gender === 'male'
                  ? 'bg-blue-100 text-blue-600 border-blue-200'
                  : 'bg-pink-100 text-pink-600 border-pink-200')
              }
            >
              <span className="material-symbols-outlined text-[12px]">{gender}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── 列表视图（密集、可排序、可按泳道筛选）──────────────
type SortKey = 'customerName' | 'hospital' | 'status' | 'updatedAt'

function ListView({ groups, onOpen }: { groups: ApplicationGroup[]; onOpen: (group: ApplicationGroup) => void }): React.JSX.Element {
  const [laneFilter, setLaneFilter] = useState<LaneKey | 'all'>('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'updatedAt', dir: 'desc' })

  // 各泳道计数（用于筛选条徽标）
  const laneCounts = useMemo(() => {
    const c: Record<LaneKey, number> = { todo: 0, doing: 0, await_backfill: 0, done: 0 }
    for (const group of groups) c[groupLaneOf(group)]++
    return c
  }, [groups])

  const rows = useMemo(() => {
    let r = laneFilter === 'all' ? groups : groups.filter((group) => groupLaneOf(group) === laneFilter)
    const dir = sort.dir === 'asc' ? 1 : -1
    r = [...r].sort((a, b) => {
      const av = sort.key === 'updatedAt' ? a.updatedAt : (a.primary[sort.key] ?? '')
      const bv = sort.key === 'updatedAt' ? b.updatedAt : (b.primary[sort.key] ?? '')
      const va = String(av)
      const vb = String(bv)
      return va < vb ? -dir : va > vb ? dir : 0
    })
    return r
  }, [groups, laneFilter, sort])

  function toggleSort(key: SortKey): void {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }

  const FILTERS: { key: LaneKey | 'all'; label: string; count: number }[] = [
    { key: 'all', label: '全部', count: groups.length },
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
              <th className="py-2 px-3 font-medium">申领号</th>
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
              rows.map((group) => {
                const o = group.primary
                const services = dedupeServices(group.orders)
                return (
                <tr
                  key={group.key}
                  onClick={() => onOpen(group)}
                  className="border-b border-border-subtle hover:bg-white cursor-pointer transition-colors"
                >
                  <td className="py-2 px-3 font-medium text-text-main whitespace-nowrap">{o.customerName}</td>
                  <td className="py-2 px-3 text-text-muted max-w-[220px]">
                    <ApplicationCopyButtons applicationNo={group.applicationNo} className="max-w-full" />
                  </td>
                  <td className="py-2 px-3 text-text-muted font-mono-data whitespace-nowrap">{o.customerPhone || '—'}</td>
                  <td className="py-2 px-3">
                    <div className="flex flex-wrap gap-1 min-w-[160px]">
                      {services.slice(0, 4).map((service) => (
                        <span key={service.label} className={'text-label-caps px-2 py-0.5 rounded ' + bizChipClass(service.order)}>
                          {service.label}{service.count > 1 ? ` x${service.count}` : ''}
                        </span>
                      ))}
                      {services.length > 4 && (
                        <span className="text-label-caps px-2 py-0.5 rounded bg-surface-bg text-text-muted">
                          +{services.length - 4}
                        </span>
                      )}
                    </div>
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
                )
              })
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
