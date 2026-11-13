import { createServer, type Server } from 'node:http'

const PORT = 43186
const EXTENSION_ORIGIN = 'chrome-extension://akaojickfipoeobmiokkdbdaimeifmoa'
const HOSPITAL_FIELDS = [
  ['hospital', '医院'], ['hospitalAddress', '医院地址'], ['department', '科室'], ['doctor', '医生']
] as const
const TIME_FIELDS = [
  ['requestTime', 'request_time', '需求时间'],
  ['responseTime', 'response_time', '应答时间'],
  ['serviceStartTime', 'service_start_time', '启动服务时间'],
  ['bookingFeedbackTime', 'appointment_success_time', '预约反馈时间'],
  ['latestTicketTime', 'latest_ticket_time', '最终取号时间']
] as const

type Config = { backendUrl: string; employeeCode: string }
type Active = { token: string; tabId: number; orderNo: string; formOrderNo: string | null | undefined; invalidated: boolean; suspended: boolean; lastSeenAt: number; refreshPending: boolean; needResetMasterData: boolean }
type MasterReviewField = { id: string; label: string; value: string; options: Array<{ value: string; label: string; parent?: string }>; source?: { label: string; url: string } }
type MasterReviewItem = { key: string; type: string; name: string; parent?: string; address?: string; addressSuggestion?: { value: string }; fields: MasterReviewField[] }
export type PetOrderAiPanel = {
  kind: 'progress' | 'error' | 'form'
  id: string
  text?: string
  title?: string
  description?: string
  fields?: Array<{ id: string; label: string; type: 'text' | 'textarea' | 'date' | 'datetime-local' | 'select' | 'checkbox' | 'number'; value: string; placeholder: string; options?: Array<{ value: string; label: string; price?: string }>; copyable?: boolean; readOnly?: boolean; suggestion?: string; aiPrefill?: boolean; hint?: string; originalPhone?: string }>
  originalService?: string
  originalAmount?: string
  originalStatus?: string
  sections?: Array<{ id: string; title: string; fieldIds: string[]; repeatable?: boolean }>
  actions?: Array<{ id: string; label: string; tone?: 'primary' | 'secondary'; loading?: boolean }>
  confirmation?: { title: string; originalAddress?: string; creations: Array<{ key: string; type: string; name: string; parent?: string }>; review: MasterReviewItem[] }
  submitMessage?: string
  submitState?: 'idle' | 'submitting' | 'success' | 'error'
}

