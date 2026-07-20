import { useEffect, useMemo, useState } from 'react'
import { fetchOrderDetail, fetchOrders, type Order } from '../api'
import {
  LANES,
  LANE_ACCENT,
  laneOf,
  stageIndexOf,
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
  poolEnteredAt: string
}

const REFRESH_INTERVAL_MS = 30_000
const BOARD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

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
      cachedOrders = list
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

function stringField(raw: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function patientRegionFromRecords(...records: Array<Record<string, unknown> | null | undefined>): string | null {
  for (const raw of records) {
    if (!raw) continue
    const province = stringField(raw, ['intendProvince', 'patientProvince', 'paProvince', 'province'])
    const city = stringField(raw, ['intendCity', 'patientCity', 'paCity', 'city'])
    const district = stringField(raw, ['intendDistrict', 'patientDistrict', 'paDistrict', 'district', 'area'])
    const region = [province, city, district].filter(Boolean).join('')
    if (region) return region
  }
  return null
}

function patientRegionOf(order: Order): string | null {
  return patientRegionFromRecords((order.rawJson ?? {}) as Record<string, unknown>)
}

function displayCustomerNameOf(order: Order): string {
  const raw = (order.rawJson ?? {}) as Record<string, unknown>
  return stringField(raw, ['patientName', 'paName', 'customerName', 'name', 'patName']) ?? order.customerName
}

function poolEnteredAtOf(order: Order): string {
  const raw = (order.rawJson ?? {}) as Record<string, unknown>
  return stringField(raw, ['applyDate']) ?? order.claimedAt ?? order.createdAt ?? order.updatedAt
}

function timeValue(value: string | null | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
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
      const sorted = [...list].sort((a, b) => timeValue(poolEnteredAtOf(b)) - timeValue(poolEnteredAtOf(a)))
      const primary = sorted[0]
      return {
        key,
        applicationNo: applicationNoOf(primary),
        customerName: displayCustomerNameOf(primary),
        orders: sorted,
        primary,
        updatedAt: primary.updatedAt,
        poolEnteredAt: poolEnteredAtOf(primary)
      }
    })
    .sort((a, b) => timeValue(b.poolEnteredAt) - timeValue(a.poolEnteredAt))
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

function groupProgress(group: ApplicationGroup): number {
  const maxStage = Math.max(...group.orders.map(stageIndexOf))
  return Math.min(100, Math.max(20, ((maxStage + 1) / 5) * 100))
}

function groupStage(group: ApplicationGroup): number {
  return Math.max(...group.orders.map(stageIndexOf))
}

