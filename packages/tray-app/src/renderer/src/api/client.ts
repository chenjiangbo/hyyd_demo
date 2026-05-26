/**
 * 后端 API 客户端
 * MVP 阶段：员工 Token + 后端地址硬编码，后续从 localStorage 或配置弹窗读取
 */

export const BACKEND_URL = 'http://localhost:13000'
export const EMPLOYEE_TOKEN = 'test-employee-token'
export const EMPLOYEE_ID = 1 // 临时硬编码，对应数据库 seed 的第一个员工

interface ApiEnvelope<T> {
  data?: T
  error?: string
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Employee-Token': EMPLOYEE_TOKEN,
      ...(options.headers ?? {})
    }
  })

  let json: ApiEnvelope<T> | null = null
  try {
    json = (await res.json()) as ApiEnvelope<T>
  } catch {
    // 非 JSON 响应
  }

  if (!res.ok) {
    throw new Error(json?.error ?? `HTTP ${res.status} ${res.statusText}`)
  }
  if (json?.error) throw new Error(json.error)
  return (json?.data ?? (json as unknown as T))
}

export type OrderStatus = '候选' | '已申领' | '进行中' | '完成'

export interface Order {
  id: number
  source: string
  sourceOrderNo: string
  customerName: string
  customerPhone: string | null
  hospital: string | null
  dept: string | null
  doctor: string | null
  status: OrderStatus
  assignedEmployeeId: number | null
  rawJson: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

export const api = {
  EMPLOYEE_ID,
  EMPLOYEE_TOKEN,
  BACKEND_URL,

  /** 健康检查 */
  async health(): Promise<{ status: string; timestamp: string }> {
    const res = await fetch(`${BACKEND_URL}/health`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  },

  /** 查询订单列表 */
  listOrders(params: { status?: string; source?: string; assignedEmployeeId?: number } = {}) {
    const q = new URLSearchParams()
    if (params.status) q.set('status', params.status)
    if (params.source) q.set('source', params.source)
    if (params.assignedEmployeeId !== undefined) {
      q.set('assignedEmployeeId', String(params.assignedEmployeeId))
    }
    const qs = q.toString()
    return request<Order[]>(`/api/v1/orders${qs ? `?${qs}` : ''}`)
  },

  /** 申领订单：后端会推 WebSocket 指令到浏览器插件 */
  claim(orderId: number) {
    return request<{ order: Order; commandId: number }>(
      `/api/v1/orders/${orderId}/claim`,
      {
        method: 'POST',
        body: JSON.stringify({ employeeId: EMPLOYEE_ID })
      }
    )
  }
}
