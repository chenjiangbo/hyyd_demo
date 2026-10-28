export type OrderSource = 'taikang' | 'pingan'
export type OrderStatus = '候选' | '已申领' | '进行中' | '完成'
export type CommandTarget = 'ext' | 'tray'
export type CommandAction = 'claim' | 'fill_form'
export type CommandStatus = 'pending' | 'done' | 'failed' | 'requires_manual'
export type MessageChannel = 'wechat' | 'wxwork'
export type CallDirection = 'in' | 'out'
export type CallStatus = 'answered' | 'missed' | 'rejected' | 'outgoing_unanswered'
export type AsrStatus = 'no_recording' | 'pending' | 'processing' | 'done' | 'failed' | 'requires_manual'
export type SummaryType = 'call' | 'message' | 'full'

/** Normalized message kinds shared by WeChat and WeCom adapters. */
export type NativeChatMessageKind =
  | 'text'
  | 'image'
  | 'file'
  | 'video'
  | 'audio'
  | 'voice'
  | 'link'
  | 'location'
  | 'emoji'
  | 'system'
  | 'merged'
  | 'unknown'

export type NativeChatDirection = 'incoming' | 'outgoing' | 'system' | 'unknown'

export type NativeChatAttachmentState =
  | 'available'
  | 'not_downloaded'
  | 'not_found'
  | 'ambiguous'
  | 'invalid'
  | 'unsupported'
  | 'error'

/** Source-side attachment details used by collectors and downstream message handling. */
export interface NativeChatAttachmentSourceMetadata extends Record<string, unknown> {
  rendition?: 'thumbnail' | 'non_thumbnail' | 'missing' | 'unverified'
  nonThumbnailState?: 'pending' | 'available'
  originalName?: string | null
  localName?: string | null
  resolutionState?: 'size_mismatch' | 'ambiguous'
  imageAnalysis?: {
    status: 'pending' | 'processing' | 'retrying' | 'completed' | 'failed'
    imageType?: string | null
    typeDescription?: string | null
    description?: string | null
    visibleText?: string | null
    visibleFields?: Array<{ label: string; value: string }>
    kind?: string | null
    summary?: string | null
    model?: string | null
    promptVersion?: string | null
    attemptCount?: number
    registrationMatch?: Record<string, unknown>
  }
}

/** Stable conversation identity comes from the source client, not its display name. */
export interface NativeChatConversation {
  channel: MessageChannel
  accountId: string
  sourceConversationId: string
  title: string | null
  kind: 'group' | 'single' | 'service' | 'unknown'
  /** Optional source-specific values retained for diagnostics and future adapter improvements. */
  sourceMetadata?: Record<string, unknown> | null
}

/** A source message normalized without discarding the platform's original type code. */
export interface NativeChatMessage {
  channel: MessageChannel
  accountId: string
  sourceConversationId: string
  sourceMessageId: string
  parentSourceMessageId?: string | null
  sourceItemIndex?: number | null
  direction: NativeChatDirection
  senderId?: string | null
  senderName?: string | null
  kind: NativeChatMessageKind
  /** Original WeChat/WeCom type code, kept as a string because source encodings differ. */
  sourceTypeCode?: string | null
  text?: string | null
  occurredAt: string
  observedAt: string
  sourceMetadata?: Record<string, unknown> | null
  attachments?: NativeChatAttachment[]
}

export interface NativeChatAttachment {
  sourceAttachmentId: string
  kind: 'image' | 'file' | 'video' | 'audio' | 'voice' | 'other'
  fileName?: string | null
  mimeType?: string | null
  byteSize?: number | null
  state: NativeChatAttachmentState
  /** Local path is an adapter-to-main-process handoff value, not a backend storage URL. */
  localPath?: string | null
  sourceMetadata?: NativeChatAttachmentSourceMetadata | null
}

export interface NativeChatImageMatchOrder {
  orderId: number
  sourceOrderNo: string
  customerName: string
  serviceType: string | null
  hospital: string | null
  department: string | null
  doctor: string | null
  appointmentDate: string | null
  status: string
}

export interface NativeChatImageMatchApplication {
  applicationNo: string
  programEvidence: string[]
  orders: NativeChatImageMatchOrder[]
}

export interface NativeChatPendingImageMatch {
  attachmentId: number
  messageId: number
  fileName: string | null
  imageUrl: string
  occurredAt: string
  channel: string
  senderName: string | null
  applicationNo: string | null
  description: string
  candidateApplications: NativeChatImageMatchApplication[]
  applicationDecision: string
  orderDecision: string
  reason: string
}

export type NativeChatConversationMatch = 'source_id' | 'title_exact' | 'title_contains' | 'title_regex'

export interface NativeChatCollectionRule {
  id: string
  enabled: boolean
  channel: MessageChannel | 'both'
  match: NativeChatConversationMatch
  value: string
}

export interface NativeChatCollectionConfig {
  version: number
  updatedAt: string | null
  rules: NativeChatCollectionRule[]
}

export interface Employee {
  id: number
  name: string
  phone: string
  wechatId: string | null
  taikangAccount: string | null
  employeeCode: string
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
  applicationNo: string | null
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
  applicationNo: string | null
  employeeId: number
  phone: string
  contactName: string | null
  direction: CallDirection
  callStatus: CallStatus
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
  // true=只在我方库标记申领，不下发插件指令、不对泰康做写操作（待申领页"只展示"模式）
  skipTaikang?: boolean
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
  /** 已登录时可省略：后端优先用鉴权头 X-Employee-Code 对应的员工 */
  employeeId?: number
  orderId?: number
  /**
   * 屏幕上 OCR 抽到的订单号候选（可能含 OCR 误差，如把 1 认成 l）。
   * 后端用「易混字符归一 + 编辑距离 ≤2」在该员工订单里模糊解析，优先级高于按会话标题抽取。
   */
  orderNoCandidate?: string
}

export interface CreateCallPayload {
  phone: string
  contactName?: string
  direction: CallDirection
  callStatus: CallStatus
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
