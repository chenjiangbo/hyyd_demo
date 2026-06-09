/**
 * 后端 API 客户端
 * MVP 现场版：服务器地址和员工 ID 从 localStorage 读取。
 */

export const DEFAULT_BACKEND_URL = 'http://47.95.14.233:9093'
export const DEFAULT_EMPLOYEE_CODE = 'huanyu-field-1'

export interface ClientConfig {
  backendUrl: string
  employeeCode: string
}

export function getClientConfig(): ClientConfig {
  return {
    backendUrl: localStorage.getItem('huanyu.backendUrl') || DEFAULT_BACKEND_URL,
    employeeCode: localStorage.getItem('huanyu.employeeCode') || DEFAULT_EMPLOYEE_CODE
  }
}

export function setClientConfig(config: ClientConfig): void {
  localStorage.setItem('huanyu.backendUrl', config.backendUrl.trim().replace(/\/$/, ''))
  localStorage.setItem('huanyu.employeeCode', config.employeeCode.trim())
}

interface ApiEnvelope<T> {
  data?: T
  error?: string
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const config = getClientConfig()
  const res = await fetch(`${config.backendUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Employee-Code': config.employeeCode,
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
    caseInfo?: Record<string, any> | null
    intendClinicInfo?: Record<string, any> | null
    latestRegisterInfo?: Record<string, any> | null
    hospitalAddr?: Record<string, any> | null
    exceInfo?: any
  } | null
  attachments: OrderAttachment[]
}

export interface Presence {
  extConnected: boolean
  taikangTabOpen: boolean
  trackingPoolPageActive: boolean
  mode: 'pool_reader' | 'worker'
  stale: boolean
  lastSeenAt: string | null
  tokenOk: boolean | null
  tokenReason: string | null
  tokenLastCheckAt: string | null
}

export const api = {
  getClientConfig,
  setClientConfig,

  /** 健康检查 */
  async health(): Promise<{ status: string; timestamp: string }> {
    const { backendUrl } = getClientConfig()
    const res = await fetch(`${backendUrl}/health`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  },

  getMe() {
    return request<{ id: number; employeeCode: string; displayName: string }>('/api/v1/me')
  },

  /** 当前员工的插件 presence 状态 */
  getPresence() {
    return request<Presence>('/api/v1/me/presence')
  },

  /** 查询订单列表 */
  listOrders(params: { status?: string; source?: string; assignedEmployeeId?: number; assignedEmployeeCode?: string } = {}) {
    const q = new URLSearchParams()
    if (params.status) q.set('status', params.status)
    if (params.source) q.set('source', params.source)
    if (params.assignedEmployeeId !== undefined) {
      q.set('assignedEmployeeId', String(params.assignedEmployeeId))
    }
    if (params.assignedEmployeeCode !== undefined) {
      q.set('assignedEmployeeCode', params.assignedEmployeeCode)
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
        body: '{}'
      }
    )
  },

  /** 获取订单详情（caseInfo + 附件 presigned URLs） */
  getOrderDetail(orderId: number) {
    return request<OrderDetailResponse>(`/api/v1/orders/${orderId}/detail`)
  },

  /** 手动重抓订单详情（给当前申领者插件下发 fetch_detail 指令） */
  refreshOrderDetail(orderId: number) {
    return request<{ commandId: number }>(
      `/api/v1/orders/${orderId}/refresh-detail`,
      { method: 'POST', body: '{}' }
    )
  },

  /** 通话记录列表（当前员工） */
  listCalls() {
    return request<CallSummary[]>('/api/v1/calls')
  },

  /** 通话录音 presigned GET URL（给 <audio> 直拉） */
  getCallRecordingUrl(callId: number) {
    return request<{ url: string; expiresIn: number }>(
      `/api/v1/calls/${callId}/recording-url`
    )
  },

  /** 通话转写文本及状态 */
  getCallTranscript(callId: number) {
    return request<CallTranscript>(`/api/v1/calls/${callId}/transcript`)
  },

  /** 触发重新转写（pending → processing） */
  retranscribeCall(callId: number) {
    return request<{ callId: number; triggered: boolean }>(
      `/api/v1/calls/${callId}/retranscribe`,
      { method: 'POST', body: '{}' }
    )
  },

  /** 通话 AI 分析结论（最新一条 type='call' 的 AiSummary） */
  getCallAiSummary(callId: number) {
    return request<CallAiSummary | null>(`/api/v1/calls/${callId}/ai-summary`)
  },

  /** 会话列表（当前员工的微信/企微会话聚合） */
  listConversations(channel?: 'wechat' | 'wxwork') {
    const qs = channel ? `?channel=${channel}` : ''
    return request<Conversation[]>(`/api/v1/conversations${qs}`)
  },

  /** 单个会话的全部消息（含关联订单） */
  getConversationMessages(channel: 'wechat' | 'wxwork', conversationName: string) {
    return request<ConversationMessages>(
      `/api/v1/conversations/${channel}/${encodeURIComponent(conversationName)}/messages`
    )
  },

  /** 消息截图 presigned URL */
  getMessageScreenshotUrl(messageId: number) {
    return request<{ url: string; expiresIn: number }>(
      `/api/v1/messages/${messageId}/screenshot-url`
    )
  },

  /** 订单的消息类 AI 摘要（最新一条 type='message'） */
  getOrderMessagesAiSummary(orderId: number) {
    return request<MessageAiSummary | null>(`/api/v1/orders/${orderId}/messages/ai-summary`)
  }
}

// ───── 消息相关类型 ─────────────────────────────────────────
export type MessageChannel = 'wechat' | 'wxwork'

export interface ConversationOrder {
  id: number
  sourceOrderNo: string
  customerName: string
  status: string
}

export interface Conversation {
  channel: MessageChannel
  conversationName: string
  messageCount: number
  lastMessageAt: string
  lastMessagePreview: string
  order: ConversationOrder | null
}

export interface ChatMessage {
  id: number
  senderName: string | null
  contentText: string
  capturedAt: string
  isMine: boolean
  hasScreenshot: boolean
  orderId: number | null
}

export interface ConversationMessages {
  messages: ChatMessage[]
  order: ConversationOrder | null
}

export interface MessageAiSummary {
  id: number
  content: string
  model: string
  createdAt: string
}

export type AsrStatus = 'no_recording' | 'pending' | 'processing' | 'done' | 'failed' | 'requires_manual'

export interface CallSummary {
  id: number
  phone: string
  contactName: string | null
  direction: 'in' | 'out'
  callStatus: 'answered' | 'missed' | 'rejected' | 'outgoing_unanswered'
  durationSec: number
  startedAt: string
  asrStatus: AsrStatus
  asrFinishedAt: string | null
  hasRecording: boolean
  order: null | {
    id: number
    sourceOrderNo: string
    customerName: string
    status: string
  }
}

export interface CallTranscript {
  id: number
  asrStatus: AsrStatus
  asrText: string | null
  asrFinishedAt: string | null
  dashscopeTaskId: string | null
  asrResultJson: any
}

export interface CallAiSummary {
  id: number
  content: string
  model: string
  inferredOrderId: number
  createdAt: string
}
