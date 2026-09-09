/**
 * v2 最终功能版 · 后端访问层（只读复用现有 backend HTTP 接口）
 *
 * 说明：所有调用走 HTTP，不依赖 Electron IPC。
 * 登录工号存在 localStorage，键名与采集版（v1）隔开，互不干扰。
 */

const LS_EMPLOYEE = 'hyyd.v2.employeeCode'
const LS_DISPLAYNAME = 'hyyd.v2.displayName'
const LS_BACKEND_URL = 'huanyu.backendUrl'

export const BACKEND_CONFIG_CHANGED = 'hyyd:v2-backend-config-changed'

export function getBackendUrl(): string | null {
  return localStorage.getItem(LS_BACKEND_URL)
}

export function requireBackendUrl(): string {
  const backendUrl = getBackendUrl()
  if (!backendUrl) throw new Error('请先设置后端地址')
  return backendUrl
}

export function normalizeBackendUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('请输入后端地址')
  if (!/^https?:\/\//.test(trimmed)) {
    throw new Error('后端地址必须以 http:// 或 https:// 开头')
  }
  try {
    const url = new URL(trimmed)
    if (!url.hostname || !url.port) {
      throw new Error('后端地址必须包含主机和端口，例如 http://192.168.2.227:13000')
    }
  } catch {
    throw new Error('后端地址格式不正确，例如 http://192.168.2.227:13000')
  }
  return trimmed
}

export function setBackendUrl(value: string): string {
  const normalized = normalizeBackendUrl(value)
  localStorage.setItem(LS_BACKEND_URL, normalized)
  window.dispatchEvent(new CustomEvent(BACKEND_CONFIG_CHANGED, { detail: { backendUrl: normalized } }))
  return normalized
}

export interface Session {
  employeeCode: string
  displayName: string
}

export function getSession(): Session | null {
  const code = localStorage.getItem(LS_EMPLOYEE)
  if (!code) return null
  return { employeeCode: code, displayName: localStorage.getItem(LS_DISPLAYNAME) || code }
}

export function saveSession(s: Session): void {
  localStorage.setItem(LS_EMPLOYEE, s.employeeCode)
  localStorage.setItem(LS_DISPLAYNAME, s.displayName)
}

export function clearSession(): void {
  localStorage.removeItem(LS_EMPLOYEE)
  localStorage.removeItem(LS_DISPLAYNAME)
}

export interface MeResponse {
  id: number
  employeeCode: string
  displayName: string
}

// ─── 订单 ──────────────────────────────────────────────
export interface Order {
  id: number
  source: string // 'taikang' | 'pingan' | ...
  sourceOrderNo: string
  customerName: string
  customerPhone: string | null
  hospital: string | null
  dept: string | null
  doctor: string | null
  status: string // 泰康/平安原始状态名
  orderState?: string | null
  taikangOrderState?: string | null
  taikangOrderStateName?: string | null
  taikangCaseStatus?: string | null
  taikangWaitType?: string | null
  taikangServState?: string | null
  workbenchLane?: 'todo' | 'doing' | 'await_backfill' | 'done'
  serviceStage?: 'claimed' | 'communicating' | 'delivering' | 'settlement' | 'closing'
  intendDate: string | null
  claimedAt: string | null
  createdAt?: string
  updatedAt: string
  materialCount: number
  audioCount: number
  textCount: number
  imageCount: number
  rawJson?: Record<string, unknown> & {
    poolType?: 'register' | 'general'
    serviceType?: string
    itemName?: string
  } | null
}

export interface OrderAttachment {
  id: number
  fileType: string
  fileName: string
  mimeType: string
  byteSize: number
  url: string
}

export interface OrderDetailResponse {
  order: Order & { detailFetchedAt: string | null; detailJson: unknown }
  detail: {
    recommendations?: Record<string, unknown> | null
  } | null
  attachments: OrderAttachment[]
}

export interface OrderCall {
  id: number
  applicationNo?: string | null
  phone: string
  contactName: string | null
  direction: 'in' | 'out' | string
  callStatus: 'answered' | 'missed' | 'rejected' | 'outgoing_unanswered' | string
  durationSec: number
  startedAt: string
  recordingOssKey: string | null
  asrText: string | null
  asrStatus: string
  asrFinishedAt?: string | null
}