function progressColorClass(stage: number): string {
  if (stage <= 1) return 'bg-status-urgent'
  if (stage === 2) return 'bg-status-info'
  if (stage === 3) return 'bg-ai-purple'
  return 'bg-status-success'
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
  const [detailRegions, setDetailRegions] = useState<Record<string, string | null>>({})

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
  const boardGroupKeys = useMemo(() => boardGroups.map((group) => group.key).join('|'), [boardGroups])

  useEffect(() => {
    const missing = boardGroups.filter((group) => {
      if (group.orders.some((order) => patientRegionOf(order))) return false
      return detailRegions[group.key] === undefined
    })
    if (missing.length === 0) return

    let alive = true
    void Promise.all(
      missing.slice(0, 20).map(async (group) => {
        try {
          const detail = await fetchOrderDetail(group.primary.id)
          const region = patientRegionFromRecords(
            (detail.order.rawJson ?? {}) as Record<string, unknown>,
            detail.detail?.recommendations as Record<string, unknown> | null | undefined
          )
          return [group.key, region] as const
        } catch {
          return [group.key, null] as const
        }
      })
    ).then((items) => {
      if (!alive) return
      setDetailRegions((prev) => {
        const next = { ...prev }
        for (const [key, region] of items) next[key] = region
        return next
      })
    })

    return () => {
      alive = false
    }
  }, [boardGroupKeys, boardGroups, detailRegions])

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
        <BoardView groups={boardGroups} detailRegions={detailRegions} onOpen={onOpenApplication} />
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
function BoardView({
  groups,
  detailRegions,
  onOpen
}: {
  groups: ApplicationGroup[]
  detailRegions: Record<string, string | null>
  onOpen: (group: ApplicationGroup) => void
}): React.JSX.Element {
  const grouped = useMemo(() => {
    const g: Record<LaneKey, ApplicationGroup[]> = { todo: [], doing: [], await_backfill: [], done: [] }
    for (const group of groups) g[groupLaneOf(group)].push(group)
    for (const key of Object.keys(g) as LaneKey[]) {
      g[key].sort((a, b) => timeValue(b.poolEnteredAt) - timeValue(a.poolEnteredAt))
    }
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
                  <ApplicationCard
                    key={group.key}
                    group={group}
                    lane={lane.key}
                    detailRegion={detailRegions[group.key] ?? null}
                    onOpen={onOpen}
                  />
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
          'material-symbols-outlined shrink-0 transition-colors ' +
          (copied ? 'text-action-green' : 'text-[#7b8aa0] group-hover:text-trust-blue')
        }
        style={{ fontSize: '12px' }}
      >
        {copied ? 'check' : 'content_copy'}
      </span>
    </button>
  )
}

function ApplicationCopyButtons({
  applicationNo,
  customerName,
  className
}: {
  applicationNo: string | null
  customerName: string
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
      <span className="truncate font-mono-data">{applicationNo}</span>
      <IconCopyButton
        icon="content_copy"
        title={`复制完整申领号 ${applicationNo}`}
        copied={copied === applicationNo}
        onClick={(e) => {
          e.stopPropagation()
          copy(applicationNo)
        }}
      />
      {tail && (
        <IconCopyButton
          icon="tag"
          title={`复制 ${customerName}#${tail}`}
          copied={copied === `${customerName}#${tail}`}
          onClick={(e) => {
            e.stopPropagation()
            copy(`${customerName}#${tail}`)
          }}
        />
      )}
    </div>
  )
}

function IconCopyButton({
  icon,
  title,
  copied,
  onClick
}: {
  icon: 'content_copy' | 'tag'
  title: string
  copied: boolean
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-md bg-white/70 border border-border-subtle text-[#6f7f95] hover:bg-primary-fixed hover:text-primary hover:border-primary-fixed-dim transition-colors"
    >
      {copied ? (
        <span className="material-symbols-outlined text-action-green" style={{ fontSize: '12px' }}>check</span>
      ) : icon === 'tag' ? (
        <span className="text-[11px] leading-none font-black">#</span>
      ) : (
        <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>content_copy</span>
      )}
    </button>
  )
}

function GenderIcon({ gender }: { gender: 'male' | 'female' }): React.JSX.Element {
  return (
    <span
      className={
        'shrink-0 w-4 h-4 rounded-full inline-flex items-center justify-center border ' +
        (gender === 'male'
          ? 'bg-blue-50 text-blue-600 border-blue-100'
          : 'bg-pink-50 text-pink-600 border-pink-100')
      }
      title={gender === 'male' ? '男' : '女'}
    >
      <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>{gender}</span>
    </span>
  )
}

function MoreServices({
  items
}: {
  items: Array<{ label: string; count: number; order: Order }>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        title="查看更多服务类型"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        className="inline-flex items-center justify-center w-6 h-5 rounded text-text-muted bg-surface-container-low hover:bg-surface-container hover:text-primary"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>more_horiz</span>
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={(e) => {
              e.stopPropagation()
              setOpen(false)
            }}
          />
          <div
            className="absolute left-0 bottom-full mb-1 z-50 min-w-36 max-w-56 rounded-lg border border-border-subtle bg-white shadow-lg py-1"
            onClick={(e) => e.stopPropagation()}
          >
            {items.map((service) => (
              <div key={service.label} className="px-2.5 py-1.5 text-body-sm text-text-main flex items-center justify-between gap-3">
                <span className="truncate">{service.label}</span>
                {service.count > 1 && <span className="text-[11px] text-text-muted">x{service.count}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function ApplicationCard({
  group,
  lane,
  detailRegion,
  onOpen
}: {
  group: ApplicationGroup
  lane: LaneKey
  detailRegion: string | null
  onOpen: (group: ApplicationGroup) => void
}): React.JSX.Element {
  const primary = group.primary
  const displayName = group.customerName
  const services = dedupeServices(group.orders)
  const visibleServices = services.slice(0, 4)
  const hiddenCount = Math.max(0, services.length - visibleServices.length)
  const hiddenServices = services.slice(4)
  const gender = genderOf(primary)
  const origin = sourceStyle(primary)
  const region = group.orders.map(patientRegionOf).find(Boolean) ?? detailRegion
  const isDoing = lane === 'doing'
  const stage = groupStage(group)
  const progress = groupProgress(group)

  return (
    <div
      onClick={() => onOpen(group)}
      className={
        'bg-white rounded-lg px-3 py-2.5 flex flex-col shadow-sm cursor-pointer hover:shadow-md transition-all group ' +
        (isDoing ? 'border-2 border-primary' : 'border border-border-subtle border-l-2 hover:border-outline-variant ' + LANE_ACCENT[lane])
      }
    >
      {/* 申领号 + 来源 */}
      <div className="flex items-center gap-2 mb-2 rounded-md bg-surface-bg border border-border-subtle px-2 py-1">
        <ApplicationCopyButtons
          applicationNo={group.applicationNo}
          customerName={displayName}
          className="text-data-mono font-data-mono text-[#536174] min-w-0 flex-1"
        />
        <span className={'shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ' + origin.bg + ' ' + origin.text}>
          {origin.label}
        </span>
      </div>

      {/* 客户名 + 性别 + 多订单标识 */}
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <h4 className="text-h3-title text-text-main truncate">{displayName}</h4>
          {gender && <GenderIcon gender={gender} />}
          {group.orders.length > 1 && (
            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-alert-orange/10 text-alert-orange font-medium">
              {group.orders.length} 个订单
            </span>
          )}
        </div>
        {region && (
          <span className="inline-flex items-center justify-end gap-0.5 min-w-0 max-w-[104px] text-[11px] text-[#6d7c91] text-right">
            <span className="material-symbols-outlined shrink-0 text-[#6b8fc7]" style={{ fontSize: '11px' }}>location_on</span>
            <span className="truncate">{region}</span>
          </span>
        )}
      </div>

      <div className="space-y-1">
        {/* 医院 · 科室 */}
        {primary.hospital && (
          <p className="text-body-sm text-[#536174] flex items-center gap-1.5 min-w-0">
            <span className="material-symbols-outlined shrink-0 text-[#6b8fc7]" style={{ fontSize: '12px' }}>domain</span>
            <span className="truncate">
              {primary.hospital}
              {primary.dept ? ` · ${primary.dept}` : ''}
            </span>
          </p>
        )}

        {/* 手机号 + 日期 */}
        <div className="flex items-center justify-between gap-2">
          <Copyable value={primary.customerPhone || ''} className="text-body-sm text-[#536174] min-w-0">
            <span className="material-symbols-outlined shrink-0 text-[#6b8fc7]" style={{ fontSize: '12px' }}>call</span>
            <span className="truncate font-mono-data">{primary.customerPhone || '—'}</span>
          </Copyable>
          <span className="shrink-0 text-[11px] text-[#7b8aa0] text-right" title={group.poolEnteredAt}>{monthDay(group.poolEnteredAt)}</span>
        </div>
      </div>

      {isDoing && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-variant">
          <div className={'h-full rounded-full ' + progressColorClass(stage)} style={{ width: `${progress}%` }} />
        </div>
      )}

      {/* 底部：服务类型 */}
      <div className="border-t border-border-subtle pt-1.5 mt-1.5 flex flex-wrap gap-1">
        {visibleServices.map((service) => (
          <span
            key={service.label}
            className={'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ' + bizChipClass(service.order)}
          >
            {service.label}
            {service.count > 1 ? ` x${service.count}` : ''}
          </span>
        ))}
        {hiddenCount > 0 && <MoreServices items={hiddenServices} />}
      </div>
    </div>
  )
}

// ─── 列表视图（密集、可排序、可按泳道筛选）──────────────
type SortKey = 'customerName' | 'hospital' | 'status' | 'poolEnteredAt'

function ListView({ groups, onOpen }: { groups: ApplicationGroup[]; onOpen: (group: ApplicationGroup) => void }): React.JSX.Element {
  const [laneFilter, setLaneFilter] = useState<LaneKey | 'all'>('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'poolEnteredAt', dir: 'desc' })

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
      if (sort.key === 'poolEnteredAt') {
        return (timeValue(a.poolEnteredAt) - timeValue(b.poolEnteredAt)) * dir
      }
      const av = a.primary[sort.key] ?? ''
      const bv = b.primary[sort.key] ?? ''
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
  const activeFilter = FILTERS.find((f) => f.key === laneFilter) ?? FILTERS[0]

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-surface-bg">
      <div className="shrink-0 px-6 py-4 flex items-center justify-between gap-4">
        <div>
          <h3 className="text-h3-title text-text-main">申请列表</h3>
          <p className="mt-0.5 text-body-sm text-text-muted">按申请号查看全部工作台记录</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={laneFilter}
            onChange={(e) => setLaneFilter(e.target.value as LaneKey | 'all')}
            className="h-10 rounded-md border border-border-subtle bg-white px-3 text-body-md text-text-main shadow-sm focus:outline-none focus:border-primary"
            title="阶段筛选"
          >
            {FILTERS.map((f) => (
              <option key={f.key} value={f.key}>{f.label}（{f.count}）</option>
            ))}
          </select>
          <select
            value={`${sort.key}:${sort.dir}`}
            onChange={(e) => {
              const [key, dir] = e.target.value.split(':') as [SortKey, 'asc' | 'desc']
              setSort({ key, dir })
            }}
            className="h-10 rounded-md border border-border-subtle bg-white px-3 text-body-md text-text-main shadow-sm focus:outline-none focus:border-primary"
            title="排序"
          >
            <option value="poolEnteredAt:desc">入池时间 新到旧</option>
            <option value="poolEnteredAt:asc">入池时间 旧到新</option>
            <option value="customerName:asc">客户 A-Z</option>
            <option value="hospital:asc">医院 A-Z</option>
          </select>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto px-6 pb-5">
        <div className="overflow-hidden rounded-lg border border-border-subtle bg-white shadow-sm">
          <table className="w-full table-fixed border-collapse text-body-sm">
            <colgroup>
              <col className="w-[250px]" />
              <col className="w-[215px]" />
              <col className="w-[230px]" />
              <col className="w-[180px]" />
              <col className="w-[130px]" />
              <col className="w-[120px]" />
              <col className="w-[68px]" />
              <col className="w-[104px]" />
            </colgroup>
            <thead className="sticky top-0 bg-white z-10">
              <tr className="text-left text-[#454a5a] border-b border-border-subtle">
                <th className="py-3.5 px-5 font-bold">申领号</th>
                <SortHead label="客户" k="customerName" sort={sort} onSort={toggleSort} />
                <SortHead label="医院 / 科室" k="hospital" sort={sort} onSort={toggleSort} />
                <th className="py-3.5 px-4 font-bold">业务类型</th>
                <SortHead label="状态 / 阶段" k="status" sort={sort} onSort={toggleSort} />
                <th className="py-3.5 px-4 font-bold">数据量</th>
                <th className="py-3.5 px-3 font-bold">来源</th>
                <SortHead label="入池" k="poolEnteredAt" sort={sort} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-text-muted">
                  暂无{activeFilter.label}申请
                </td>
              </tr>
            ) : (
              rows.map((group) => {
                const o = group.primary
                const displayName = group.customerName
                const services = dedupeServices(group.orders)
                const lane = groupLaneOf(group)
                const rowAccent =
                  lane === 'todo' ? 'border-l-status-urgent' :
                    lane === 'doing' ? 'border-l-status-info' :
                      lane === 'await_backfill' ? 'border-l-ai-purple' : 'border-l-status-success'
                return (
                <tr
                  key={group.key}
                  onClick={() => onOpen(group)}
                  className={'border-b border-border-subtle border-l-2 hover:bg-surface-bg cursor-pointer transition-colors ' + rowAccent}
                >
                  <td className="py-3 px-5 text-[#161a22] font-mono-data font-semibold">
                    <ApplicationCopyButtons applicationNo={group.applicationNo} customerName={displayName} className="max-w-full" />
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 font-semibold text-text-main">{displayName}</span>
                      {o.customerPhone ? (
                        <Copyable value={o.customerPhone} className="min-w-0 text-[12px] text-[#6f7f95] font-mono-data">
                          <span className="truncate">{o.customerPhone}</span>
                        </Copyable>
                      ) : (
                        <span className="min-w-0 truncate text-[12px] text-text-muted">手机号待补</span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-4 text-[#454a5a]">
                    <div className="font-semibold truncate">
                      {o.hospital || '医院待定'}
                      <span className="mx-1 text-text-muted font-normal">/</span>
                      <span className="font-normal text-text-muted">{o.dept || '科室待定'}</span>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex flex-wrap gap-1 max-w-[160px]">
                      {services.slice(0, 3).map((service) => (
                        <span key={service.label} className={'text-[12px] leading-5 px-2 rounded font-semibold border border-current/20 ' + bizChipClass(service.order)}>
                          {service.label}{service.count > 1 ? ` x${service.count}` : ''}
                        </span>
                      ))}
                      {services.length > 3 && (
                        <span className="text-[12px] leading-5 px-2 rounded bg-surface-bg text-text-muted">
                          +{services.length - 3}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-4 whitespace-nowrap">
                    <LaneBadge order={o} />
                  </td>
                  <td className="py-3 px-4 text-[#454a5a] font-mono-data">
                    <div className="flex items-center gap-2.5">
                      <span className="inline-flex items-center gap-1" title="文本与图片数量">
                        <span className="material-symbols-outlined filled text-[#6d5dfc]" style={{ fontSize: '15px' }}>article</span>
                        {o.textCount + o.imageCount}
                      </span>
                      <span className="inline-flex items-center gap-1" title="录音数量">
                        <span className="material-symbols-outlined filled text-[#0b8fd9]" style={{ fontSize: '15px' }}>mic</span>
                        {o.audioCount}
                      </span>
                    </div>
                  </td>
                  <td className="py-3 px-3">
                    <span className={'inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ' + sourceStyle(o).bg + ' ' + sourceStyle(o).text}>
                      {sourceLabel(o)}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-[#454a5a] whitespace-nowrap" title={group.poolEnteredAt}>
                    {relativeTime(group.poolEnteredAt)}
                  </td>
                </tr>
                )
              })
            )}
          </tbody>
        </table>
        </div>
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
    <th className="py-3.5 px-4 font-bold">
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
