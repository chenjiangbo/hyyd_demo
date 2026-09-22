/**
 * 管理后台 API 客户端。
 *
 * - 所有请求都带 cookie（credentials: 'include'），鉴权靠 httpOnly admin JWT cookie。
 * - 401 时派发全局事件 'admin-unauthorized'，由 useAuth 接住弹登录窗，不硬跳页。
 * - 开发期 vite 把 /api 代理到 backend 13000；生产期同源，故 baseURL 用空串走相对路径。
 */
import type {
  DashboardSummary,
  TimeseriesPoint,
  AdminAlert,
  EmployeeRow,
  HealthInfo,
  EmployeeDetail,
  EmployeeOrderRow,
  CursorPage,
  MaterialItem,
  MaterialDetail,
  CallItem,
  AdminMessageItem,
  OrderListItem,
  OrderFull,
  MaterialOrderGroup,
  CaptureQuality,
  CaptureHealthRow,
  UnmatchedRefItem,
  CaptureDiagnosticImageItem,
  SystemReminderConfig,
  AiScheduleConfig,
  UpdateAiSchedulePayload,
  SmsConfig,
  SmsConfigResponse,
  UpdateSmsConfigPayload,
  TestSmsPayload,
  TestSmsResult,
  SmsLogItem
} from './types'

export type {
  AiScheduleConfig,
  UpdateAiSchedulePayload,
  SmsConfig,
  SmsConfigResponse,
  UpdateSmsConfigPayload,
  TestSmsPayload,
  TestSmsResult,
  SmsLogItem
}

// 把筛选对象拼成 query string（跳过空值）。
function qs(params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') q.set(k, String(v))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

export const UNAUTHORIZED_EVENT = 'admin-unauthorized'

export interface WorkflowStepConfig {
  id?: number
  code: string
  name: string
  parentCode: string | null
  kind: 'step' | 'package'
  sortOrder: number
  required: boolean
  repeatable: boolean
  activationMode: 'initial' | 'event'
  triggerEventCode: string | null
  status: 'active' | 'hidden' | 'retired'
}

export interface WorkflowTemplateConfig {
  id: number
  code: string
  version: number
  name: string
  serviceType: string
  description: string | null
  status: string
  steps: WorkflowStepConfig[]
}

export interface OrderAiConfig {
  schedule: {
    timeZone: string
    times: string[]
    setting: string
    condition: string
    scope: string
  }
  prompt: {
    version: string
    rules: string[]
    inputs: string[]
    output: { candidate: string; event: string }
  }
  fields: Array<{
    code: string
    label: string
    serviceTypes: string[]
    requiresConfirmation: boolean
  }>
  readRules: string[]
  storage: Array<{ table: string; purpose: string; fields: string }>
  huanyuPush: { action: string; target: string; notices: string[] }
}

interface ApiEnvelope<T> {
  data?: T
  error?: string
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> ?? {})
  }
  if (!isFormData && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }

  const res = await fetch(path, {
    ...options,
    credentials: 'include',
    headers
  })

  if (res.status === 401) {
    // 通知 UI 弹登录窗
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
    let msg = '未登录'
    try {
      msg = ((await res.json()) as ApiEnvelope<T>).error ?? msg
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }

  let json: ApiEnvelope<T> | null = null
  try {
    json = (await res.json()) as ApiEnvelope<T>
  } catch {
    /* 非 JSON 响应 */
  }

  if (!res.ok) {
    throw new Error(json?.error ?? `HTTP ${res.status} ${res.statusText}`)
  }
  if (json?.error) throw new Error(json.error)
  return (json?.data ?? (json as unknown as T))
}