// 订单关联的采集消息（后端已跨帧去重、按 sortTime 排好）。日期字段是 ISO 字符串。
export interface OrderMessage {
  id: number
  applicationNo?: string | null
  channel: 'wechat' | 'wxwork' | string
  conversationName: string
  senderType: 'self' | 'other' | 'system' | string
  senderName: string | null
  contentText: string
  kind: string | null
  chatTime: string | null
  sortTime: string | null
  capturedAt: string
  seenCount: number
}

export interface OrderAggregateResponse {
  id: number
  calls: OrderCall[]
  messages: OrderMessage[]
}

async function authedGet<T>(path: string): Promise<T> {
  const code = getSession()?.employeeCode
  if (!code) throw new Error('未登录')
  const res = await fetch(`${requireBackendUrl()}${path}`, {
    headers: { 'X-Employee-Code': code }
  })
  if (!res.ok) throw new Error(`请求失败（${res.status}）`)
  const body = (await res.json()) as { data?: T } & T
  return (body.data ?? body) as T
}

/** 拉取当前登录员工名下的订单 */
export function fetchOrders(): Promise<Order[]> {
  return authedGet<Order[]>('/api/v1/orders')
}

/** 待申领池：泰康公共池订单（任何员工可申领） */
export function fetchClaimableOrders(): Promise<Order[]> {
  return authedGet<Order[]>('/api/v1/orders?pool=public')
}

/** 申领一张订单（→ 已申领，分配给当前登录员工）。
 *  skipTaikang=true：当前待申领页只展示，不对泰康做写操作（不下发插件指令）。 */
export function claimOrder(orderId: number): Promise<{ order: Order; commandId: number | null }> {
  return authedSend(`/api/v1/orders/${orderId}/claim`, 'POST', { skipTaikang: true })
}

/** 手工建单（→ 候选，进入待申领池）。sourceOrderNo 缺省自动生成。 */
export interface CreateOrderInput {
  source: string
  sourceOrderNo?: string
  customerName: string
  customerPhone?: string
  hospital?: string
  dept?: string
  serviceType?: string
}
export function createOrder(input: CreateOrderInput): Promise<Order> {
  const sourceOrderNo = input.sourceOrderNo?.trim() || `SD${Date.now().toString(36).toUpperCase()}`
  return authedSend<Order>('/api/v1/orders', 'POST', {
    source: input.source,
    sourceOrderNo,
    customerName: input.customerName,
    customerPhone: input.customerPhone || null,
    hospital: input.hospital || null,
    dept: input.dept || null,
    rawJson: { serviceType: input.serviceType || undefined, manual: true }
  })
}

export function fetchOrderDetail(orderId: number): Promise<OrderDetailResponse> {
  return authedGet<OrderDetailResponse>(`/api/v1/orders/${orderId}/detail`)
}

export function fetchOrderAggregate(orderId: number): Promise<OrderAggregateResponse> {
  return authedGet<OrderAggregateResponse>(`/api/v1/orders/${orderId}/aggregate`)
}

// ─── 在线状态（状态栏用）────────────────────────────────
export interface Presence {
  extConnected: boolean // Chrome 插件 WebSocket 是否连着
  taikangTabOpen: boolean // 插件是否打开了泰康页
  mobileOnline?: boolean // 移动端 App 是否在线（心跳/近期通话上传）
  mobileState?: 'active' | 'background' | 'needs_open' | 'stale'
  mobileOnlineReason?: 'heartbeat' | 'recent_call' | null
  mobileLastSeenAt?: string | null
  mobileHeartbeatSource?: string | null
  stale: boolean
  lastSeenAt: string | null
  tokenOk?: boolean | null // 泰康登录保活
  tokenReason?: string | null
  tokenLastCheckAt?: string | null
}

/** 拉当前员工在线状态（也兼作后端健康探测：能拿到=后端在线） */
export function fetchPresence(): Promise<Presence> {
  return authedGet<Presence>('/api/v1/me/presence')
}

