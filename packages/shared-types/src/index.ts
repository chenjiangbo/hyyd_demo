export type OrderSource = 'taikang' | 'pingan'
export type OrderStatus = '候选' | '已申领' | '进行中' | '完成'
export type CommandTarget = 'ext' | 'tray'
export type CommandAction = 'claim' | 'fill_form'
export type CommandStatus = 'pending' | 'done' | 'failed' | 'requires_manual'
export type MessageChannel = 'wechat' | 'wxwork'
export type CallDirection = 'in' | 'out'
export type AsrStatus = 'pending' | 'processing' | 'done' | 'failed'
export type SummaryType = 'call' | 'message' | 'full'

export interface Employee {
  id: number
  name: string
  phone: string
  wechatId: string | null
  taikangAccount: string | null
  token: string
}

export interface Order {
  id: number
  source: OrderSource
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

export interface Message {
  id: number
  orderId: number | null
  channel: MessageChannel
  conversationName: string
  senderName: string | null
  contentText: string
  screenshotOssKey: string | null
  capturedAt: string
  employeeId: number
}

export interface Call {
  id: number
  orderId: number | null
  employeeId: number
  phone: string
  direction: CallDirection
  durationSec: number
  startedAt: string
  recordingOssKey: string | null
  asrText: string | null
  asrStatus: AsrStatus
}

export interface Command {
  id: number
  target: CommandTarget
  action: CommandAction
  payloadJson: Record<string, unknown>
  status: CommandStatus
  createdAt: string
  executedAt: string | null
}

export interface AiSummary {
  id: number
  orderId: number
  type: SummaryType
  content: string
  model: string
  createdAt: string
}

export interface OrderAggregate extends Order {
  messages: Message[]
  calls: Call[]
  aiSummaries: AiSummary[]
}

// API 请求/响应类型
export interface ApiResponse<T> {
  data: T
  error?: string
}

export interface ClaimOrderPayload {
  employeeId: number
}

export interface CreateOrderPayload {
  source: OrderSource
  sourceOrderNo: string
  customerName: string
  customerPhone?: string
  hospital?: string
  dept?: string
  doctor?: string
  rawJson?: Record<string, unknown>
}

export interface CreateMessagePayload {
  channel: MessageChannel
  conversationName: string
  senderName?: string
  contentText: string
  screenshotOssKey?: string
  capturedAt: string
  employeeId: number
  orderId?: number
}

export interface CreateCallPayload {
  employeeId: number
  phone: string
  direction: CallDirection
  durationSec: number
  startedAt: string
  orderId?: number
}

export interface CreateRecordingPayload {
  callId: number
  ossKey: string
  durationSec: number
}

export interface CommandDonePayload {
  result?: Record<string, unknown>
  error?: string
}
