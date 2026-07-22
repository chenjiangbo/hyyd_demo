// 管理后台 API 响应类型。字段与后端 routes/admin.ts 一一对应。

export interface DashboardSummary {
  orders: { total: number; register: number; general: number }
  materials: { total: number; text: number; image: number }
  calls: { total: number; done: number; doneRate: number }
  employees: { online: number; total: number }
  messages: { total: number; self: number; other: number }
  unmatchedPending: number
}

// 采集质量 + 简报健康（/dashboard/capture-quality）
export interface CaptureQuality {
  quality: {
    messagesToday: number
    dedupHit: number // 跨帧去重命中（被合并的重复截取次数）
    chatTimeMissing: number // 今日算不出真实聊天时间的非系统消息条数
    image: { today: number; processed: number; successRate: number | null }
  }
  brief: {
    ordersWithMessages: number
    generated: number
    stale: number // 简报水位落后于最新消息
    missing: number // 有消息但还没生成简报
  }
}

// 每员工采集健康（/capture/health）
export interface CaptureHealthRow {
  employeeId: number
  name: string
  online: boolean
  extOnline: boolean
  trayOnline: boolean
  lastSeenAt: string | null
  tokenOk: boolean | null
  lastCaptureAt: string | null
  messages: { hour: number; today: number }
  materials: { hour: number; today: number }
  calls: { hour: number; today: number }
}

// 待确认订单号（/unmatched-order-refs）
export interface UnmatchedRefItem {
  id: number
  employee: { id: number; name: string } | null
  channel: string
  conversationName: string
  candidate: string
  candidateKind: string
  reason: string // no_match | ambiguous | name_mismatch
  bestDist: number | null
  candidateOrders: Array<{ id: number; sourceOrderNo: string; customerName: string }>
  seenCount: number
  status: string
  capturedAt: string
  createdAt: string
  updatedAt: string
  screenshotUrl: string | null
}

// 订单详情里的结构化消息
export interface OrderMessage {
  id: number
  channel: string
  conversationName: string
  senderName: string | null
  senderType: string // self | other | system
  kind: string | null
  contentText: string
  chatTime: string | null
  sortTime: string | null
  capturedAt: string
  seenCount: number
  screenshotUrl: string | null
}

export interface AdminMessageItem extends OrderMessage {
  applicationNo: string | null
  order?: OrderRef | null
  applicationOrders?: OrderRef[]
  employee?: EmployeeRef
}

export interface TimeseriesPoint {
  date: string // YYYY-MM-DD
  text: number
  image: number
  orders: number
}

export interface AdminAlert {
  level: 'red' | 'yellow'
  kind: string
  message: string
  employeeId?: number
}

export interface EmployeeRow {
  id: number
  name: string
  token: string
  phone: string
  online: boolean
  clients: { ext: boolean; tray: boolean }
  lastSeenAt: string | null
  tokenOk: boolean | null
  tokenLastCheckAt: string | null
  orderCount: number
  weekOrderCount: number
  materialText: number
  materialImage: number
  lastMaterialAt: string | null
  callCount: number
  callDone: number
  callFailed: number
}

// ───── Phase 2 ─────

export interface OrderRef {
  id: number
  sourceOrderNo: string
  customerName: string
  customerPhone?: string | null
  status?: string
}

// 员工"有素材的订单"聚合项（素材页客户切换器用）
export interface MaterialOrderGroup {
  orderId: number
  sourceOrderNo: string
  applyNo: string | null
  customerName: string
  customerPhone: string | null
  status: string | null
  materialCount: number
  lastMaterialAt: string | null
}
export interface EmployeeRef {
  id: number
  name: string
}

export interface CursorPage<T> {
  items: T[]
  nextCursor: string | null
}

export interface EmployeeDetail {
  id: number
  name: string
  token: string
  phone: string
  presence: {
    online: boolean
    extConnected: boolean
    trayConnected: boolean
    trayLastSeenAt: string | null
    taikangTabOpen: boolean
    lastSeenAt: string | null
    tokenOk: boolean | null
    tokenReason: string | null
    tokenLastCheckAt: string | null
  }
  stats: {
    orderCount: number
    materialText: number
    materialImage: number
    lastMaterialAt: string | null
    callTotal: number
    callByStatus: Record<string, number>
  }
}

