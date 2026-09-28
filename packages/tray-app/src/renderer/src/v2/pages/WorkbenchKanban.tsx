import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchOrderDetail, fetchOrders, fetchOrdersPaginated, type Order } from '../api'
import OrderReminderModal from '../components/OrderReminderModal'
import { StandardPaginationBar } from './dictionary/dictComponents'
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

export function clearOrdersCache(): void {
  cachedOrders = null
  cachedEmployeeCode = null
  inflightOrders = null
  inflightEmployeeCode = null
}

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

function groupLaneOf(group: ApplicationGroup): LaneKey | null {
  const priority: LaneKey[] = ['todo', 'doing', 'await_backfill', 'done']
  for (const lane of priority) {
    if (group.orders.some((order) => laneOf(order) === lane)) return lane
  }
  return null
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

export interface FlattenedService {
  id: string | number
  key: string
  parentOrderId: number
  isClone: boolean
  sequence: number
  applicationNo: string | null
  sourceOrderNo: string
  huanyuOrderNo?: string | null
  serviceType: string
  customerName: string
  status: string
  accountManager: string
  hospital: string
  dept: string
  doctor: string
  isAiHospital: boolean
  isAiDept: boolean
  isAiDoctor: boolean
  amount: number | null
  dataCount: { textAndImages: number; audio: number }
  source: string
  poolEnteredAt: string
  rawOrder: Order
}

function isInvalidHospital(h: string | null | undefined): boolean {
  if (!h) return true
  const s = h.trim()
  if (!s || s === '-' || s === '--') return true
  if (/^\d+$/.test(s)) return true
  // 过滤形如 "江苏省-泰州市-泰兴市" 或纯省市区的错误回填
  if (/(?:省.*市|市.*区|市.*县)/.test(s) && !/(?:医院|卫生院|诊所|中心|门诊部|妇幼|医学院)/.test(s)) return true
  if (/(?:省|市|区|县)$/.test(s) && !/(?:医院|卫生院|诊所|中心|门诊部|妇幼|医学院)/.test(s)) return true
  return false
}

export function getServicesOfGroup(group: ApplicationGroup): FlattenedService[] {
  // 查找整个申请号组内权威有效的真实医院（非省市区）
  let groupHospital = ''
  for (const order of group.orders) {
    if (order.hospital && !isInvalidHospital(order.hospital)) {
      groupHospital = order.hospital
      break
    }
    if (order.huanyuOrders) {
      const validH = order.huanyuOrders.find((h) => h.hospital && !isInvalidHospital(h.hospital))
      if (validH) {
        groupHospital = validH.hospital
        break
      }
    }
  }

  const result: FlattenedService[] = []
  for (const order of group.orders) {
    const isSelfOperated = order.source === 'huanyu' || (typeof order.sourceOrderNo === 'string' && order.sourceOrderNo.startsWith('HYDD'))
    const effectiveOrderHospital = (!isInvalidHospital(order.hospital) ? order.hospital : '') || groupHospital
    if (order.huanyuOrders && order.huanyuOrders.length > 0) {
      for (const h of order.huanyuOrders) {
        const effectiveH = (!isInvalidHospital(h.hospital) ? h.hospital : '') || effectiveOrderHospital || groupHospital
        const bNo = h.bOrderNo || (isSelfOperated ? '' : (order.bOrderNo || order.sourceOrderNo))
        const hNo = h.huanyuOrderNo || h.ddbh || order.huanyuOrderNo || (isSelfOperated ? order.sourceOrderNo : null)
        result.push({
          id: h.id,
          key: `huanyu:${h.id}`,
          parentOrderId: order.id,
          isClone: h.isClone,
          sequence: h.sequence,
          applicationNo: order.applicationNo || applicationNoOf(order),
          sourceOrderNo: bNo,
          huanyuOrderNo: hNo,
          serviceType: h.serviceName || order.serviceType || bizType(order),
          customerName: h.patientName || displayCustomerNameOf(order),
          status: h.status || order.huanyuOrderStatus || order.status,
          accountManager: h.accountManager || order.accountManager || '—',
          hospital: effectiveH,
          dept: h.dept || order.dept || '',
          doctor: h.doctor || order.doctor || '',
          isAiHospital: Boolean(order.isAiHospital && !effectiveH),
          isAiDept: Boolean(order.isAiDept && !h.dept),
          isAiDoctor: Boolean(order.isAiDoctor && !h.doctor),
          amount: h.amount ?? order.orderAmount ?? null,
          dataCount: {
            textAndImages: order.textCount + order.imageCount,
            audio: order.audioCount
          },
          source: order.source,
          poolEnteredAt: h.createdAt || poolEnteredAtOf(order),
          rawOrder: order
        })
      }
    } else {
      const bNo = isSelfOperated ? '' : (order.bOrderNo || order.sourceOrderNo)
      const hNo = order.huanyuOrderNo || (isSelfOperated ? order.sourceOrderNo : null)
      result.push({
        id: order.id,
        key: `order:${order.id}`,
        parentOrderId: order.id,
        isClone: false,
        sequence: 1,
        applicationNo: order.applicationNo || applicationNoOf(order),
        sourceOrderNo: bNo,
        huanyuOrderNo: hNo,
        serviceType: order.serviceType || bizType(order),
        customerName: displayCustomerNameOf(order),
        status: order.huanyuOrderStatus || order.status,
        accountManager: order.accountManager || '—',
        hospital: effectiveOrderHospital,
        dept: order.dept || '',
        doctor: order.doctor || '',
        isAiHospital: Boolean(order.isAiHospital && !effectiveOrderHospital),
        isAiDept: Boolean(order.isAiDept),
        isAiDoctor: Boolean(order.isAiDoctor),
        amount: order.orderAmount ?? null,
        dataCount: {
          textAndImages: order.textCount + order.imageCount,
          audio: order.audioCount
        },
        source: order.source,
        poolEnteredAt: poolEnteredAtOf(order),
        rawOrder: order
      })
    }
  }
  return result
}

export default function WorkbenchKanban({
  employeeCode,
  query,
  showAdvancedSearch = false,
  onToggleAdvancedSearch,
  onAdvancedFilterCountChange,
  onOpenApplication,
  onCreateHuanyuOrder
}: {
  employeeCode: string
  query: string
  showAdvancedSearch?: boolean
  onToggleAdvancedSearch?: (open: boolean | ((prev: boolean) => boolean)) => void
  onAdvancedFilterCountChange?: (count: number) => void
  onOpenApplication: (group: ApplicationGroup, selectedOrderId?: number) => void
  onCreateHuanyuOrder: () => void
}): React.JSX.Element {
  const [orders, setOrders] = useState<Order[]>(() => getCachedOrders(employeeCode) ?? [])
  const [loading, setLoading] = useState(getCachedOrders(employeeCode) === null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('list')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [detailRegions, setDetailRegions] = useState<Record<string, string | null>>({})
  const [reminderModalOrder, setReminderModalOrder] = useState<Order | null>(null)

  useEffect(() => {
    if (view !== 'board') return

    let alive = true

    function refresh(showLoading: boolean, force = false): void {
      if (showLoading) setLoading(true)
      loadOrders(employeeCode, force)
        .then((list) => alive && (setOrders(list), setError(null)))
        .catch((e) => alive && setError(e instanceof Error ? e.message : '加载失败'))
        .finally(() => alive && showLoading && setLoading(false))
    }

    refresh(getCachedOrders(employeeCode) === null, true)
    const timer = window.setInterval(() => refresh(false, true), REFRESH_INTERVAL_MS)

    const handleOrdersUpdated = (): void => {
      refresh(false, true)
    }
    window.addEventListener('huanyu-orders-updated', handleOrdersUpdated)
    window.addEventListener('focus', handleOrdersUpdated)

    return () => {
      alive = false
      window.clearInterval(timer)
      window.removeEventListener('huanyu-orders-updated', handleOrdersUpdated)
      window.removeEventListener('focus', handleOrdersUpdated)
    }
  }, [employeeCode, view])

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
  const boardGroupKeys = useMemo(() => boardGroups.map((group) => group.key).join('|'), [boardGroups])

  useEffect(() => {
    if (view !== 'board') return
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
  }, [boardGroupKeys, boardGroups, detailRegions, view])

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
          {/* 看板模式下的类型筛选 */}
          {view === 'board' && (
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
          )}
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

      {view === 'board' ? (
        loading ? (
          <div className="flex-1 flex items-center justify-center text-text-muted gap-2">
            <span className="material-symbols-outlined animate-spin">progress_activity</span>
            加载看板订单中…
          </div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center text-error gap-2">
            <span className="material-symbols-outlined">error</span>
            <span>{error}</span>
          </div>
        ) : (
          <BoardView
            groups={boardGroups}
            detailRegions={detailRegions}
            onOpen={onOpenApplication}
            onOpenReminder={setReminderModalOrder}
          />
        )
      ) : (
        <ListView
          employeeCode={employeeCode}
          query={query}
          showAdvancedSearch={showAdvancedSearch}
          onToggleAdvancedSearch={onToggleAdvancedSearch}
          onAdvancedFilterCountChange={onAdvancedFilterCountChange}
          onOpen={onOpenApplication}
          onCreateHuanyuOrder={onCreateHuanyuOrder}
          onOpenReminder={setReminderModalOrder}
        />
      )}

      {reminderModalOrder && (
        <OrderReminderModal
          order={reminderModalOrder}
          onClose={() => setReminderModalOrder(null)}
        />
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
  onOpen,
  onOpenReminder
}: {
  groups: ApplicationGroup[]
  detailRegions: Record<string, string | null>
  onOpen: (group: ApplicationGroup) => void
  onOpenReminder: (order: Order) => void
}): React.JSX.Element {
  const grouped = useMemo(() => {
    const g: Record<LaneKey, ApplicationGroup[]> = { todo: [], doing: [], await_backfill: [], done: [] }
    for (const group of groups) {
      const lane = groupLaneOf(group)
      if (lane) g[lane].push(group)
    }
    for (const key of Object.keys(g) as LaneKey[]) {
      g[key].sort((a, b) => timeValue(b.poolEnteredAt) - timeValue(a.poolEnteredAt))
    }
    return g
  }, [groups])

  return (
    <div className="flex-1 min-h-0 overflow-hidden p-6 bg-surface-bg flex gap-4">
      {LANES.map((lane) => {
        const items = grouped[lane.key]
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
                <span className={'w-2 h-2 rounded-full ' + lane.dotClass} />
                {lane.label}
              </h3>
              <span className="text-body-sm text-text-muted bg-surface-variant px-2 py-0.5 rounded">{items.length}</span>
            </div>

            <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-3 min-h-0">
              {items.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-text-muted/50 py-8">
                  <span className="material-symbols-outlined text-[48px] mb-2">
                    inventory_2
                  </span>
                  <p className="text-body-sm">暂无</p>
                </div>
              ) : (
                items.map((group) => (
                  <ApplicationCard
                    key={group.key}
                    group={group}
                    lane={lane.key}
                    detailRegion={detailRegions[group.key] ?? null}
                    onOpen={onOpen}
                    onOpenReminder={onOpenReminder}
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
        title={`复制完整申请号 ${applicationNo}`}
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
  onOpen,
  onOpenReminder
}: {
  group: ApplicationGroup
  lane: LaneKey
  detailRegion: string | null
  onOpen: (group: ApplicationGroup) => void
  onOpenReminder: (order: Order) => void
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
      {/* 申请号 + 来源 + 提醒 */}
      <div className="flex items-center gap-2 mb-2 rounded-md bg-surface-bg border border-border-subtle px-2 py-1">
        <ApplicationCopyButtons
          applicationNo={group.applicationNo}
          customerName={displayName}
          className="text-data-mono font-data-mono text-[#536174] min-w-0 flex-1"
        />
        <span className={'shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ' + origin.bg + ' ' + origin.text}>
          {origin.label}
        </span>
        {group.orders.length === 1 && (
          <button
            type="button"
            title="设置跟进提醒"
            onClick={(e) => {
              e.stopPropagation()
              onOpenReminder(primary)
            }}
            className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded hover:bg-white text-text-muted hover:text-alert-orange transition-colors"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>notification_add</span>
          </button>
        )}
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

// ─── 列表视图（14列标准工作台、树状折叠/展开、按列高级搜索、服务端真分页）──────────────
type SortKey = 'customerName' | 'hospital' | 'status' | 'poolEnteredAt'

interface AdvancedFilters {
  applicationNo: string
  sourceOrderNo: string
  huanyuOrderNo: string
  serviceType: string
  customerName: string
  accountManager: string
  hospital: string
  dept: string
  doctor: string
  startDate: string
  endDate: string
}

const EMPTY_FILTERS: AdvancedFilters = {
  applicationNo: '',
  sourceOrderNo: '',
  huanyuOrderNo: '',
  serviceType: '',
  customerName: '',
  accountManager: '',
  hospital: '',
  dept: '',
  doctor: '',
  startDate: '',
  endDate: ''
}

function ListView({
  employeeCode,
  query,
  showAdvancedSearch = false,
  onToggleAdvancedSearch,
  onAdvancedFilterCountChange,
  onOpen,
  onCreateHuanyuOrder,
  onOpenReminder
}: {
  employeeCode: string
  query: string
  showAdvancedSearch?: boolean
  onToggleAdvancedSearch?: (open: boolean | ((prev: boolean) => boolean)) => void
  onAdvancedFilterCountChange?: (count: number) => void
  onOpen: (group: ApplicationGroup, selectedOrderId?: number) => void
  onCreateHuanyuOrder: () => void
  onOpenReminder: (order: Order) => void
}): React.JSX.Element {
  const [laneFilter, setLaneFilter] = useState<LaneKey | 'all'>('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'poolEnteredAt', dir: 'desc' })
  const [page, setPage] = useState<number>(1)
  const [pageSize, setPageSize] = useState<number>(20)
  const [orders, setOrders] = useState<Order[]>([])
  const [totalCount, setTotalCount] = useState<number>(0)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  // 树状展开/折叠状态（默认全部展开，记录折叠的 key）
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(() => new Set())
  const toggleExpand = (key: string): void => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const isExpanded = (key: string): boolean => !collapsedKeys.has(key)

  // 高级搜索状态（表单暂存 vs 已生效执行）
  const [filtersForm, setFiltersForm] = useState<AdvancedFilters>(EMPTY_FILTERS)
  const [activeFilters, setActiveFilters] = useState<AdvancedFilters>(EMPTY_FILTERS)

  const activeCount = useMemo(() => {
    return Object.values(activeFilters).filter((v) => Boolean(v && v.trim())).length
  }, [activeFilters])

  useEffect(() => {
    onAdvancedFilterCountChange?.(activeCount)
  }, [activeCount, onAdvancedFilterCountChange])

  // 当筛选、排序、全局搜索或高级条件变化时重置回第 1 页
  useEffect(() => {
    setPage(1)
  }, [laneFilter, sort, query, activeFilters])

  const loadData = useCallback(() => {
    setLoading(true)
    fetchOrdersPaginated({
      page,
      pageSize,
      query: query.trim() || undefined,
      lane: laneFilter !== 'all' ? laneFilter : undefined,
      sortKey: sort.key,
      sortDir: sort.dir,
      applicationNo: activeFilters.applicationNo.trim() || undefined,
      sourceOrderNo: activeFilters.sourceOrderNo.trim() || undefined,
      huanyuOrderNo: activeFilters.huanyuOrderNo.trim() || undefined,
      serviceType: activeFilters.serviceType.trim() || undefined,
      customerName: activeFilters.customerName.trim() || undefined,
      accountManager: activeFilters.accountManager.trim() || undefined,
      hospital: activeFilters.hospital.trim() || undefined,
      dept: activeFilters.dept.trim() || undefined,
      doctor: activeFilters.doctor.trim() || undefined,
      startDate: activeFilters.startDate.trim() || undefined,
      endDate: activeFilters.endDate.trim() || undefined
    })
      .then((res) => {
        setOrders(res.data)
        setTotalCount(res.total)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : '加载列表失败'))
      .finally(() => setLoading(false))
  }, [page, pageSize, query, laneFilter, sort, activeFilters, employeeCode])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    const handleOrdersUpdated = (): void => {
      loadData()
    }
    window.addEventListener('huanyu-orders-updated', handleOrdersUpdated)
    window.addEventListener('focus', handleOrdersUpdated)
    return () => {
      window.removeEventListener('huanyu-orders-updated', handleOrdersUpdated)
      window.removeEventListener('focus', handleOrdersUpdated)
    }
  }, [loadData])

  const groups = useMemo(() => groupOrdersByApplication(orders), [orders])

  function toggleSort(key: SortKey): void {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }

  const FILTERS: { key: LaneKey | 'all'; label: string }[] = [
    { key: 'all', label: '全部' },
    ...LANES.map((l) => ({ key: l.key, label: l.label }))
  ]
  const activeFilter = FILTERS.find((f) => f.key === laneFilter) ?? FILTERS[0]

  const handleSearchSubmit = (e?: React.FormEvent): void => {
    if (e) e.preventDefault()
    setActiveFilters({ ...filtersForm })
    setPage(1)
  }

  const handleResetFilters = (): void => {
    setFiltersForm(EMPTY_FILTERS)
    setActiveFilters(EMPTY_FILTERS)
    setPage(1)
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-surface-bg">
      {/* 顶部工具栏 */}
      <div className="shrink-0 px-6 py-4 flex items-center justify-between gap-4">
        <div>
          <h3 className="text-h3-title text-text-main">申请列表</h3>
          <p className="mt-0.5 text-body-sm text-text-muted">按申请号查看全部工作台记录（共 {totalCount} 条）</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onCreateHuanyuOrder}
            className="inline-flex h-10 items-center gap-1.5 rounded-md bg-primary px-4 text-body-md font-semibold text-white shadow-sm transition-colors hover:bg-primary/90"
          >
            <span className="material-symbols-outlined text-[18px]">add</span>
            新建寰宇订单
          </button>
          <button
            type="button"
            onClick={() => onToggleAdvancedSearch?.((v) => !v)}
            className={
              'inline-flex h-10 items-center gap-1.5 rounded-md border px-3 text-body-md font-medium shadow-2xs transition-colors ' +
              (showAdvancedSearch || activeCount > 0
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border-subtle bg-white text-text-main hover:bg-surface-bg')
            }
          >
            <span className="material-symbols-outlined text-[18px]">tune</span>
            高级筛选{activeCount > 0 ? ` (${activeCount})` : ''}
          </button>
          <select
            value={laneFilter}
            onChange={(e) => setLaneFilter(e.target.value as LaneKey | 'all')}
            className="h-10 rounded-md border border-border-subtle bg-white px-3 text-body-md text-text-main shadow-sm focus:outline-none focus:border-primary"
            title="阶段筛选"
          >
            {FILTERS.map((f) => (
              <option key={f.key} value={f.key}>{f.label}</option>
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

      {/* 高级按列精准筛选面板 */}
      {showAdvancedSearch && (
        <form
          onSubmit={handleSearchSubmit}
          className="mx-6 mb-3 p-4 bg-white rounded-lg border border-border-subtle shadow-xs space-y-3"
        >
          <div className="flex items-center justify-between border-b border-border-subtle pb-2">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-[18px]">tune</span>
              <span className="text-body-md font-bold text-text-main">按列高级精准筛选</span>
              {activeCount > 0 && (
                <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-primary/10 text-primary">
                  已生效 {activeCount} 项
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => onToggleAdvancedSearch?.(false)}
              className="text-text-muted hover:text-text-main text-[12px] flex items-center gap-0.5"
            >
              <span>收起</span>
              <span className="material-symbols-outlined text-[16px]">expand_less</span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-body-sm">
            <div>
              <label className="block text-[12px] text-text-muted mb-1">申请号</label>
              <input
                type="text"
                placeholder="按申请号搜索"
                value={filtersForm.applicationNo}
                onChange={(e) => setFiltersForm((prev) => ({ ...prev, applicationNo: e.target.value }))}
                className="w-full px-2.5 py-1.5 rounded border border-border-subtle bg-surface-bg text-text-main focus:bg-white focus:border-primary focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[12px] text-text-muted mb-1">B端订单号</label>
              <input
                type="text"
                placeholder="按B端单号搜索"
                value={filtersForm.sourceOrderNo}
                onChange={(e) => setFiltersForm((prev) => ({ ...prev, sourceOrderNo: e.target.value }))}
                className="w-full px-2.5 py-1.5 rounded border border-border-subtle bg-surface-bg text-text-main focus:bg-white focus:border-primary focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[12px] text-text-muted mb-1">寰宇订单号</label>
              <input
                type="text"
                placeholder="按寰宇订单号搜索"
                value={filtersForm.huanyuOrderNo}
                onChange={(e) => setFiltersForm((prev) => ({ ...prev, huanyuOrderNo: e.target.value }))}
                className="w-full px-2.5 py-1.5 rounded border border-border-subtle bg-surface-bg text-text-main focus:bg-white focus:border-primary focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[12px] text-text-muted mb-1">业务类型</label>
              <input
                type="text"
                placeholder="例如：挂号协助 / 全程专家门诊"
                value={filtersForm.serviceType}
                onChange={(e) => setFiltersForm((prev) => ({ ...prev, serviceType: e.target.value }))}
                className="w-full px-2.5 py-1.5 rounded border border-border-subtle bg-surface-bg text-text-main focus:bg-white focus:border-primary focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[12px] text-text-muted mb-1">客户姓名</label>
              <input
                type="text"
                placeholder="按真实姓名搜索"
                value={filtersForm.customerName}
                onChange={(e) => setFiltersForm((prev) => ({ ...prev, customerName: e.target.value }))}
                className="w-full px-2.5 py-1.5 rounded border border-border-subtle bg-surface-bg text-text-main focus:bg-white focus:border-primary focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-[12px] text-text-muted mb-1">客户经理</label>
              <input
                type="text"
                placeholder="例如：唐晓艳"
                value={filtersForm.accountManager}
                onChange={(e) => setFiltersForm((prev) => ({ ...prev, accountManager: e.target.value }))}
                className="w-full px-2.5 py-1.5 rounded border border-border-subtle bg-surface-bg text-text-main focus:bg-white focus:border-primary focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[12px] text-text-muted mb-1">医院</label>
              <input
                type="text"
                placeholder="按医院名称搜索"
                value={filtersForm.hospital}
                onChange={(e) => setFiltersForm((prev) => ({ ...prev, hospital: e.target.value }))}
                className="w-full px-2.5 py-1.5 rounded border border-border-subtle bg-surface-bg text-text-main focus:bg-white focus:border-primary focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[12px] text-text-muted mb-1">科室</label>
              <input
                type="text"
                placeholder="按科室名称搜索"
                value={filtersForm.dept}
                onChange={(e) => setFiltersForm((prev) => ({ ...prev, dept: e.target.value }))}
                className="w-full px-2.5 py-1.5 rounded border border-border-subtle bg-surface-bg text-text-main focus:bg-white focus:border-primary focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[12px] text-text-muted mb-1">医生</label>
              <input
                type="text"
                placeholder="按医生姓名搜索"
                value={filtersForm.doctor}
                onChange={(e) => setFiltersForm((prev) => ({ ...prev, doctor: e.target.value }))}
                className="w-full px-2.5 py-1.5 rounded border border-border-subtle bg-surface-bg text-text-main focus:bg-white focus:border-primary focus:outline-none"
              />
            </div>

            <div className="lg:col-span-2">
              <label className="block text-[12px] text-text-muted mb-1">入池日期范围</label>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={filtersForm.startDate}
                  onChange={(e) => setFiltersForm((prev) => ({ ...prev, startDate: e.target.value }))}
                  className="w-full px-2.5 py-1.5 rounded border border-border-subtle bg-surface-bg text-text-main focus:bg-white focus:border-primary focus:outline-none text-[12px]"
                />
                <span className="text-text-muted">至</span>
                <input
                  type="date"
                  value={filtersForm.endDate}
                  onChange={(e) => setFiltersForm((prev) => ({ ...prev, endDate: e.target.value }))}
                  className="w-full px-2.5 py-1.5 rounded border border-border-subtle bg-surface-bg text-text-main focus:bg-white focus:border-primary focus:outline-none text-[12px]"
                />
              </div>
            </div>

            <div className="lg:col-span-2 flex items-end justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={handleResetFilters}
                className="px-3 py-1.5 rounded border border-border-subtle text-text-main hover:bg-surface-bg transition-colors font-medium text-body-sm"
              >
                重置
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded bg-primary text-white hover:bg-primary/90 transition-colors font-medium text-body-sm shadow-xs flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-[16px]">search</span>
                查询
              </button>
            </div>
          </div>
        </form>
      )}

      {/* 14 列表格容器 */}
      <div className="flex-1 min-h-0 px-6 pb-5 flex flex-col">
        <div className="flex-1 min-h-0 rounded-lg border border-border-subtle bg-white shadow-sm flex flex-col overflow-hidden">
          <div className="flex-1 min-h-0 overflow-auto">
            <table className="w-full min-w-[1680px] table-fixed border-collapse text-body-sm">
              <colgroup>
                <col className="w-[190px]" /> {/* 1. 申请号 */}
                <col className="w-[170px]" /> {/* 2. B端订单号 */}
                <col className="w-[180px]" /> {/* 3. 寰宇订单号 */}
                <col className="w-[130px]" /> {/* 4. 业务类型 */}
                <col className="w-[100px]" /> {/* 5. 客户 */}
                <col className="w-[115px]" /> {/* 6. 订单状态 */}
                <col className="w-[90px]" />  {/* 7. 客户经理 */}
                <col className="w-[170px]" /> {/* 8. 医院 */}
                <col className="w-[110px]" /> {/* 9. 科室 */}
                <col className="w-[90px]" />  {/* 10. 医生 */}
                <col className="w-[100px]" /> {/* 11. 订单金额 */}
                <col className="w-[95px]" />  {/* 12. 数据量 */}
                <col className="w-[70px]" />  {/* 13. 来源 */}
                <col className="w-[95px]" />  {/* 14. 入池 */}
                <col className="w-[80px]" />  {/* 15. 操作 */}
              </colgroup>
              <thead className="sticky top-0 bg-white z-10 shadow-[0_1px_0_0_#f1f5f9]">
                <tr className="text-left text-[#454a5a] border-b border-border-subtle whitespace-nowrap">
                  <th className="py-3 px-3 font-bold whitespace-nowrap">申请号</th>
                  <th className="py-3 px-3 font-bold whitespace-nowrap">B端订单号</th>
                  <th className="py-3 px-3 font-bold whitespace-nowrap">寰宇订单号</th>
                  <th className="py-3 px-3 font-bold whitespace-nowrap">业务类型</th>
                  <SortHead label="客户" k="customerName" sort={sort} onSort={toggleSort} />
                  <SortHead label="订单状态" k="status" sort={sort} onSort={toggleSort} />
                  <th className="py-3 px-3 font-bold whitespace-nowrap">客户经理</th>
                  <SortHead label="医院" k="hospital" sort={sort} onSort={toggleSort} />
                  <th className="py-3 px-3 font-bold whitespace-nowrap">科室</th>
                  <th className="py-3 px-3 font-bold whitespace-nowrap">医生</th>
                  <th className="py-3 px-3 font-bold whitespace-nowrap">订单金额</th>
                  <th className="py-3 px-3 font-bold whitespace-nowrap">数据量</th>
                  <th className="py-3 px-3 font-bold whitespace-nowrap">来源</th>
                  <SortHead label="入池" k="poolEnteredAt" sort={sort} onSort={toggleSort} />
                  <th className="py-3 px-3 font-bold whitespace-nowrap text-center">操作</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={15} className="py-12 text-center text-text-muted">
                      <div className="flex items-center justify-center gap-2">
                        <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
                        加载中…
                      </div>
                    </td>
                  </tr>
                ) : error ? (
                  <tr>
                    <td colSpan={15} className="py-12 text-center text-error">
                      {error}
                    </td>
                  </tr>
                ) : groups.length === 0 ? (
                  <tr>
                    <td colSpan={15} className="py-12 text-center text-text-muted">
                      暂无{activeFilter.label}申请
                    </td>
                  </tr>
                ) : (
                  groups.flatMap((group) => {
                    const services = getServicesOfGroup(group)
                    // 单个服务的申请或独立自营单：直接单行展示
                    if (services.length <= 1) {
                      const isSingleSelfOperated =
                        group.primary.source === 'huanyu' ||
                        (typeof group.primary.sourceOrderNo === 'string' && group.primary.sourceOrderNo.startsWith('HYDD'))
                      const singleService = services[0] || {
                        id: group.primary.id,
                        key: `order:${group.primary.id}`,
                        parentOrderId: group.primary.id,
                        isClone: false,
                        sequence: 1,
                        applicationNo: group.applicationNo,
                        sourceOrderNo: isSingleSelfOperated ? '' : (group.primary.bOrderNo || group.primary.sourceOrderNo),
                        huanyuOrderNo: group.primary.huanyuOrderNo || (isSingleSelfOperated ? group.primary.sourceOrderNo : null),
                        serviceType: group.primary.serviceType || bizType(group.primary),
                        customerName: group.customerName,
                        status: group.primary.huanyuOrderStatus || group.primary.status,
                        accountManager: group.primary.accountManager || '—',
                        hospital: group.primary.hospital || '',
                        dept: group.primary.dept || '',
                        doctor: group.primary.doctor || '',
                        isAiHospital: Boolean(group.primary.isAiHospital),
                        isAiDept: Boolean(group.primary.isAiDept),
                        isAiDoctor: Boolean(group.primary.isAiDoctor),
                        amount: group.primary.orderAmount ?? null,
                        dataCount: {
                          textAndImages: group.primary.textCount + group.primary.imageCount,
                          audio: group.primary.audioCount
                        },
                        source: group.primary.source,
                        poolEnteredAt: group.poolEnteredAt,
                        rawOrder: group.primary
                      }
                      return [
                        <ServiceRow
                          key={group.key}
                          group={group}
                          service={singleService}
                          isChild={false}
                          sequence={1}
                          totalServices={1}
                          onOpen={onOpen}
                          onOpenReminder={onOpenReminder}
                        />
                      ]
                    }

                    // 多服务场景（多个B端订单或同一母单复制为多次服务）：申请号汇总父行 + 展开所有具体服务子单
                    const expanded = isExpanded(group.key)
                    const rows: React.JSX.Element[] = [
                      <ApplicationTreeRow
                        key={`${group.key}:parent`}
                        group={group}
                        services={services}
                        isExpanded={expanded}
                        onToggleExpand={() => toggleExpand(group.key)}
                        onOpen={onOpen}
                      />
                    ]
                    if (expanded) {
                      services.forEach((svc, index) => {
                        rows.push(
                          <ServiceRow
                            key={`${group.key}:child:${svc.key}`}
                            group={group}
                            service={svc}
                            isChild={true}
                            sequence={svc.sequence || index + 1}
                            totalServices={services.length}
                            onOpen={onOpen}
                            onOpenReminder={onOpenReminder}
                          />
                        )
                      })
                    }
                    return rows
                  })
                )}
              </tbody>
            </table>
          </div>
          <div className="shrink-0 border-t border-border-subtle bg-white">
            <StandardPaginationBar
              totalCount={totalCount}
              currentPage={page}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              pageSizeOptions={[10, 20, 50, 100]}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function rowAccentOf(lane: LaneKey | null): string {
  return lane === 'todo'
    ? 'border-l-status-urgent'
    : lane === 'doing'
      ? 'border-l-status-info'
      : lane === 'await_backfill'
        ? 'border-l-ai-purple'
        : lane === 'done'
          ? 'border-l-status-success'
          : 'border-l-border-subtle'
}

/** 申请号汇总父行（折叠/展开一次，包含所有子单汇总统计） */
function ApplicationTreeRow({
  group,
  services,
  isExpanded,
  onToggleExpand,
  onOpen
}: {
  group: ApplicationGroup
  services: FlattenedService[]
  isExpanded: boolean
  onToggleExpand: () => void
  onOpen: (group: ApplicationGroup, selectedOrderId?: number) => void
}): React.JSX.Element {
  const order = group.primary
  const lane = groupLaneOf(group)
  const gender = genderOf(order)
  const uniqueBOrders = new Set(services.map((s) => s.sourceOrderNo).filter(Boolean))
  const totalAmount = services.reduce((sum, s) => sum + (s.amount ?? 0), 0)
  const hasAnyAmount = services.some((s) => s.amount != null)
  const serviceSummaries = dedupeServices(group.orders)

  return (
    <tr
      onClick={() => onOpen(group)}
      className={
        'border-b border-border-subtle border-l-2 bg-[#f8fafc] hover:bg-primary-fixed/30 cursor-pointer transition-colors ' +
        rowAccentOf(lane)
      }
    >
      {/* 1. 申请号 */}
      <td className="py-2.5 px-3 text-[#161a22] font-mono-data font-semibold">
        <div className="flex items-center gap-1 min-w-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpand()
            }}
            className="shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-black/5 text-[#536174]"
            title={isExpanded ? '折叠服务单' : '展开服务单'}
          >
            <span className="material-symbols-outlined text-[18px]">
              {isExpanded ? 'expand_more' : 'chevron_right'}
            </span>
          </button>
          <ApplicationCopyButtons
            applicationNo={group.applicationNo}
            customerName={group.customerName}
            className="max-w-full truncate"
          />
        </div>
      </td>

      {/* 2. B端订单号 */}
      <td className="py-2.5 px-3 text-text-muted">
        {uniqueBOrders.size > 0 ? (
          <span className="inline-flex items-center gap-1 rounded bg-white px-2 py-0.5 text-[11px] font-semibold text-[#454a5a] border border-border-subtle shadow-2xs">
            <span className="material-symbols-outlined text-primary text-[14px]">account_tree</span>
            {uniqueBOrders.size} 个B端单 · {services.length} 次服务
          </span>
        ) : (
          <span className="text-text-muted font-mono-data">—</span>
        )}
      </td>

      {/* 3. 寰宇订单号 */}
      <td className="py-2.5 px-3 text-[#161a22] font-mono-data font-semibold">
        {(() => {
          const uniqueHuanyuOrders = [...new Set(services.map((s) => s.huanyuOrderNo).filter((v): v is string => Boolean(v)))]
          if (uniqueHuanyuOrders.length === 1) {
            return (
              <Copyable value={uniqueHuanyuOrders[0]} className="truncate text-[#161a22]">
                <span className="truncate">{uniqueHuanyuOrders[0]}</span>
              </Copyable>
            )
          }
          if (uniqueHuanyuOrders.length > 1) {
            return (
              <span className="inline-flex items-center gap-1 rounded bg-white px-2 py-0.5 text-[11px] font-semibold text-[#454a5a] border border-border-subtle shadow-2xs">
                {uniqueHuanyuOrders.length} 个寰宇单
              </span>
            )
          }
          return <span className="text-text-muted font-mono-data">—</span>
        })()}
      </td>

      {/* 4. 业务类型 */}
      <td className="py-2.5 px-3">
        <ServiceChips services={serviceSummaries} />
      </td>

      {/* 4. 客户 (纯姓名，无电话) */}
      <td className="py-2.5 px-3">
        <div className="flex items-center gap-1 truncate font-semibold text-text-main">
          <span className="truncate" title={group.customerName}>{group.customerName}</span>
          {gender && <GenderIcon gender={gender} />}
        </div>
      </td>

      {/* 5. 订单状态 */}
      <td className="py-2.5 px-3 whitespace-nowrap">
        <LaneBadge order={order} />
      </td>

      {/* 6. 客户经理 */}
      <td className="py-2.5 px-3 text-body-sm text-[#454a5a]">
        <span className="truncate block" title={order.accountManager || '—'}>{order.accountManager || '—'}</span>
      </td>

      {/* 7. 医院 */}
      <td className="py-2.5 px-3 text-[#454a5a] font-medium">
        {(() => {
          const validServiceHospital = services.find((s) => s.hospital && !isInvalidHospital(s.hospital))?.hospital
          const displayHospital = (!isInvalidHospital(order.hospital) ? order.hospital : '') || validServiceHospital || '医院待定'
          return (
            <div className="flex items-center gap-1 truncate" title={displayHospital}>
              <span className="truncate">{displayHospital}</span>
              {order.isAiHospital && (
                <span className="shrink-0 text-[10px] px-1 py-0.2 bg-purple-50 text-purple-600 rounded border border-purple-200" title="由AI智能分析识别">AI</span>
              )}
            </div>
          )
        })()}
      </td>

      {/* 8. 科室 */}
      <td className="py-2.5 px-3 text-body-sm text-[#536174]">
        <div className="flex items-center gap-1 truncate" title={order.dept || '科室待定'}>
          <span className="truncate">{order.dept || '科室待定'}</span>
          {order.isAiDept && (
            <span className="shrink-0 text-[10px] px-1 py-0.2 bg-purple-50 text-purple-600 rounded border border-purple-200" title="由AI智能分析识别">AI</span>
          )}
        </div>
      </td>

      {/* 9. 医生 */}
      <td className="py-2.5 px-3 text-body-sm text-[#536174]">
        <div className="flex items-center gap-1 truncate" title={order.doctor || '医生待定'}>
          <span className="truncate">{order.doctor || '医生待定'}</span>
          {order.isAiDoctor && (
            <span className="shrink-0 text-[10px] px-1 py-0.2 bg-purple-50 text-purple-600 rounded border border-purple-200" title="由AI智能分析识别">AI</span>
          )}
        </div>
      </td>

      {/* 10. 订单金额 (自动求和所有子服务) */}
      <td className="py-2.5 px-3 font-mono-data font-semibold text-text-main">
        {hasAnyAmount ? `¥${totalAmount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
      </td>

      {/* 11. 数据量 */}
      <td className="py-2.5 px-3">
        <DataCounts order={order} />
      </td>

      {/* 12. 来源 */}
      <td className="py-2.5 px-3">
        <SourceBadge order={order} />
      </td>

      {/* 13. 入池 */}
      <td className="py-2.5 px-3 text-[#454a5a] whitespace-nowrap text-body-sm font-mono-data" title={group.poolEnteredAt}>
        {relativeTime(group.poolEnteredAt)}
      </td>

      {/* 14. 操作 */}
      <td className="py-2.5 px-3 text-center text-text-muted text-[12px]">
        —
      </td>
    </tr>
  )
}

/** 具体服务项行（包括单服务订单与展开后的子服务行） */
function ServiceRow({
  group,
  service,
  isChild = false,
  sequence = 1,
  totalServices = 1,
  onOpen,
  onOpenReminder
}: {
  group: ApplicationGroup
  service: FlattenedService
  isChild?: boolean
  sequence?: number
  totalServices?: number
  onOpen: (group: ApplicationGroup, selectedOrderId?: number) => void
  onOpenReminder: (order: Order) => void
}): React.JSX.Element {
  const lane = laneOf(service.rawOrder)
  const gender = genderOf(service.rawOrder)

  return (
    <tr
      onClick={() => onOpen(group, service.parentOrderId)}
      className={
        'border-b border-border-subtle border-l-2 hover:bg-primary-fixed/20 cursor-pointer transition-colors bg-white ' +
        rowAccentOf(lane)
      }
    >
      {/* 1. 申请号 */}
      <td className="py-2.5 px-3 text-[#161a22] font-mono-data font-semibold">
        {isChild ? (
          <div className="pl-6 flex items-center gap-1.5 text-text-muted">
            <span className="material-symbols-outlined text-[15px] text-slate-400">subdirectory_arrow_right</span>
            <span className="text-[12px] font-mono-data text-slate-500">服务 #{sequence}</span>
          </div>
        ) : service.applicationNo ? (
          <ApplicationCopyButtons
            applicationNo={service.applicationNo}
            customerName={service.customerName}
            className="max-w-full"
          />
        ) : (
          <span className="text-text-muted font-mono-data pl-2">—</span>
        )}
      </td>

      {/* 2. B端订单号 */}
      <td className="py-2.5 px-3 text-[#161a22] font-mono-data font-semibold">
        {service.sourceOrderNo ? (
          <div className="flex items-center gap-1.5 min-w-0">
            <Copyable value={service.sourceOrderNo} className="truncate text-[#161a22]">
              <span className="truncate">{service.sourceOrderNo}</span>
            </Copyable>
            {service.isClone ? (
              <span
                className="shrink-0 text-[10px] px-1 py-0.2 rounded bg-amber-50 text-amber-700 border border-amber-200 font-semibold"
                title={`基于母单复制的第 ${sequence} 次服务`}
              >
                #{sequence} 复制
              </span>
            ) : totalServices > 1 ? (
              <span className="shrink-0 text-[10px] px-1 py-0.2 rounded bg-slate-100 text-slate-600 font-medium">
                #1
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-text-muted font-mono-data">—</span>
        )}
      </td>

      {/* 3. 寰宇订单号 */}
      <td className="py-2.5 px-3 text-[#161a22] font-mono-data font-semibold">
        {service.huanyuOrderNo ? (
          <div className="flex items-center gap-1.5 min-w-0">
            <Copyable value={service.huanyuOrderNo} className="truncate text-[#161a22]">
              <span className="truncate">{service.huanyuOrderNo}</span>
            </Copyable>
          </div>
        ) : (
          <span className="text-text-muted font-mono-data">—</span>
        )}
      </td>

      {/* 4. 业务类型 */}
      <td className="py-2.5 px-3">
        {service.serviceType ? (
          <span
            className={
              'text-[12px] leading-5 px-2 py-0.5 rounded font-medium border border-current/20 truncate inline-block max-w-full ' +
              bizChipClass(service.rawOrder)
            }
            title={service.serviceType}
          >
            {service.serviceType}
          </span>
        ) : (
          <span className="text-text-muted font-mono-data">—</span>
        )}
      </td>

      {/* 4. 客户 (纯姓名，无电话) */}
      <td className="py-2.5 px-3">
        <div className="flex items-center gap-1 font-semibold text-text-main truncate">
          <span className="truncate" title={service.customerName}>{service.customerName}</span>
          {gender && <GenderIcon gender={gender} />}
        </div>
      </td>

      {/* 5. 订单状态 */}
      <td className="py-2.5 px-3 whitespace-nowrap">
        <LaneBadge order={service.rawOrder} customLabel={service.status} />
      </td>

      {/* 6. 客户经理 */}
      <td className="py-2.5 px-3 text-body-sm text-[#454a5a]">
        <span className="truncate block" title={service.accountManager}>{service.accountManager || '—'}</span>
      </td>

      {/* 7. 医院 */}
      <td className="py-2.5 px-3 text-[#161a22] font-medium">
        {(() => {
          const validHospital =
            (!isInvalidHospital(service.hospital) ? service.hospital : '') ||
            (!isInvalidHospital(service.rawOrder.hospital) ? service.rawOrder.hospital : '') ||
            '—'
          return (
            <div className="flex items-center gap-1 truncate" title={validHospital}>
              <span className="truncate">{validHospital}</span>
              {service.isAiHospital && (
                <span className="shrink-0 text-[10px] px-1 py-0.2 bg-purple-50 text-purple-600 rounded border border-purple-200" title="由AI智能分析识别">AI</span>
              )}
            </div>
          )
        })()}
      </td>

      {/* 8. 科室 */}
      <td className="py-2.5 px-3 text-body-sm text-[#536174]">
        <div className="flex items-center gap-1 truncate" title={service.dept || '—'}>
          <span className="truncate">{service.dept || '—'}</span>
          {service.isAiDept && (
            <span className="shrink-0 text-[10px] px-1 py-0.2 bg-purple-50 text-purple-600 rounded border border-purple-200" title="由AI智能分析识别">AI</span>
          )}
        </div>
      </td>

      {/* 9. 医生 */}
      <td className="py-2.5 px-3 text-body-sm text-[#536174]">
        <div className="flex items-center gap-1 truncate" title={service.doctor || '—'}>
          <span className="truncate">{service.doctor || '—'}</span>
          {service.isAiDoctor && (
            <span className="shrink-0 text-[10px] px-1 py-0.2 bg-purple-50 text-purple-600 rounded border border-purple-200" title="由AI智能分析识别">AI</span>
          )}
        </div>
      </td>

      {/* 10. 订单金额 */}
      <td className="py-2.5 px-3 font-mono-data font-semibold text-text-main">
        {service.amount != null
          ? `¥${service.amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : '—'}
      </td>

      {/* 11. 数据量 */}
      <td className="py-2.5 px-3">
        <DataCounts order={service.rawOrder} />
      </td>

      {/* 12. 来源 */}
      <td className="py-2.5 px-3">
        <SourceBadge order={service.rawOrder} />
      </td>

      {/* 13. 入池 */}
      <td className="py-2.5 px-3 text-[#454a5a] whitespace-nowrap text-body-sm font-mono-data" title={service.poolEnteredAt}>
        {relativeTime(service.poolEnteredAt)}
      </td>

      {/* 14. 操作 */}
      <td className="py-2.5 px-3 text-center">
        <button
          type="button"
          title="设置跟进提醒"
          onClick={(e) => {
            e.stopPropagation()
            onOpenReminder(service.rawOrder)
          }}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium text-text-muted hover:text-primary hover:bg-white transition-colors border border-border-subtle hover:border-primary/40 bg-surface-bg shadow-2xs"
        >
          <span className="material-symbols-outlined text-[14px] text-alert-orange">notification_add</span>
          提醒
        </button>
      </td>
    </tr>
  )
}

function ServiceChips({ services }: { services: Array<{ label: string; count: number; order: Order }> }): React.JSX.Element {
  const nonEmpty = services.filter((s) => s.label.trim())
  if (nonEmpty.length === 0) {
    return <span className="text-text-muted font-mono-data">—</span>
  }
  return (
    <div className="flex flex-wrap gap-1 max-w-[160px]">
      {nonEmpty.slice(0, 2).map((service) => (
        <span key={service.label} className={'text-[12px] leading-5 px-2 rounded font-semibold border border-current/20 ' + bizChipClass(service.order)}>
          {service.label}{service.count > 1 ? ` x${service.count}` : ''}
        </span>
      ))}
      {nonEmpty.length > 2 && <span className="text-[12px] leading-5 px-1.5 rounded bg-surface-bg text-text-muted">+{nonEmpty.length - 2}</span>}
    </div>
  )
}

function DataCounts({ order }: { order: Order }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5 text-[#454a5a] font-mono-data">
      <span className="inline-flex items-center gap-1" title="文本与图片数量">
        <span className="material-symbols-outlined filled text-[#6d5dfc]" style={{ fontSize: '15px' }}>article</span>
        {order.textCount + order.imageCount}
      </span>
      <span className="inline-flex items-center gap-1" title="录音数量">
        <span className="material-symbols-outlined filled text-[#0b8fd9]" style={{ fontSize: '15px' }}>mic</span>
        {order.audioCount}
      </span>
    </div>
  )
}

function SourceBadge({ order }: { order: Order }): React.JSX.Element {
  return <span className={'inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ' + sourceStyle(order).bg + ' ' + sourceStyle(order).text}>{sourceLabel(order)}</span>
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
    <th className="py-3 px-3 font-bold whitespace-nowrap">
      <button onClick={() => onSort(k)} className="flex items-center gap-1 hover:text-text-main transition-colors whitespace-nowrap">
        <span className="whitespace-nowrap">{label}</span>
        <span className={'material-symbols-outlined text-[16px] shrink-0 ' + (active ? 'text-primary' : 'text-text-muted/40')}>
          {active ? (sort.dir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}
        </span>
      </button>
    </th>
  )
}

function LaneBadge({ order, customLabel }: { order: Order; customLabel?: string }): React.JSX.Element {
  const key = laneOf(order)
  const color =
    key === 'todo'
      ? 'text-text-muted bg-surface-variant'
      : key === 'doing'
        ? 'text-primary bg-primary-container/15'
        : key === 'await_backfill'
          ? 'text-ai-purple bg-ai-purple/10'
          : key === 'done'
            ? 'text-action-green bg-action-green/10'
            : 'text-text-muted bg-surface-variant'
  const label = customLabel || order.huanyuOrderStatus || '未设置'
  return (
    <span className={'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-label-caps ' + color} title={label}>
      {label}
    </span>
  )
}