// ─── AI 滚动简报 ────────────────────────────────────────
// 综合微信/企微消息 + 通话/录音转写，由后端 LLM 产出。给员工的现状/阶段/待办/风险 + 回填关键信息。
export interface OrderBrief {
  summary: string | null
  stage: string | null
  stageEvidence: string | null
  hasOpenIssue: boolean
  nextActions: string[]
  risks: string[]
  keyInfo: Record<string, string | null>
  model?: string
  updatedFrom?: { lastMessageId: number; lastCallId: number }
}

/** 读已存的简报（不触发 LLM） */
export function fetchOrderBrief(orderId: number): Promise<{ brief: OrderBrief | null; updatedAt: string | null }> {
  return authedGet<{ brief: OrderBrief | null; updatedAt: string | null }>(`/api/v1/orders/${orderId}/brief`)
}

/** 手动刷新简报（触发一次 LLM，强制重算） */
export function refreshOrderBrief(orderId: number): Promise<OrderBrief> {
  return authedSend<OrderBrief>(`/api/v1/orders/${orderId}/brief/refresh`, 'POST', {})
}

export function fetchApplicationBrief(applicationNo: string): Promise<{ brief: OrderBrief | null; updatedAt: string | null }> {
  return authedGet<{ brief: OrderBrief | null; updatedAt: string | null }>(`/api/v1/applications/${encodeURIComponent(applicationNo)}/brief`)
}

export function refreshApplicationBrief(applicationNo: string): Promise<OrderBrief> {
  return authedSend<OrderBrief>(`/api/v1/applications/${encodeURIComponent(applicationNo)}/brief/refresh`, 'POST', {})
}

// ─── 通话录音：转写 + 播放 ───────────────────────────────
export interface CallTranscript {
  id: number
  asrStatus: string
  asrText: string | null
  asrFinishedAt: string | null
  dashscopeTaskId: string | null
  asrResultJson: unknown
}

/** 录音 presigned GET URL（给 <audio> 直拉播放） */
export interface CallRecordingUrl {
  status?: 'ready' | 'transcoding' | 'failed'
  url: string | null
  expiresIn: number
  mimeType?: string
  format?: string
  browserPlayable?: boolean
  message?: string
}

export function fetchCallRecordingUrl(callId: number): Promise<CallRecordingUrl> {
  return authedGet<CallRecordingUrl>(`/api/v1/calls/${callId}/recording-url`)
}

/** 通话转写文本及状态（轮询用） */
export function fetchCallTranscript(callId: number): Promise<CallTranscript> {
  return authedGet<CallTranscript>(`/api/v1/calls/${callId}/transcript`)
}

/** 手动触发重新转写 */
export function retranscribeCall(callId: number): Promise<{ callId: number; triggered: boolean }> {
  return authedSend(`/api/v1/calls/${callId}/retranscribe`, 'POST', {})
}

// ─── 素材（过程数据）─────────────────────────────────────
export interface Material {
  id: number
  orderId: number
  type: 'text' | 'image'
  textContent: string | null
  mimeType: string | null
  byteSize: number | null
  url: string | null
  createdAt: string
}

export function fetchMaterials(orderId: number): Promise<Material[]> {
  return authedGet<Material[]>(`/api/v1/materials?orderId=${orderId}`)
}