export interface EmployeeOrderRow {
  id: number
  sourceOrderNo: string
  customerName: string
  customerPhone: string | null
  hospital: string | null
  status: string
  poolType: string | null
  detailFetchedAt: string | null
  attachmentCount: number
  materialCount: number
  callCount: number
  lastMaterialAt: string | null
  createdAt: string
}

export interface OrderListItem {
  id: number
  sourceOrderNo: string
  customerName: string
  customerPhone: string | null
  hospital: string | null
  status: string
  poolType: string | null
  detailFetchedAt: string | null
  employee: EmployeeRef | null
  attachmentCount: number
  materialCount: number
  callCount: number
  wechatMessageCount?: number
  wxworkMessageCount?: number
  recordingCount?: number
  createdAt: string
}

export interface MaterialItem {
  id: number
  orderId: number
  employeeId: number
  type: 'text' | 'image'
  textPreview: string | null
  textTruncated: boolean
  imageUrl: string | null
  mimeType: string | null
  byteSize: number | null
  createdAt: string
  order?: OrderRef
  employee?: EmployeeRef
}

export interface MaterialDetail {
  id: number
  type: 'text' | 'image'
  textContent: string | null
  imageUrl: string | null
  mimeType: string | null
  byteSize: number | null
  createdAt: string
  order: OrderRef
  employee: EmployeeRef
}

export type AsrStatus =
  | 'no_recording'
  | 'pending'
  | 'processing'
  | 'done'
  | 'failed'
  | 'requires_manual'

export interface CallItem {
  id: number
  phone: string
  contactName: string | null
  direction: 'in' | 'out'
  callStatus: string
  durationSec: number
  startedAt: string
  applicationNo: string | null
  asrStatus: AsrStatus
  asrText: string | null
  asrTextPreview: string | null
  asrTextTruncated: boolean
  hasRecording: boolean
  order?: OrderRef | null
  applicationOrders?: OrderRef[]
  employee?: EmployeeRef
}

export interface OrderAttachmentItem {
  id: number
  fileType: string
  fileName: string
  mimeType: string
  byteSize: number
  url: string | null
}

export interface OrderFull {
  order: {
    id: number
    source: string
    sourceOrderNo: string
    customerName: string
    customerPhone: string | null
    hospital: string | null
    dept: string | null
    doctor: string | null
    status: string
    poolType: string | null
    detailFetchedAt: string | null
    createdAt: string
    updatedAt: string
    employee: { id: number; name: string; token: string } | null
  }
  recommendations: Record<string, any> | null
  brief: {
    json: Record<string, any> | null
    updatedAt: string | null
    lastMsgId: number | null
    lastCallId: number | null
    lastMaterialId: number | null
  }
  messages: OrderMessage[]
  statusHistory: Array<{
    id: number
    orderState: string | null
    orderStateName: string | null
    recordedAt: string
  }>
  attachments: OrderAttachmentItem[]
  materials: MaterialItem[]
  calls: Array<{
    id: number
    phone: string
    contactName: string | null
    direction: 'in' | 'out'
    callStatus: string
    durationSec: number
    startedAt: string
    asrStatus: AsrStatus
    asrText: string | null
    hasRecording: boolean
  }>
  rawJson: unknown
  detailJson: unknown
}

export interface HealthInfo {
  process: { uptimeSec: number; nodeVersion: string; pid: number }
  db: { ok: boolean; rows: { order: number; material: number; call: number; attachment: number } }
  minio: { buckets: Array<{ name: string; ok: boolean; objectCount: number; sizeBytes: number }> }
  websocket: { total: number; ext: number; tray: number }
  asr: {
    pending: number
    processing: number
    last24h: { done: number; total: number; rate: number | null }
  }
  extReports: Array<{
    employeeId: number
    name: string
    extConnected: boolean
    lastReportAt: string | null
    tokenOk: boolean | null
    tokenLastCheckAt: string | null
  }>
}