export class PetOrderAiService {
  private server: Server | null = null
  private config: Config | null = null
  private active: Active | null = null
  private currentPanel: PetOrderAiPanel | null = null
  private masterDraft: Record<string, Record<string, string>> = {}
  private currentSnapshot: { order: Record<string, string>; escorts: Array<{ id: string; escortName: string; escortPhone: string; serviceDate: string }> } | null = null
  private escortIdsByIndex: Record<string, string> = {}
  private leaseTimer: ReturnType<typeof setInterval> | null = null
  private suspendTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly showPanel: (panel: PetOrderAiPanel) => void,
    private readonly updatePanel: (id: string, panel: PetOrderAiPanel) => void,
    private readonly hidePanel: (id: string) => void,
    private readonly port = PORT,
    private readonly suspendPanel: (id: string) => void = () => {},
    private readonly resumePanel: (id: string) => void = () => {},
    private readonly ensurePanelVisible: (id: string) => void = () => {},
    private readonly isPetFocused: () => boolean = () => false
  ) {}

  setConfig(config: Config): void {
    const backendUrl = config.backendUrl?.trim().replace(/\/$/, '')
    const employeeCode = config.employeeCode?.trim()
    this.config = backendUrl && employeeCode ? { backendUrl, employeeCode } : null
    if (!this.config && this.active) this.close(this.active.token)
  }

  start(): void {
    if (this.server) return
    this.server = createServer((request, response) => {
      const origin = request.headers.origin
      const allowedPath = ['/pet/order-page', '/pet/order-site-config', '/pet/window-focus'].includes(request.url ?? '')
      // Chrome MV3 service-worker fetches to loopback may omit Origin. Accept that local request,
      // while continuing to reject requests carrying a different web/extension origin.
      if ((origin && origin !== EXTENSION_ORIGIN) || !allowedPath) {
        console.warn('[pet-order-ai] 拒绝本机页面请求', { origin: origin ?? '(无 Origin)', url: request.url })
        response.writeHead(403).end(JSON.stringify({ error: '来源或路径不允许' }))
        return
      }
      if (origin) response.setHeader('Access-Control-Allow-Origin', EXTENSION_ORIGIN)
      response.setHeader('Vary', 'Origin')
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      if (request.method === 'OPTIONS') { response.writeHead(204).end(); return }
      if (request.url === '/pet/window-focus') {
        if (request.method !== 'GET') { response.writeHead(405).end(); return }
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.writeHead(200).end(JSON.stringify({ focused: this.isPetFocused() }))
        return
      }
      if (request.url === '/pet/order-site-config') {
        if (request.method !== 'GET') { response.writeHead(405).end(); return }
        void this.loadSiteConfig().then((site) => {
          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          response.writeHead(200).end(JSON.stringify({ data: { site } }))
        }).catch((error) => {
          response.writeHead(503).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        })
        return
      }
      if (request.method !== 'POST') { response.writeHead(405).end(); return }
      const chunks: Buffer[] = []
      let size = 0
      request.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 2048) request.destroy()
        else chunks.push(chunk)
      })
      request.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          if ((body.event !== 'open' && body.event !== 'close' && body.event !== 'suspend' && body.event !== 'refresh-failed' && body.event !== 'refresh-complete') ||
              typeof body.token !== 'string' || !/^[a-f0-9-]{36}$/.test(body.token) ||
              typeof body.tabId !== 'number' || !Number.isInteger(body.tabId) || body.tabId < 0 ||
              typeof body.orderNo !== 'string' || !/^[A-Za-z0-9-]{6,64}$/.test(body.orderNo) ||
              (body.formOrderNo !== null && body.formOrderNo !== undefined &&
                (typeof body.formOrderNo !== 'string' || !/^[A-Za-z0-9-]{6,64}$/.test(body.formOrderNo)))) {
            response.writeHead(400).end()
            return
          }
          if ((body.event === 'refresh-failed' || body.event === 'refresh-complete') && this.currentSnapshot && this.active?.token === body.token && this.active.orderNo === body.orderNo && this.active.tabId === body.tabId && this.currentPanel?.kind === 'form') {
            const failed = body.event === 'refresh-failed'
            this.currentPanel = { ...this.currentPanel, submitState: failed ? 'error' : 'success', submitMessage: failed ? '远程订单已更新，但自动刷新失败。请返回列表重新打开订单查看最新数据。' : '填单成功', actions: [{ id: 'one-click-fill', label: '一键填单', tone: 'primary' }] }
            this.updatePanel(this.currentPanel.id, this.currentPanel)
          }
          const refresh = body.event === 'open'
            ? this.open(body.token, body.tabId, body.orderNo, body.formOrderNo as string | null | undefined)
            : body.event === 'suspend'
              ? (this.suspend(body.token), false)
              : body.event === 'close' ? (this.close(body.token), false) : false
          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          const needResetMasterData = refresh && Boolean(this.active?.needResetMasterData)
          if (refresh && this.active) this.active.needResetMasterData = false
          response.writeHead(200).end(JSON.stringify({ refresh, needResetMasterData }))
        } catch {
          response.writeHead(400).end()
        }
      })
    })
    this.server.on('error', (error) => console.error('[pet-order-ai] 本机页面事件服务启动失败', error))
    this.server.listen(this.port, '127.0.0.1')
    this.leaseTimer = setInterval(() => {
      if (this.active && !this.active.suspended && Date.now() - this.active.lastSeenAt > 17_000) this.close(this.active.token)
    }, 5_000)
  }

  private async loadSiteConfig(): Promise<unknown> {
    const config = this.config
    if (!config) throw new Error('精灵尚未登录')
    const response = await fetch(`${config.backendUrl}/api/v1/pet/order-site-config`, {
      headers: { 'X-Employee-Code': config.employeeCode },
      signal: AbortSignal.timeout(5_000)
    })
    if (!response.ok) throw new Error(`后台站点配置读取失败（${response.status}）`)
    const payload = await response.json() as { data?: { site?: unknown } }
    return payload.data?.site ?? null
  }

  async dictionary(kind: string, query = '', parent: { hospitalId?: string; departmentId?: string; currentId?: string } = {}): Promise<unknown> {
    const config = this.config
    if (!config) throw new Error('请先登录寰宇智能助手')
    const paths: Record<string, string> = {
      status: '/api/v1/dictionaries/huanyu/order-statuses',
      hospital: '/api/v1/dictionaries/huanyu/hospitals',
      address: '/api/v1/dictionaries/huanyu/hospital-addresses',
      department: '/api/v1/dictionaries/huanyu/hospital-departments',
      doctor: '/api/v1/dictionaries/huanyu/hospital-doctors',
      escort: '/api/v1/dictionaries/huanyu/escorts'
    }
    const path = paths[kind]
    if (!path) throw new Error('未知维表类型')
    const params = new URLSearchParams()
    if (query) params.set('q', query)
    if (parent.currentId) params.set('currentId', parent.currentId)
    if (parent.hospitalId) params.set('hospitalId', parent.hospitalId)
    if (parent.departmentId) params.set('departmentId', parent.departmentId)
    const response = await fetch(`${config.backendUrl}${path}${params.size ? `?${params}` : ''}`, {
      headers: { 'X-Employee-Code': config.employeeCode }, signal: AbortSignal.timeout(8_000)
    })
    const payload = await response.json() as { data?: unknown; error?: string }
    if (!response.ok) throw new Error(payload.error || `维表读取失败（${response.status}）`)
    return payload.data
  }

  async handlePanelAction(panelId: string, actionId: string, values: Record<string, unknown> = {}): Promise<void> {
    const active = this.active
    if (!active || panelId !== `order-ai:${active.token}` || this.currentPanel?.kind !== 'form') return
    if (this.currentPanel.submitState === 'submitting') return
    if (actionId === 'cancel-master-create') {
      for (const item of this.currentPanel.confirmation?.review ?? []) {
        this.masterDraft[item.key] = Object.fromEntries(item.fields.map((field) => [field.id, typeof values[`master:${item.key}:${field.id}`] === 'string' ? values[`master:${item.key}:${field.id}`] as string : field.value]))
      }
      this.currentPanel = { ...this.currentPanel, fields: this.currentPanel.fields?.map((field) => typeof values[field.id] === 'string' ? { ...field, value: values[field.id] as string } : field), confirmation: undefined, submitMessage: undefined, submitState: 'idle',
        actions: [{ id: 'one-click-fill', label: '一键填单', tone: 'primary' }] }
      this.updatePanel(panelId, this.currentPanel)
      return
    }
    if (actionId !== 'one-click-fill' && actionId !== 'confirm-master-create') return
    if (!active.formOrderNo || active.formOrderNo !== active.orderNo) {
      active.invalidated = true
      this.requireReopen(active)
      return
    }
    const config = this.config
    if (!config) throw new Error('请先登录寰宇智能助手')
    const snapshot = this.currentSnapshot
    if (!snapshot) throw new Error('订单当前值尚未读取，请重新打开订单')
    const fields = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, typeof value === 'string' ? value : ''])) as Record<string, string>
    const escortIndexes = [...new Set(Object.keys(fields).map((key) => key.match(/^escort-(\d+)-/)?.[1]).filter(Boolean))]
      .sort((a, b) => Number(a) - Number(b)) as string[]
    if (escortIndexes.length === 0) {
      this.currentPanel = { ...this.currentPanel, submitState: 'error', submitMessage: '至少保留一条陪诊信息',
        actions: [{ id: 'one-click-fill', label: '一键填单', tone: 'primary' }] }
      this.updatePanel(panelId, this.currentPanel)
      return
    }
    const addressChanged = actionId === 'confirm-master-create' && (fields.hospitalAddress ?? '') !== (this.currentPanel.confirmation?.originalAddress ?? '')
    // 陪诊行可在渲染界面增删，提交时同步完整行结构，后续状态更新不能丢掉新增行。
    const currentFields = this.currentPanel.fields ?? []
    const escortFields = escortIndexes.flatMap((index) => {
      const prefix = `escort-${index}`
      return [
        { id: `${prefix}-date`, label: '服务日期/时间', type: 'datetime-local' as const, placeholder: '请选择服务日期/时间' },
        { id: `${prefix}-name`, label: '陪诊人', type: 'text' as const, placeholder: '请输入陪诊人' },
        { id: `${prefix}-phone`, label: '陪诊电话', type: 'text' as const, placeholder: '请输入陪诊电话' }
      ].map((field) => ({ ...field, ...currentFields.find((existing) => existing.id === field.id), value: fields[field.id] ?? '' }))
    })
    this.currentPanel = { ...this.currentPanel,
      fields: [...currentFields.filter((field) => !/^escort-\d+-(date|name|phone)$/.test(field.id)).map((field) => {
        const value = Object.prototype.hasOwnProperty.call(fields, field.id) ? fields[field.id] : field.value
        return { ...field, value, readOnly: field.id === 'orderAmount' ? fields.amountChanged !== 'true' || ['已取消', '无责取消'].includes(fields.orderStatus) : field.id === 'amountChanged' ? ['已取消', '无责取消'].includes(fields.orderStatus) : field.readOnly }
      }), ...escortFields],
      sections: [...(this.currentPanel.sections ?? []).filter((section) => !section.repeatable), ...escortIndexes.map((index) => {
        const prefix = `escort-${index}`
        return { id: prefix, title: `陪诊服务 ${index}`, fieldIds: [`${prefix}-date`, `${prefix}-name`, `${prefix}-phone`], repeatable: true }
      })]
    }
    const requestFields = {
      orderStatus: fields.orderStatus ?? '',
      escortSummary: fields.escortSummary ?? '',
      hospital: fields.hospital ?? '', hospitalAddress: fields.hospitalAddress ?? '', department: fields.department ?? '', doctor: fields.doctor ?? '',
      requestTime: fields.requestTime ?? '', responseTime: fields.responseTime ?? '', serviceStartTime: fields.serviceStartTime ?? '',
      bookingFeedbackTime: fields.bookingFeedbackTime ?? '', latestTicketTime: fields.latestTicketTime ?? '',
      escortList: escortIndexes.map((index) => ({
        id: this.escortIdsByIndex[index] ?? '',
        serviceDate: fields[`escort-${index}-date`] ?? '', escortName: fields[`escort-${index}-name`] ?? '',
        phone: fields[`escort-${index}-phone`] ?? '', expectedEscortId: fields[`escort-${index}-expected-id`] ?? '', expectedPhone: fields[`escort-${index}-expected-phone`] ?? '', sequence: index
      })).filter((item) => Boolean(item.id || item.serviceDate || item.escortName || item.phone))
    }
    const confirmation = actionId === 'confirm-master-create' ? this.currentPanel.confirmation : undefined
    const confirmedMasterCreations = confirmation?.creations
    const masterDetails = confirmation ? Object.fromEntries(confirmation.review.map((item) => [item.key,
      Object.fromEntries(item.fields.map((field) => [field.id, fields[`master:${item.key}:${field.id}`] ?? field.value]))])) : undefined
    if (confirmation) {
      this.currentPanel = { ...this.currentPanel, confirmation: { ...confirmation,
        review: confirmation.review.map((item) => ({ ...item, fields: item.fields.map((field) => ({ ...field,
          value: masterDetails?.[item.key]?.[field.id] ?? field.value })) })) } }
      const missing = confirmation.review.flatMap((item) => item.fields.map((field) => ({ item, field })))
        .find(({ item, field }) => !masterDetails?.[item.key]?.[field.id])
      if (missing) {
        this.currentPanel = { ...this.currentPanel, submitState: 'error', submitMessage: `请核对并选择${missing.item.name}的${missing.field.label}` }
        this.updatePanel(panelId, this.currentPanel)
        return
      }
    }
    this.currentPanel = { ...this.currentPanel, submitState: 'submitting', submitMessage: '正在填单，请稍候…', actions: [{ id: actionId, label: '一键填单', tone: 'primary', loading: true }] }
    this.updatePanel(panelId, this.currentPanel)
    try {
      const response = await fetch(`${config.backendUrl}/api/v1/pet/huanyu-order-update`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Employee-Code': config.employeeCode },
        body: JSON.stringify({ orderNo: active.orderNo, fields: requestFields, confirmedMasterCreations, masterDetails, addressChanged,
          expectedEscorts: snapshot.escorts.map((record) => ({ id: record.id, escortId: record.escortName, serviceDate: record.serviceDate })),
          expectedOrder: snapshot.order,
          financial: { channel: snapshot.order.channel, originalService: snapshot.order.channelService, originalAmount: snapshot.order.orderAmount, service: fields.channelService ?? '', amount: fields.orderAmount ?? '' } }),
        signal: AbortSignal.timeout(40_000)
      })
      const payload = await response.json() as { ok?: boolean; requiresMasterDataConfirmation?: boolean; creations?: Array<{ key: string; type: string; name: string; parent?: string }>; review?: MasterReviewItem[]; error?: string; escortCount?: number; escortIds?: string[]; needResetMasterData?: boolean }
      if (this.active !== active || this.currentPanel?.id !== panelId || this.currentPanel.kind !== 'form') return
      if (payload.needResetMasterData === true) active.needResetMasterData = true
      if (payload.requiresMasterDataConfirmation && payload.creations?.length) {
        if (!payload.review || payload.review.length !== payload.creations.length) throw new Error('建档核对资料未完整返回，请稍后重试')
        this.currentPanel = { ...this.currentPanel, submitState: 'idle', submitMessage: undefined,
          confirmation: { title: '核对建档信息', originalAddress: requestFields.hospitalAddress, creations: payload.creations, review: payload.review.map((item) => {
            const draft = this.masterDraft[item.key] ?? {}
            const fields = item.fields.map((field) => ({ ...field, value: field.options.some((option) => option.value === draft[field.id]) ? draft[field.id] : field.value }))
            for (const field of fields) {
              const parentId = field.id === 'city' ? 'province' : field.id === 'internalTwo' ? 'internalOne' : ''
              if (parentId && field.value && !field.options.some((option) => option.value === field.value && option.parent === fields.find((parent) => parent.id === parentId)?.value)) field.value = ''
            }
            return { ...item, fields }
          }) },
          actions: [{ id: 'cancel-master-create', label: '返回修改' }, { id: 'confirm-master-create', label: '确认创建并填单', tone: 'primary' }] }
      } else if (!response.ok || !payload.ok) {
        if (payload.needResetMasterData === true) {
          this.currentPanel = { ...this.currentPanel, confirmation: undefined }
          this.currentSnapshot = null
          throw new Error(`人员或业务档案已更新，但订单更新失败：${payload.error || `HTTP ${response.status}`}；请重新打开订单核对`)
        }
        throw new Error(payload.error || `订单更新失败（${response.status}）`)
      } else {
        let nextPayload: { data?: typeof snapshot } = {}
        try {
          const nextResponse = await fetch(`${config.backendUrl}/api/v1/pet/order-current?orderNo=${encodeURIComponent(active.orderNo)}`, { headers: { 'X-Employee-Code': config.employeeCode }, signal: AbortSignal.timeout(10_000) })
          nextPayload = await nextResponse.json() as { data?: typeof snapshot }
          if (!nextResponse.ok || !nextPayload.data) throw new Error('读取失败')
        } catch {
          if (this.active !== active || this.currentPanel?.id !== panelId) return
          this.currentSnapshot = null
          active.refreshPending = true
          this.currentPanel = { ...this.currentPanel, confirmation: undefined, submitState: 'error', submitMessage: '订单已更新，但读取最新数据失败，请返回列表重新打开订单。', actions: [] }
          this.updatePanel(panelId, this.currentPanel)
          return
        }
        if (this.active !== active || this.currentPanel?.id !== panelId) return
        if (!nextPayload.data) return
        this.currentSnapshot = nextPayload.data
        this.escortIdsByIndex = Object.fromEntries(requestFields.escortList.map((item, index) => [item.sequence, payload.escortIds?.[index] ?? '']))
        active.refreshPending = true
        const savedOrder = nextPayload.data.order
        this.currentPanel = { ...this.currentPanel, fields: this.currentPanel.fields?.map((field) => ({ ...field, aiPrefill: false, hint: field.hint === '泰康意向' && HOSPITAL_FIELDS.some(([id]) => id === field.id && Boolean((savedOrder[id] ?? '').trim())) ? undefined : field.hint, suggestion: field.suggestion === field.value ? undefined : field.suggestion })), originalService: savedOrder.channelService, originalAmount: savedOrder.orderAmount, originalStatus: savedOrder.orderStatus, confirmation: undefined, submitState: 'submitting',
          submitMessage: '填单完成，正在刷新页面…',
          actions: [{ id: 'one-click-fill', label: '一键填单', tone: 'primary', loading: true }] }
        const pendingPanel = this.currentPanel
        const refreshTimer = setTimeout(() => {
          if (this.active !== active || this.currentPanel !== pendingPanel) return
          active.refreshPending = false
          this.currentPanel = { ...this.currentPanel, submitState: 'error', submitMessage: '远程订单已更新，但自动刷新超时。请返回列表重新打开订单查看最新数据。', actions: [{ id: 'one-click-fill', label: '一键填单', tone: 'primary' }] }
          this.updatePanel(panelId, this.currentPanel)
        }, 35000)
        refreshTimer.unref()
      }
      this.updatePanel(panelId, this.currentPanel)
    } catch (error) {
      if (this.active !== active || this.currentPanel?.id !== panelId || this.currentPanel.kind !== 'form') return
      this.currentPanel = { ...this.currentPanel, submitState: 'error',
        submitMessage: error instanceof Error ? error.message : '订单更新失败',
        actions: !this.currentSnapshot ? [] : this.currentPanel.confirmation
          ? [{ id: 'cancel-master-create', label: '返回修改' }, { id: 'confirm-master-create', label: '重试创建并填单', tone: 'primary' }]
          : [{ id: 'one-click-fill', label: '重试', tone: 'primary' }] }
      this.updatePanel(panelId, this.currentPanel)
    }
  }

  stop(): void {
    if (this.leaseTimer) clearInterval(this.leaseTimer)
    this.leaseTimer = null
    this.server?.close()
    this.server = null
    if (this.active) this.close(this.active.token)
  }

  private open(token: string, tabId: number, orderNo: string, formOrderNo: string | null | undefined): boolean {
    if (this.active?.token === token) {
      if (this.suspendTimer) clearTimeout(this.suspendTimer)
      this.suspendTimer = null
      this.active.lastSeenAt = Date.now()
      const previousFormOrderNo = this.active.formOrderNo
      this.active.formOrderNo = formOrderNo
      if (formOrderNo && formOrderNo !== orderNo) this.active.invalidated = true
      if (this.active.invalidated || formOrderNo !== orderNo) {
        this.requireReopen(this.active)
        if (this.active.suspended) this.resume(this.active)
        this.ensurePanelVisible(`order-ai:${token}`)
        return false
      }
      if (previousFormOrderNo !== orderNo && this.currentPanel?.kind === 'error') {
        const id = `order-ai:${token}`
        this.currentPanel = { kind: 'progress', id, text: `订单详情已核验（${orderNo}），正在获取 AI 分析…` }
        this.updatePanel(id, this.currentPanel)
        void this.load(token, orderNo, id)
      }
      if (this.active.suspended) this.resume(this.active)
      this.ensurePanelVisible(`order-ai:${token}`)
      const refresh = this.active.refreshPending
      this.active.refreshPending = false
      return refresh
    }
    if (this.active) this.close(this.active.token)
    this.active = { token, tabId, orderNo, formOrderNo, invalidated: Boolean(formOrderNo && formOrderNo !== orderNo), suspended: false, lastSeenAt: Date.now(), refreshPending: false, needResetMasterData: false }
    const id = `order-ai:${token}`
    if (this.active.invalidated || formOrderNo !== orderNo) {
      this.requireReopen(this.active)
      return false
    }
    this.currentPanel = { kind: 'progress', id, text: `订单详情已核验（${orderNo}），正在获取 AI 分析…` }
    this.showPanel(this.currentPanel)
    void this.load(token, orderNo, id)
    return false
  }

  private requireReopen(active: Active): void {
    const id = `order-ai:${active.token}`
    const hadPanel = this.currentPanel?.id === id
    const text = active.formOrderNo === undefined
      ? '浏览器插件仍在运行旧版本，无法校验实际表单订单号。请在 Chrome 扩展程序页面重新加载“寰宇医道 - 浏览器探针”，然后返回订单列表重新打开订单。'
      : active.formOrderNo
        ? `当前订单详情（${active.formOrderNo}）与浮窗订单（${active.orderNo}）不一致。为避免填错订单，请关闭浮窗，返回订单列表后重新打开该订单。`
        : '暂时无法读取当前订单详情的订单号，尚未加载 AI 分析结果。请关闭浮窗，返回订单列表后重新打开该订单。'
    const panel: PetOrderAiPanel = { kind: 'error', id, text, actions: [] }
    this.currentPanel = panel
    if (this.active?.token === active.token) {
      if (hadPanel) this.updatePanel(id, panel)
      else this.showPanel(panel)
    }
  }

  private suspend(token: string): void {
    if (this.active?.token !== token || this.active.suspended || this.suspendTimer) return
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null
      if (this.active?.token !== token || this.active.suspended) return
      this.active.suspended = true
      this.suspendPanel(`order-ai:${token}`)
    }, 300)
    this.suspendTimer.unref()
  }

  private resume(active: Active): void {
    active.suspended = false
    this.resumePanel(`order-ai:${active.token}`)
  }

  private close(token: string): void {
    if (this.active?.token !== token) return
    if (this.suspendTimer) clearTimeout(this.suspendTimer)
    this.suspendTimer = null
    this.active = null
    this.currentPanel = null
    this.currentSnapshot = null
    this.escortIdsByIndex = {}
    this.masterDraft = {}
    this.hidePanel(`order-ai:${token}`)
  }

  private async load(token: string, orderNo: string, id: string): Promise<void> {
    try {
      const config = this.config
      if (!config) throw new Error('请先登录寰宇智能助手')
      const response = await fetch(`${config.backendUrl}/api/v1/pet/order-ai-fields?orderNo=${encodeURIComponent(orderNo)}`, {
        headers: { 'X-Employee-Code': config.employeeCode },
        signal: AbortSignal.timeout(10_000)
      })
      const payload = await response.json() as {
        data?: {
          fields?: Record<string, string>
          intention?: Record<string, string>
          documentNo?: string
          groupName?: string
          documentNoStatus?: 'ok' | 'not_found' | 'unavailable'
          escortRecords?: Array<{ serviceDate?: string; escortName?: string; escortPhone?: string }>
        }
        error?: string
      }
      if (!response.ok) throw new Error(payload.error || `后台请求失败（${response.status}）`)
      if (this.active?.token !== token || this.active.invalidated || this.active.formOrderNo !== orderNo) return
      const values = payload.data?.fields ?? {}
      const currentResponse = await fetch(`${config.backendUrl}/api/v1/pet/order-current?orderNo=${encodeURIComponent(orderNo)}`, { headers: { 'X-Employee-Code': config.employeeCode }, signal: AbortSignal.timeout(10_000) })
      const currentPayload = await currentResponse.json() as { data?: { order: Record<string, string>; escorts: Array<{ id: string; escortName: string; escortPhone: string; serviceDate: string }> }; error?: string }
      if (!currentResponse.ok || !currentPayload.data) throw new Error(currentPayload.error || '读取订单当前值失败')
      if (this.active?.token !== token || this.active.invalidated || this.active.formOrderNo !== orderNo) return
      this.currentSnapshot = currentPayload.data
      this.escortIdsByIndex = Object.fromEntries(currentPayload.data.escorts.map((record, index) => [String(index + 1), record.id]))
      const current = currentPayload.data.order
      const productParams = new URLSearchParams({ channelId: current.channel, currentId: current.channelService })
      const productResponse = await fetch(`${config.backendUrl}/api/v1/dictionaries/huanyu/channel-products?${productParams}`, { headers: { 'X-Employee-Code': config.employeeCode }, signal: AbortSignal.timeout(8_000) })
      if (!productResponse.ok) throw new Error('服务项目读取失败')
      const productPayload = await productResponse.json() as { data?: Array<{ id: string; name: string; price: string }> }
      const products = productPayload.data ?? []
      const statusOptions = await this.dictionary('status').catch(() => []) as Array<{ id?: string; name?: string }>
      const nameLookups = [
        { key: 'hospital', kind: 'hospital', value: current.hospital },
        { key: 'hospitalAddress', kind: 'address', value: current.hospitalAddress },
        { key: 'department', kind: 'department', value: current.department },
        { key: 'doctor', kind: 'doctor', value: current.doctor },
        ...currentPayload.data.escorts.map((record, index) => ({ key: `escort-${index + 1}-name`, kind: 'escort', value: record.escortName }))
      ]
      const resolvedNames = Object.fromEntries(await Promise.all(nameLookups.map(async (lookup) => {
        if (!lookup.value) return [lookup.key, '']
        const options = await this.dictionary(lookup.kind, '', { currentId: lookup.value, hospitalId: current.hospital, departmentId: current.department }).catch(() => []) as Array<{ id?: string; name?: string }>
        return [lookup.key, options.find((option) => String(option.id ?? '') === lookup.value || option.name === lookup.value)?.name ?? lookup.value]
      }))) as Record<string, string>
      if (this.active?.token !== token || this.active.invalidated || this.active.formOrderNo !== orderNo) return
      const escortRecords = currentPayload.data.escorts.map((record) => ({ serviceDate: record.serviceDate, escortName: record.escortName, escortPhone: record.escortPhone }))
      if (escortRecords.length === 0) escortRecords.push(...(payload.data?.escortRecords ?? []).map((record) => ({ serviceDate: record.serviceDate ?? '', escortName: record.escortName ?? '', escortPhone: record.escortPhone ?? '' })))
      if (escortRecords.length === 0) escortRecords.push({
        serviceDate: '',
        escortName: '',
        escortPhone: ''
      })
      const toDateTimeLocal = (value: string): string => {
        const trimmed = value.trim()
        const compact = trimmed.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/)
        if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6] ?? '00'}`
        const standard = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/)
        return standard ? `${standard[1]}-${standard[2]}-${standard[3]}T${standard[4]}:${standard[5]}:${standard[6] ?? '00'}` : trimmed
      }
      const aiEscorts = (payload.data?.escortRecords ?? []).map((record) => ({ serviceDate: record.serviceDate ?? '', escortName: record.escortName ?? '', escortPhone: record.escortPhone ?? '' }))
      const currentEscorts = currentPayload.data.escorts
      const matchedAi = new Map<number, number>()
      if (currentEscorts.length) currentEscorts.forEach((record, index) => {
        const date = toDateTimeLocal(record.serviceDate)
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(date)) return
        const originalMatches = currentEscorts.filter((item) => toDateTimeLocal(item.serviceDate) === date)
        const candidates = aiEscorts.map((item, candidateIndex) => ({ item, candidateIndex })).filter(({ item }) => toDateTimeLocal(item.serviceDate) === date)
        if (originalMatches.length === 1 && candidates.length === 1) matchedAi.set(index, candidates[0].candidateIndex)
      })
      const unmatchedAi = currentEscorts.length ? aiEscorts.filter((_, index) => ![...matchedAi.values()].includes(index)) : []
      const merged = (original: string, suggestion: string, originalName = original): { value: string; suggestion?: string; aiPrefill?: boolean } => {
        if (!original) return { value: suggestion, aiPrefill: Boolean(suggestion) }
        return { value: original, suggestion: suggestion && suggestion.trim() !== original.trim() && suggestion.trim() !== originalName.trim() ? suggestion : undefined }
      }
      const hospitalCode = (id: string): string => id === 'hospitalAddress' ? 'hospital_address' : id
      const hasOrderHospitalGroup = HOSPITAL_FIELDS.some(([id]) => Boolean((current[id] ?? '').trim()))
      const hasAiHospitalGroup = HOSPITAL_FIELDS.some(([id]) => Boolean((values[hospitalCode(id)] ?? '').trim()))
      const intention = payload.data?.intention ?? {}
      const intendedHospital = (intention.hospital ?? '').trim()
      const isArea = !/(?:医院|医 院|卫生院|卫生中心|诊所|门诊|院区)/.test(intendedHospital) && (/^(?:[^\-－]+[\-－]){1,2}[^\-－]+(?:省|市|区|县|自治州|自治区)$/.test(intendedHospital) || /^[^\-－]{2,12}(?:省|市|区|县|自治州|自治区)$/.test(intendedHospital))
      const selectedStatus = current.orderStatus || values.order_status || ''
      const cancelled = selectedStatus === '已取消' || selectedStatus === '无责取消'
      const fields = [
        { id: 'orderNo', label: '订单号', type: 'text' as const, value: orderNo, placeholder: '', readOnly: true, copyable: true },
        { id: 'documentNo', label: '身份证号', type: 'text' as const, value: current.documentNo ?? '', placeholder: '暂无身份证号', readOnly: true, copyable: true },
        { id: 'groupName', label: '名称复制', type: 'textarea' as const, value: payload.data?.groupName ?? '', placeholder: '订单信息不完整，无法生成群名称', readOnly: true, copyable: true },
        { id: 'orderStatus', label: '订单状态', type: 'select' as const, ...merged(current.orderStatus, values.order_status ?? ''), placeholder: '请选择订单状态', options: statusOptions.map((item) => ({ value: String(item.id ?? item.name ?? ''), label: String(item.name ?? item.id ?? '') })) },
        { id: 'channelService', label: '服务项目', type: 'select' as const, value: current.channelService, placeholder: '请选择服务项目', options: products.map((item) => ({ value: item.id, label: item.name, price: item.price })) },
        { id: 'orderAmount', label: '订单金额', type: 'number' as const, value: cancelled ? '0' : current.orderAmount, placeholder: '请输入订单金额', readOnly: true },
        { id: 'amountChanged', label: '金额修改', type: 'checkbox' as const, value: 'false', placeholder: '金额修改', readOnly: cancelled },
        ...HOSPITAL_FIELDS.map(([id, label]) => ({
          id, label, type: 'text' as const,
          ...(hasOrderHospitalGroup
            ? { value: current[id] ?? '', suggestion: (values[hospitalCode(id)] ?? '').trim() || undefined }
            : hasAiHospitalGroup
              ? { value: values[hospitalCode(id)] ?? '', aiPrefill: Boolean(values[hospitalCode(id)]) }
              : { value: id === 'hospital' && isArea ? '' : (intention[id] ?? ''), hint: intention[id] && !(id === 'hospital' && isArea) ? '泰康意向' : undefined }),
          placeholder: `请输入${label}`
        })),
        ...TIME_FIELDS.map(([id, code, label]) => ({ id, label, type: 'datetime-local' as const, ...merged(toDateTimeLocal(current[id] ?? ''), toDateTimeLocal(values[code] ?? '')), placeholder: `请选择${label}` })),
        { id: 'escortSummary', label: '陪诊小结', type: 'textarea' as const, ...merged(current.escortSummary ?? '', values.escort_service_summary ?? ''), placeholder: '请输入陪诊小结' },
        ...escortRecords.flatMap((record, index) => {
          const prefix = `escort-${index + 1}`
          const ai = matchedAi.has(index) ? aiEscorts[matchedAi.get(index)!] : undefined
          const prefilled = currentEscorts.length === 0 && Boolean(aiEscorts[index])
          return [
            { id: `${prefix}-date`, label: '服务日期/时间', type: 'datetime-local' as const, ...merged(prefilled ? '' : toDateTimeLocal(record.serviceDate), prefilled ? toDateTimeLocal(record.serviceDate) : toDateTimeLocal(ai?.serviceDate ?? '')), placeholder: '请选择服务日期/时间' },
            { id: `${prefix}-name`, label: '陪诊人', type: 'text' as const, ...merged(prefilled ? '' : record.escortName, prefilled ? record.escortName : ai?.escortName ?? '', resolvedNames[`${prefix}-name`] ?? ''), originalPhone: currentEscorts[index]?.escortPhone, placeholder: '请输入陪诊人' },
            { id: `${prefix}-phone`, label: '陪诊电话', type: 'text' as const, ...merged(prefilled ? '' : record.escortPhone, prefilled ? record.escortPhone : ai?.escortPhone ?? ''), placeholder: '请输入陪诊电话' }
          ]
        }),
        ...unmatchedAi.map((record, index) => ({ id: `unmatched-ai-${index}`, label: 'AI 建议（未匹配陪诊记录）', type: 'text' as const, value: [record.serviceDate, record.escortName, record.escortPhone].filter(Boolean).join(' / '), placeholder: '', readOnly: true, copyable: true }))
      ]
      const formPanel: PetOrderAiPanel = {
        kind: 'form', id, title: '',
        description: '以下为订单的部分字段及 AI 建议值，核对或修改后可一键填单。',
        fields, originalService: current.channelService, originalAmount: current.orderAmount, originalStatus: current.orderStatus,
        sections: [
          { id: 'order-info', title: '订单基本信息', fieldIds: ['orderNo', 'documentNo', 'groupName', 'orderStatus', 'channelService', 'orderAmount', 'amountChanged'] },
          { id: 'hospital-info', title: '医院信息', fieldIds: ['hospital', 'hospitalAddress', 'department', 'doctor'] },
          { id: 'time-info', title: '时间信息', fieldIds: TIME_FIELDS.map(([fieldId]) => fieldId) },
          { id: 'escort-summary', title: '陪诊小结', fieldIds: ['escortSummary'] },
          ...escortRecords.map((_, index) => {
            const prefix = `escort-${index + 1}`
            return { id: prefix, title: `陪诊服务 ${index + 1}`, fieldIds: [`${prefix}-date`, `${prefix}-name`, `${prefix}-phone`], repeatable: true }
          }),
          ...(unmatchedAi.length ? [{ id: 'unmatched-ai', title: 'AI 建议', fieldIds: unmatchedAi.map((_, index) => `unmatched-ai-${index}`) }] : [])
        ],
        actions: [{ id: 'one-click-fill', label: '一键填单', tone: 'primary' }],
        submitState: 'idle'
      }
      this.currentPanel = formPanel
      this.updatePanel(id, formPanel)
    } catch (error) {
      if (this.active?.token !== token || this.active.invalidated || this.active.formOrderNo !== orderNo) return
      this.currentPanel = {
        kind: 'error', id,
        text: `订单 ${orderNo} 的 AI 分析获取失败：${error instanceof Error ? error.message : String(error)}`,
        actions: []
      }
      this.updatePanel(id, this.currentPanel)
    }
  }
}