async function authedSend<T>(path: string, method: string, body?: unknown): Promise<T> {
  const code = getSession()?.employeeCode
  if (!code) throw new Error('未登录')
  const res = await fetch(`${requireBackendUrl()}${path}`, {
    method,
    headers: { 'X-Employee-Code': code, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) {
    const t = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(t.error || `请求失败（${res.status}）`)
  }
  const j = (await res.json()) as { data?: T } & T
  return (j.data ?? j) as T
}

/** 手工录入 / 粘贴文字 */
export function addTextMaterial(orderId: number, textContent: string): Promise<{ id: number }> {
  return authedSend(`/api/v1/orders/${orderId}/materials`, 'POST', {
    type: 'text',
    clientUuid: crypto.randomUUID(),
    textContent
  })
}

/** 粘贴图片（base64 不含 data: 前缀） */
export function addImageMaterial(orderId: number, mimeType: string, base64: string): Promise<{ id: number }> {
  return authedSend(`/api/v1/orders/${orderId}/materials`, 'POST', {
    type: 'image',
    clientUuid: crypto.randomUUID(),
    mimeType,
    base64
  })
}

export function deleteMaterial(id: number): Promise<unknown> {
  return authedSend(`/api/v1/materials/${id}`, 'DELETE')
}

// ─── 订单号待确认（右上角铃铛通知）──────────────────────────
// 采集到的会话识别出了订单号/短尾号，但后端仍匹配不到真实订单 → 异常，需人工确认。
export interface UnmatchedOrderRef {
  id: number
  channel: string // 'wechat' | 'wxwork'
  conversationName: string
  candidate: string // 抽到的订单号候选
  candidateKind: string // 'fwyy' | 'cod' | 'ccod' | 'od' | 'so' | 'lt' | 'tail8'
  reason: string // 'no_match' 找不到 | 'ambiguous' 多单并列 | 'name_mismatch' 名字校验未过
  bestDist: number | null
  screenshotOssKey: string | null
  capturedAt: string
  seenCount: number // 同一候选重复出现次数
  status: string // 'pending' | 'confirmed' | 'rejected'
  candidateOrders?: Array<{
    id: number
    sourceOrderNo: string
    customerName: string
    status: string
    applicationNo?: string | null
    ccodApplyNo?: string | null
  }>
  createdAt: string
  updatedAt: string
}

/** 拉取"识别到订单号/短尾号却没关联到订单"的异常（默认只看待处理） */
export function fetchUnmatchedOrderRefs(status = 'pending'): Promise<UnmatchedOrderRef[]> {
  return authedGet<UnmatchedOrderRef[]>(
    `/api/v1/unmatched-order-refs?status=${encodeURIComponent(status)}`
  )
}

/** 标记已处理（忽略）：status → rejected */
export function dismissUnmatchedOrderRef(id: number): Promise<{ ok: boolean }> {
  return authedSend(`/api/v1/unmatched-order-refs/${id}/reject`, 'POST')
}

/** 人工确认待关联订单号 → 绑定订单，并回填该会话下未关联消息 */
export function confirmUnmatchedOrderRef(
  id: number,
  orderId: number
): Promise<{ ok: boolean; backfilledMessages: number }> {
  return authedSend(`/api/v1/unmatched-order-refs/${id}/confirm`, 'POST', { orderId })
}

/**
 * 用工号和密码向后端换取身份。
 */
export async function login(employeeCode: string, password?: string): Promise<MeResponse> {
  const code = employeeCode.trim()
  if (!code) throw new Error('请输入工号')
  const backendUrl = requireBackendUrl()
  const res = await fetch(`${backendUrl}/api/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeCode: code, password })
  })
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    const text = await res.text()
    let msg = '工号不存在、密码错误或未授权，请联系管理员'
    try {
      const json = JSON.parse(text)
      if (json.error) msg = json.error
    } catch {
      //
    }
    throw new Error(msg)
  }
  if (!res.ok) {
    throw new Error(`登录失败（${res.status}），请检查服务器地址或网络`)
  }
  // 后端统一用 { data: ... } 包裹响应
  const body = (await res.json()) as { data?: MeResponse } & Partial<MeResponse>
  const me = body.data ?? (body as MeResponse)
  if (!me || !me.employeeCode) throw new Error('登录响应异常')
  return me
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  const session = getSession()
  if (!session) throw new Error('未登录或会话已过期')
  const backendUrl = requireBackendUrl()
  const res = await fetch(`${backendUrl}/api/v1/me/password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Employee-Code': session.employeeCode
    },
    body: JSON.stringify({
      employeeCode: session.employeeCode,
      oldPassword,
      newPassword
    })
  })
  if (!res.ok) {
    const text = await res.text()
    let msg = `修改密码失败（HTTP ${res.status}）`
    try {
      const json = JSON.parse(text)
      if (json.error) msg = json.error
    } catch {
      //
    }
    throw new Error(msg)
  }
}

// ─── 字典通用日期工具函数 ──────────────────────────────────────────────
export function formatDisplayDate(val?: string | null): string {
  if (!val) return '-'
  const s = String(val).trim()
  if (/^\d{8}$/.test(s)) {
    const y = parseInt(s.slice(0, 4), 10)
    const m = parseInt(s.slice(4, 6), 10)
    const d = parseInt(s.slice(6, 8), 10)
    return `${y}年${m}月${d}日`
  }
  return s
}

