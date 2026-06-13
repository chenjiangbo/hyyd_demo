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