export const adminApi = {
  // ───── 鉴权 ─────
  login(password: string) {
    return request<{ ok: boolean }>('/api/v1/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password })
    })
  },
  logout() {
    return request<{ ok: boolean }>('/api/v1/admin/logout', { method: 'POST', body: '{}' })
  },
  me() {
    return request<{ role: string }>('/api/v1/admin/me')
  },

  // ───── 服务步骤配置 ─────
  workflowTemplates() {
    return request<WorkflowTemplateConfig[]>('/api/v1/admin/workflow-templates')
  },
  saveWorkflowTemplate(id: number, data: Pick<WorkflowTemplateConfig, 'name' | 'description' | 'steps'>) {
    return request<{ ok: boolean }>(`/api/v1/admin/workflow-templates/${id}`, {
      method: 'PUT', body: JSON.stringify(data)
    })
  },

  // ───── AI 调用时间配置 ─────
  aiScheduleConfig() {
    return request<AiScheduleConfig>('/api/v1/admin/ai-schedule-config')
  },
  saveAiScheduleConfig(data: UpdateAiSchedulePayload) {
    return request<{ data: AiScheduleConfig; message: string }>('/api/v1/admin/ai-schedule-config', {
      method: 'PUT',
      body: JSON.stringify(data)
    })
  },

  // ───── 短信模板与密钥配置 ─────
  smsConfig() {
    return request<SmsConfigResponse>('/api/v1/admin/sms-config')
  },
  saveSmsConfig(data: UpdateSmsConfigPayload) {
    return request<{ data: SmsConfigResponse; message: string }>('/api/v1/admin/sms-config', {
      method: 'PUT',
      body: JSON.stringify(data)
    })
  },
  testSendSms(data: TestSmsPayload) {
    return request<TestSmsResult>('/api/v1/admin/sms-config/test', {
      method: 'POST',
      body: JSON.stringify(data)
    })
  },
  smsLogs(limit = 50) {
    return request<SmsLogItem[]>(`/api/v1/admin/sms-config/logs${qs({ limit })}`)
  },

  // ───── 订单 AI 分析配置说明 ─────
  orderAiConfig() {
    return request<OrderAiConfig>('/api/v1/admin/order-ai-config')
  },

  // ───── 系统提醒说明 ─────
  systemReminderConfig() {
    return request<SystemReminderConfig>('/api/v1/admin/system-reminder-config')
  },

  // ───── 仪表盘 ─────
  dashboardSummary() {
    return request<DashboardSummary>('/api/v1/admin/dashboard/summary')
  },
  dashboardTimeseries(days = 7) {
    return request<TimeseriesPoint[]>(`/api/v1/admin/dashboard/timeseries?days=${days}`)
  },
  dashboardAlerts() {
    return request<AdminAlert[]>('/api/v1/admin/dashboard/alerts')
  },
  captureQuality() {
    return request<CaptureQuality>('/api/v1/admin/dashboard/capture-quality')
  },

  // ───── 采集监控 ─────
  captureHealth() {
    return request<CaptureHealthRow[]>('/api/v1/admin/capture/health')
  },
  unmatchedRefs(status = 'pending') {
    return request<UnmatchedRefItem[]>(`/api/v1/admin/unmatched-order-refs${qs({ status })}`)
  },
  captureDiagnosticImages() {
    return request<CaptureDiagnosticImageItem[]>('/api/v1/admin/capture-diagnostic-images')
  },
  deleteCaptureDiagnosticImage(objectKey: string) {
    return request<{ ok: boolean }>(`/api/v1/admin/capture-diagnostic-images/${objectKey}`, { method: 'DELETE' })
  },

  // ───── 员工 ─────
  employees() {
    return request<EmployeeRow[]>('/api/v1/admin/employees')
  },

  // ───── 员工详情及子资源 ─────
  employeeDetail(id: number) {
    return request<EmployeeDetail>(`/api/v1/admin/employees/${id}`)
  },
  employeeOrders(id: number, search?: string) {
    return request<EmployeeOrderRow[]>(`/api/v1/admin/employees/${id}/orders${qs({ search })}`)
  },
  employeeMaterials(id: number, cursor?: string) {
    return request<CursorPage<MaterialItem>>(`/api/v1/admin/employees/${id}/materials${qs({ cursor })}`)
  },
  employeeCalls(id: number, cursor?: string) {
    return request<CursorPage<CallItem>>(`/api/v1/admin/employees/${id}/calls${qs({ cursor })}`)
  },
  employeeMaterialOrders(id: number) {
    return request<MaterialOrderGroup[]>(`/api/v1/admin/employees/${id}/material-orders`)
  },

  // ───── 订单 ─────
  orders(params: {
    cursor?: string
    search?: string
    employeeId?: number
    poolType?: string
    hasWechatMessage?: string
    hasWxworkMessage?: string
    hasRecording?: string
    createdFrom?: string
    createdTo?: string
  } = {}) {
    return request<CursorPage<OrderListItem>>(`/api/v1/admin/orders${qs(params)}`)
  },
  orderFull(id: number) {
    return request<OrderFull>(`/api/v1/admin/orders/${id}/full`)
  },

  // ───── 素材 ─────
  materials(
    params: { cursor?: string; employeeId?: number; orderId?: number; type?: string; search?: string } = {}
  ) {
    return request<CursorPage<MaterialItem>>(`/api/v1/admin/materials${qs(params)}`)
  },
  materialDetail(id: number) {
    return request<MaterialDetail>(`/api/v1/admin/materials/${id}`)
  },

  // ───── 微信/企微消息 ─────
  messages(
    params: {
      cursor?: string
      employeeId?: number
      channel?: string
      linked?: string
      search?: string
    } = {}
  ) {
    return request<CursorPage<AdminMessageItem>>(`/api/v1/admin/messages${qs(params)}`)
  },

  // ───── 通话 ─────
  calls(params: { cursor?: string; employeeId?: number; asrStatus?: string; linked?: string } = {}) {
    return request<CursorPage<CallItem>>(`/api/v1/admin/calls${qs(params)}`)
  },
  callRecordingUrl(id: number) {
    return request<{
      status?: 'ready' | 'transcoding' | 'failed'
      url: string | null
      expiresIn: number
      mimeType?: string
      format?: string
      browserPlayable?: boolean
      message?: string
    }>(`/api/v1/admin/calls/${id}/recording-url`)
  },

  // ───── 系统健康 ─────
  health() {
    return request<HealthInfo>('/api/v1/admin/health')
  },

  // ───── App 安装包发包与下载 ─────
  appInfo() {
    return request<{
      exists: boolean
      fileName?: string
      sizeBytes?: number
      sizeMb?: number
      updatedAt?: string
      downloadUrl?: string
      mobileDownloadUrl?: string
    }>('/api/v1/admin/app/info')
  },
  uploadApp(file: File) {
    const formData = new FormData()
    formData.append('file', file)
    return request<{ ok: boolean; message: string; downloadUrl: string }>('/api/v1/admin/app/upload', {
      method: 'POST',
      body: formData
    })
  }
}