export function getToday8(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const date = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${date}`
}

// ─── 科室管理字典 (f_hy_kswh + f_hy_xfks) ───────────────────
export interface SubDepartmentItem {
  id: string // 数据库物理主键 (如 00010002)
  xh: string // 序号ID (如 0002)
  name_yjks: string // 所属上级科室ID (如 0001)
  name: string // 科室细分名称
  state: string // '启用' | '停用'
  u_date: string // 8位紧凑日期 (如 20231209)
}

export interface DepartmentItem {
  id: string // 一级科室ID (如 0001)
  name: string // 科室大类名称
  ms: string // 描述说明
  state: string // '启用' | '停用'
  c_date: string // 8位紧凑日期 (如 20231209)
  u_date: string // 8位紧凑日期 (如 20231209)
  subDepartments?: SubDepartmentItem[]
}

/** 从数据库获取科室字典列表 */
export async function fetchDepartments(): Promise<DepartmentItem[]> {
  const backendUrl = getBackendUrl() || 'http://localhost:13000'
  const res = await fetch(`${backendUrl}/api/v1/departments`)
  if (!res.ok) {
    throw new Error(`获取科室字典失败（HTTP ${res.status}）`)
  }
  const body = (await res.json()) as { ok?: boolean; data?: DepartmentItem[] }
  return body.data || []
}

/** 批量保存科室字典数据至数据库 */
export async function saveDepartments(departments: DepartmentItem[]): Promise<void> {
  const backendUrl = getBackendUrl() || 'http://localhost:13000'
  const res = await fetch(`${backendUrl}/api/v1/departments/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(departments)
  })
  if (!res.ok) {
    const text = await res.text()
    let msg = `保存科室字典失败（HTTP ${res.status}）`
    try {
      const json = JSON.parse(text)
      if (json.error) msg = json.error
    } catch {
      //
    }
    throw new Error(msg)
  }
}

// ─── 医院管理字典 (f_hy_yywh + f_hy_yy_ks) ───────────────────
export interface HospitalDeptItem {
  id: string // 如 00010001
  xh: string // 如 0001
  id_yy: string // 所属医院ID 如 0001
  name: string // 医院对外科室名称
  ksdl: string // 对应对内一级科室 (如 0002)
  ksxf: string // 对应对内二级科室 (如 00020001)
  state: string // '启用' | '停用'
  u_date: string // 8位日期
}
export type ExternalDepartmentItem = HospitalDeptItem

export interface HospitalItem {
  id: string // 医院ID (如 0001)
  name: string // 医院名称
  level: string // 级别
  bq: string // 标签
  dq: string // 地区
  dz: string // 总地址
  tips: string // 就医提示
  bz: string // 备注
  state: string // '启用' | '停用'
  dz1: string // 地址1
  dz2: string // 地址2
  dz3: string // 地址3
  dq_sf: string // 省份
  dq_cs: string // 城市
  c_date: string // 8位日期
  u_date: string // 8位日期
  externalDepartments?: HospitalDeptItem[]
}

export async function fetchHospitals(): Promise<HospitalItem[]> {
  const backendUrl = getBackendUrl() || 'http://localhost:13000'
  const res = await fetch(`${backendUrl}/api/v1/hospitals`)
  if (!res.ok) throw new Error(`获取医院字典失败（HTTP ${res.status}）`)
  const body = (await res.json()) as { ok?: boolean; data?: HospitalItem[] }
  return body.data || []
}

