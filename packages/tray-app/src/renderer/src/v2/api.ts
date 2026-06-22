/**
 * v2 最终功能版 · 后端访问层（只读复用现有 backend HTTP 接口）
 *
 * 说明：所有调用走 HTTP，不依赖 Electron IPC。
 * 登录工号存在 localStorage，键名与采集版（v1）隔开，互不干扰。
 */

const LS_EMPLOYEE = 'hyyd.v2.employeeCode'
const LS_DISPLAYNAME = 'hyyd.v2.displayName'

// 后端地址写死、不可配置：
// tray-app 运行在员工 Windows 机（现为公司内网的荣耀笔记本），通过内网访问跑在 Mac 上的后端。
// Mac 内网 IP 当前为 192.168.2.227（后端监听 0.0.0.0，对 Mac 自身浏览器预览同样可达）。
// 注意：Mac 是 DHCP，IP 变了这里要同步改；建议给 Mac 绑固定内网 IP。
const BACKEND_URL = 'http://192.168.2.227:13000'

export function getBackendUrl(): string {
  return BACKEND_URL
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

export interface OrderAggregateResponse {
  id: number
  calls: OrderCall[]
}

async function authedGet<T>(path: string): Promise<T> {
  const code = getSession()?.employeeCode
  if (!code) throw new Error('未登录')
  const res = await fetch(`${getBackendUrl()}${path}`, {
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

/** 待申领池：全局"候选"状态订单（任何员工可申领） */
export function fetchClaimableOrders(): Promise<Order[]> {
  return authedGet<Order[]>('/api/v1/orders?status=候选')
}

/** 申领一张订单（→ 已申领，分配给当前登录员工） */
export function claimOrder(orderId: number): Promise<{ order: Order; commandId: number }> {
  return authedSend<{ order: Order; commandId: number }>(`/api/v1/orders/${orderId}/claim`, 'POST', {})
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
  mobileState?: 'active' | 'background' | 'stale'
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
  const res = await fetch(`${getBackendUrl()}${path}`, {
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

/**
 * 用工号向后端换取身份。现阶段后端没有密码体系，
 * 鉴权只认 X-Employee-Code，所以"登录"= 校验工号存在。
 */
export async function login(employeeCode: string): Promise<MeResponse> {
  const code = employeeCode.trim()
  if (!code) throw new Error('请输入工号')
  const res = await fetch(`${getBackendUrl()}/api/v1/me`, {
    headers: { 'X-Employee-Code': code }
  })
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new Error('工号不存在或未授权，请联系管理员')
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