export async function saveHospitals(hospitals: HospitalItem[]): Promise<void> {
  const backendUrl = getBackendUrl() || 'http://localhost:13000'
  const res = await fetch(`${backendUrl}/api/v1/hospitals/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(hospitals)
  })
  if (!res.ok) {
    const text = await res.text()
    let msg = `保存医院字典失败（HTTP ${res.status}）`
    try {
      const json = JSON.parse(text)
      if (json.error) msg = json.error
    } catch {
      //
    }
    throw new Error(msg)
  }
}

// ─── 医生档案字典 (f_hy_ys) ───────────────────
export interface DoctorItem {
  id: string // 5位如 00001
  name: string // 姓名
  sex: string // 性别 (男 / 女)
  tel: string // 手机
  em: string // 邮箱
  dq_sf: string // 省份
  dq_cs: string // 城市
  yy: string // 所属医院编码
  dwks: string // 所属对外科室编码
  zc: string // 临床职称
  jxzc: string // 教学职称
  yyxzzw: string // 医院行政职务
  shrz: string // 社会任职
  sc: string // 擅长领域
  bz: string // 备注
  state: string // '启用' | '停用'
  csrq: string // 出生日期 (如 19800101)
  c_date: string // 创建时间 (8位如 20231209)
  u_date: string // 更新时间 (8位如 20231209)
}

export async function fetchDoctors(): Promise<DoctorItem[]> {
  const backendUrl = getBackendUrl() || 'http://localhost:13000'
  const res = await fetch(`${backendUrl}/api/v1/doctors`)
  if (!res.ok) throw new Error(`获取医生字典失败（HTTP ${res.status}）`)
  const body = (await res.json()) as { ok?: boolean; data?: DoctorItem[] }
  return body.data || []
}

export async function saveDoctors(doctors: DoctorItem[]): Promise<void> {
  const backendUrl = getBackendUrl() || 'http://localhost:13000'
  const res = await fetch(`${backendUrl}/api/v1/doctors/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doctors)
  })
  if (!res.ok) {
    const text = await res.text()
    let msg = `保存医生字典失败（HTTP ${res.status}）`
    try {
      const json = JSON.parse(text)
      if (json.error) msg = json.error
    } catch {
      //
    }
    throw new Error(msg)
  }
}

// ─── 渠道管理字典 (f_hy_qd + f_hy_cp_qd) ───────────────────
export interface ChannelProductItem {
  id: string // 7位如 0001001
  xh: string // 3位如 001
  id_yj: string // 所属渠道ID如 0001
  name: string // 渠道产品名称
  cpjg: number // 渠道价格
  nbyjcp: string // 对应对内一级产品
  nbejcp: string // 对应对内二级产品
  state: string // '启用' | '停用'
  u_date: string // 8位更新时间
}

export interface ChannelItem {
  id: string // 渠道ID如 0001
  name: string // 渠道名称
  state: string // '启用' | '停用'
  c_date: string // 创建时间
  u_date: string // 更新时间
  products?: ChannelProductItem[]
}

export async function fetchChannels(): Promise<ChannelItem[]> {
  const backendUrl = getBackendUrl() || 'http://localhost:13000'
  const res = await fetch(`${backendUrl}/api/v1/channels`)
  if (!res.ok) throw new Error(`获取渠道字典失败（HTTP ${res.status}）`)
  const body = (await res.json()) as { ok?: boolean; data?: ChannelItem[] }
  return body.data || []
}

export async function saveChannels(channels: ChannelItem[]): Promise<void> {
  const backendUrl = getBackendUrl() || 'http://localhost:13000'
  const res = await fetch(`${backendUrl}/api/v1/channels/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(channels)
  })
  if (!res.ok) {
    const text = await res.text()
    let msg = `保存渠道字典失败（HTTP ${res.status}）`
    try {
      const json = JSON.parse(text)
      if (json.error) msg = json.error
    } catch {
      //
    }
    throw new Error(msg)
  }
}

// ─── 对内产品字典 (f_hy_cp + f_hy_zcp) ───────────────────
export interface SubProductItem {
  id: string // 8位如 00010001
  xh: string // 4位如 0001
  id_yj: string // 所属产品大类如 0001
  name: string // 子产品名称
  state: string // '启用' | '停用'
  u_date: string // 8位更新时间
}

export interface InternalProductItem {
  id: string // 4位如 0001
  name: string // 产品大类名称
  ms: string // 体系描述
  lx: string // 产品类型
  state: string // '启用' | '停用'
  c_date: string // 创建时间
  u_date: string // 更新时间
  subProducts?: SubProductItem[]
}

export async function fetchInternalProducts(): Promise<InternalProductItem[]> {
  const backendUrl = getBackendUrl() || 'http://localhost:13000'
  const res = await fetch(`${backendUrl}/api/v1/internal-products`)
  if (!res.ok) throw new Error(`获取对内产品字典失败（HTTP ${res.status}）`)
  const body = (await res.json()) as { ok?: boolean; data?: InternalProductItem[] }
  return body.data || []
}

export async function saveInternalProducts(products: InternalProductItem[]): Promise<void> {
  const backendUrl = getBackendUrl() || 'http://localhost:13000'
  const res = await fetch(`${backendUrl}/api/v1/internal-products/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(products)
  })
  if (!res.ok) {
    const text = await res.text()
    let msg = `保存对内产品字典失败（HTTP ${res.status}）`
    try {
      const json = JSON.parse(text)
      if (json.error) msg = json.error
    } catch {
      //
    }
    throw new Error(msg)
  }
}

// ─── 支付渠道字典 (zfqd) ───────────────────
export interface PaymentChannelItem {
  id: string // 4位如 0001
  name: string // 支付渠道名称
  yy: string // 所属医院编码
  start: string // '启用' | '停用'
  zf_id: string // 支付商户号/平台账号ID
  by1: string // 省份编码
  by2: string // 城市编码
  c_date?: string
  u_date: string
}

export async function fetchPaymentChannels(): Promise<PaymentChannelItem[]> {
  const backendUrl = getBackendUrl() || 'http://localhost:13000'
  const res = await fetch(`${backendUrl}/api/v1/payment-channels`)
  if (!res.ok) throw new Error(`获取支付渠道字典失败（HTTP ${res.status}）`)
  const body = (await res.json()) as { ok?: boolean; data?: PaymentChannelItem[] }
  return body.data || []
}

export async function savePaymentChannels(paymentChannels: PaymentChannelItem[]): Promise<void> {
  const backendUrl = getBackendUrl() || 'http://localhost:13000'
  const res = await fetch(`${backendUrl}/api/v1/payment-channels/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(paymentChannels)
  })
  if (!res.ok) {
    const text = await res.text()
    let msg = `保存支付渠道字典失败（HTTP ${res.status}）`
    try {
      const json = JSON.parse(text)
      if (json.error) msg = json.error
    } catch {
      //
    }
    throw new Error(msg)
  }
}

// ─── 陪诊人员字典 (f_hy_pzr) ───────────────────
export interface EscortItem {
  id: string // 5位如 00001
  name: string // 陪诊人姓名
  xb: string // 性别 (男 / 女)
  sj: string // 手机号码
  sf: string // 省份编码
  cs: string // 城市编码
  pzrlx: string // 陪诊人员类型 (外包 / 本部)
  bz: string // 备注信息
  state: string // '启用' | '停用'
  c_date: string // 创建时间
  u_date: string // 更新时间
}

export async function fetchEscorts(): Promise<EscortItem[]> {
  const backendUrl = getBackendUrl() || 'http://localhost:13000'
  const res = await fetch(`${backendUrl}/api/v1/escorts`)
  if (!res.ok) throw new Error(`获取陪诊人员字典失败（HTTP ${res.status}）`)
  const body = (await res.json()) as { ok?: boolean; data?: EscortItem[] }
  return body.data || []
}

export async function saveEscorts(escorts: EscortItem[]): Promise<void> {
  const backendUrl = getBackendUrl() || 'http://localhost:13000'
  const res = await fetch(`${backendUrl}/api/v1/escorts/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(escorts)
  })
  if (!res.ok) {
    const text = await res.text()
    let msg = `保存陪诊人员字典失败（HTTP ${res.status}）`
    try {
      const json = JSON.parse(text)
      if (json.error) msg = json.error
    } catch {
      //
    }
    throw new Error(msg)
  }
}

// ─── 城市列表字典 (dim_cslb) ───────────────────
export interface RegionCityItem {
  s_id: string
  s_name: string
  x_id: string
  x_name: string
}

export async function fetchRegions(): Promise<RegionCityItem[]> {
  const backendUrl = getBackendUrl() || 'http://localhost:13000'
  const res = await fetch(`${backendUrl}/api/v1/regions`)
  if (!res.ok) throw new Error(`获取省市字典失败（HTTP ${res.status}）`)
  const body = (await res.json()) as { ok?: boolean; data?: RegionCityItem[] }
  return body.data || []
}



