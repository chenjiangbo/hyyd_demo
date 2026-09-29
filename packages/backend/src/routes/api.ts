import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { PrismaClient, Prisma } from '@prisma/client'
import * as Minio from 'minio'
import { scheduleTranscription } from '../asr/transcribeScheduler.js'
import { broadcastAdmin } from './adminBus.js'
import { summarizeCall, summarizeMessages, summarizeFull } from '../llm/summaryService.js'
import { getEnv } from '../env.js'
import { extractOrderCandidate, resolveOrder, type OrderNoEntry } from '../lib/orderNoMatch.js'
import { parseEscortDispatchTemplate } from '../lib/escortTemplateMatch.js'
import { parseChatTime } from '../lib/chatTimeParser.js'
import { extractKeyInfo, type KeyInfoMessage, type KeyInfoContext } from '../llm/keyInfoService.js'
import { structureMessages, type StructInput } from '../lib/messageStructure.js'
import { refreshApplicationBrief, refreshOrderBrief } from '../jobs/orderBriefRunner.js'
import { getRecordingPlaybackInfo } from '../audioTranscode.js'
import {
  findHuanyuChannelProductById,
  findHuanyuChannelProductsByIds,
  findHuanyuHospitalById,
  findHuanyuDepartmentById,
  findHuanyuDoctorById,
  findHuanyuEscortById,
  findHuanyuDoctorIdsByName,
  findHuanyuDepartmentIdsByName,
  findHuanyuHospitalIdsByName,
  findHuanyuProductIdsByName,
  findHuanyuHospitalsByIds,
  findHuanyuDepartmentsByIds,
  findHuanyuDoctorsByIds,
  listHuanyuBdUsers,
  listHuanyuChannelProducts,
  listHuanyuChannels,
  listHuanyuEscorts,
  listHuanyuHospitalAddresses,
  listHuanyuHospitalDepartments,
  listHuanyuHospitalDoctors,
  listHuanyuHospitals
} from '../db/remoteDictionary.js'
import { huanyuBookingChannelTypes, huanyuDocumentTypes, huanyuExpertLevels, huanyuMedicareTypes, huanyuOrderStatuses } from '../dictionaries/huanyuOrder.js'
import { registerDictionaryManageRoutes } from './dictionaryManage.js'
import { registerEscortFeedbackRoutes } from './escortFeedbackRoutes.js'
import { applyOrderWorkflowEvent, getOrderWorkflow, initializeOrderWorkflow, type WorkflowEventInput } from '../workflow/serviceWorkflow.js'
import {
  pullHuanyuOrderFromMysqlByChannelOrderNo,
  pushHuanyuOrderToMysql,
  refreshRegistrationAssistFieldsFromMysql,
  REGISTRATION_ASSIST_REMOTE_AUTHORITATIVE_COLUMNS
} from '../huanyuMysqlPush.js'
import { autoSyncOrderMasterData, ensureRemoteEscort } from '../services/masterDataAutoSync.js'
import { requestAbiRefund } from '../services/abiRefundService.js'
import { createHash, randomUUID } from 'node:crypto'
import {
  CreateOrderPayload,
  ClaimOrderPayload, 
  CreateMessagePayload, 
  CreateCallPayload, 
  CreateRecordingPayload, 
  CommandDonePayload,
  ApiResponse,
  Order,
  Message,
  Call,
  Command,
  OrderAggregate
} from '@huanyu/shared-types'

// 将 employee 挂载到 Fastify 实例请求上
declare module 'fastify' {
  interface FastifyRequest {
    employee?: {
      id: number
      name: string
      phone: string
      wechatId: string | null
      taikangAccount: string | null
      token: string
    }
  }
}

// 内存中维护的员工与其对应的 WebSocket 连接
// 员工ID -> { ext?: Socket, tray?: Socket }
export const activeConnections = new Map<number, { ext?: any; tray?: any }>()

// 内存中维护的员工 presence 状态（由插件 PRESENCE 心跳更新）
// 员工ID -> { taikangTabOpen, lastSeenAt }
// 注：原 mode 字段（pool_reader / worker）已无意义——插件现在只读个人池，
// 不再下发 mode，所以从类型里删掉。
export interface PresenceInfo {
  taikangTabOpen: boolean
  trackingPoolPageActive: boolean
  lastSeenAt: number
  // 泰康 token 保活状态（由插件 content script 定时探测后上报）
  tokenOk?: boolean | null
  tokenReason?: string | null
  tokenLastCheckAt?: number | null
}
export const presenceMap = new Map<number, PresenceInfo>()
export const extPresenceMap = new Map<number, Map<string, PresenceInfo>>()
export const EXT_HEARTBEAT_TIMEOUT_MS = 30_000

function latestPresence(infos: PresenceInfo[]): PresenceInfo | null {
  if (infos.length === 0) return null
  return infos.reduce((best, cur) => cur.lastSeenAt > best.lastSeenAt ? cur : best)
}

export function aggregateExtPresence(employeeId: number, now = Date.now()): PresenceInfo | null {
  const instances = [...(extPresenceMap.get(employeeId)?.values() ?? [])]
  if (instances.length === 0) return presenceMap.get(employeeId) ?? null

  const fresh = instances.filter((info) => now - info.lastSeenAt <= EXT_HEARTBEAT_TIMEOUT_MS)
  const scope = fresh.length > 0 ? fresh : instances
  const latest = latestPresence(scope)
  if (!latest) return null

  const tokenOkInstance = fresh.find((info) => info.tokenOk === true)
  const tokenFailInstances = fresh.filter((info) => info.tokenOk === false)
  const latestTokenFail = latestPresence(tokenFailInstances)
  const latestTokenInfo = latestPresence(fresh.filter((info) => info.tokenOk !== undefined && info.tokenOk !== null))

  return {
    taikangTabOpen: scope.some((info) => info.taikangTabOpen),
    trackingPoolPageActive: scope.some((info) => info.trackingPoolPageActive),
    lastSeenAt: latest.lastSeenAt,
    tokenOk: tokenOkInstance ? true : tokenFailInstances.length > 0 ? false : null,
    tokenReason: tokenOkInstance ? null : latestTokenFail?.tokenReason ?? null,
    tokenLastCheckAt: tokenOkInstance?.tokenLastCheckAt ?? latestTokenInfo?.tokenLastCheckAt ?? null
  }
}

export function setExtPresenceInstance(employeeId: number, instanceId: string, patch: Partial<PresenceInfo>): PresenceInfo {
  const byInstance = extPresenceMap.get(employeeId) ?? new Map<string, PresenceInfo>()
  const prev = byInstance.get(instanceId)
  const next: PresenceInfo = {
    taikangTabOpen: patch.taikangTabOpen ?? prev?.taikangTabOpen ?? false,
    trackingPoolPageActive: patch.trackingPoolPageActive ?? prev?.trackingPoolPageActive ?? false,
    lastSeenAt: patch.lastSeenAt ?? prev?.lastSeenAt ?? Date.now(),
    tokenOk: patch.tokenOk !== undefined ? patch.tokenOk : prev?.tokenOk ?? null,
    tokenReason: patch.tokenReason !== undefined ? patch.tokenReason : prev?.tokenReason ?? null,
    tokenLastCheckAt: patch.tokenLastCheckAt !== undefined ? patch.tokenLastCheckAt : prev?.tokenLastCheckAt ?? null
  }
  byInstance.set(instanceId, next)
  extPresenceMap.set(employeeId, byInstance)
  const aggregate = aggregateExtPresence(employeeId)
  if (aggregate) presenceMap.set(employeeId, aggregate)
  return next
}

export function deleteExtPresenceInstance(employeeId: number, instanceId: string): void {
  const byInstance = extPresenceMap.get(employeeId)
  if (!byInstance) return
  byInstance.delete(instanceId)
  if (byInstance.size === 0) {
    extPresenceMap.delete(employeeId)
    presenceMap.delete(employeeId)
    return
  }
  const aggregate = aggregateExtPresence(employeeId)
  if (aggregate) presenceMap.set(employeeId, aggregate)
}

// Tray 桌面端没有 WebSocket（纯 REST），靠它每 5s 轮询 /api/v1/me/presence 当心跳。
// 这里记录每个员工最近一次该轮询的时间戳，给管理后台判断"Tray 是否在线"。
// 员工ID -> 最近一次 /me/presence 命中的毫秒时间戳
export const trayRestSeenMap = new Map<number, number>()

// 移动端 App 没有可靠常驻 WS：前台服务高频上报，WorkManager 至少每 15 分钟执行一次。
// Android/厂商系统可能暂停后台任务，因此这里表达“状态建议”，不把短暂断心跳直接当故障。
export const mobileSeenMap = new Map<number, { lastSeenAt: number; source: string }>()
const MOBILE_ACTIVE_WINDOW_MS = 2 * 60_000
const MOBILE_BACKGROUND_WINDOW_MS = 30 * 60_000

function markMobileSeen(employeeId: number, source: string) {
  mobileSeenMap.set(employeeId, { lastSeenAt: Date.now(), source })
}

type MatchedOrderPhone = {
  id: number
  source_order_no: string
  customer_name: string | null
  status: string | null
  updated_at: Date
  application_no: string | null
}

type ApplicationMatch = {
  applicationNo: string | null
  orderId: number | null
}

type WorkbenchLane = 'todo' | 'doing' | 'await_backfill' | 'done'
type ServiceStage = 'claimed' | 'communicating' | 'delivering' | 'settlement' | 'closing'

// 工作台只认寰宇订单详情 HY_FACT_DDCX_NEW.DD_state 的这四个状态。
// 不再把泰康/B 端原始状态映射到工作台泳道，其他寰宇状态也不挤进这四列。
const HUANYU_WORKBENCH_LANES: Readonly<Record<string, WorkbenchLane>> = {
  '待跟进': 'todo',
  '待预约': 'doing',
  '待交付': 'await_backfill',
  '预约完成待支付': 'done'
}

function stringOrNull(value: unknown): string | null {
  if (value == null) return null
  const text = String(value).trim()
  return text || null
}

function taikangOrderStateNameOf(raw: Record<string, unknown>, fallback: unknown): string {
  return (
    stringOrNull(raw.taikangOrderStateName) ??
    stringOrNull(raw.orderStateName) ??
    stringOrNull(raw.status) ??
    stringOrNull(fallback) ??
    '未知'
  )
}

function taikangOrderStateOf(raw: Record<string, unknown>, fallback: unknown): string | null {
  return stringOrNull(raw.taikangOrderState) ?? stringOrNull(raw.orderState) ?? stringOrNull(fallback)
}

function deriveWorkbenchLane(huanyuOrderStatus: string | null): WorkbenchLane | null {
  return huanyuOrderStatus ? HUANYU_WORKBENCH_LANES[huanyuOrderStatus] ?? null : null
}

function deriveServiceStage(lane: WorkbenchLane | null): ServiceStage | null {
  switch (lane) {
    case 'todo':
      return 'communicating'
    case 'doing':
      return 'delivering'
    case 'await_backfill':
      return 'settlement'
    case 'done':
      return 'closing'
    default:
      return null
  }
}

export function normalizeEmployeeCode(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim()
}

function normalizeConversationNameForDedupe(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function normalizeMessageContentForDedupe(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[，。！？；：、,.!?;:"'“”‘’（）()【】[\]《》<>…~·]/g, '')
}

function hashDedupePart(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function ensureEmployeeByCode(prisma: PrismaClient, employeeCode: string) {
  const code = normalizeEmployeeCode(employeeCode)
  if (!code) throw new Error('员工 ID 为空')
  return prisma.employee.upsert({
    where: { token: code },
    update: {},
    create: {
      name: code,
      phone: '',
      token: code
    }
  })
}

export function normalizeTaikangAccount(raw: unknown): string {
  const account = typeof raw === 'string' ? raw.trim() : ''
  if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(account)) return ''
  return account
}

export async function findEmployeeByTaikangAccount(prisma: PrismaClient, taikangAccount: string) {
  const account = normalizeTaikangAccount(taikangAccount)
  if (!account) return { status: 'invalid' as const, employee: null }

  const employees = await prisma.employee.findMany({
    where: { taikangAccount: account },
    take: 2,
  })
  if (employees.length === 1) return { status: 'ok' as const, employee: employees[0] }
  if (employees.length === 0) return { status: 'not_found' as const, employee: null }
  return { status: 'ambiguous' as const, employee: null }
}

export function registerApiRoutes(
  fastify: FastifyInstance,
  prisma: PrismaClient,
  minioClient: Minio.Client,
  minioPublicClient: Minio.Client = minioClient
) {
  const env = getEnv()

  function applicationNosForConversationMatch(rawJson: unknown): string[] {
    const raw = (rawJson ?? {}) as Record<string, unknown>
    // 客户会话只匹配泰康界面的"申请号"字段：rawJson.crmApplyNo（OD... / fwyy...）。
    // COD/sourceOrderNo 是订单生命周期粒度，CCOD/applyNo 不是现场备注使用的申请号，均不参与客户会话自动匹配。
    return [raw.crmApplyNo].filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
  }

  async function matchOrderByPhone(phone: string): Promise<MatchedOrderPhone | null> {
    const normPhone = (phone ?? '').replace(/\D/g, '')
    if (!normPhone) return null

    const matched = await prisma.$queryRaw<MatchedOrderPhone[]>`
      SELECT
             id,
             source_order_no,
             customer_name,
             status,
             updated_at,
             raw_json->>'crmApplyNo' AS application_no
        FROM orders
       WHERE (
           regexp_replace(COALESCE(customer_phone, ''), '\D', '', 'g') = ${normPhone}
           OR EXISTS (
             SELECT 1
               FROM jsonb_each_text(COALESCE(detail_json->'recommendations', '{}'::jsonb)) AS rec(key, value)
              WHERE rec.key ~* '(phone|mobile)'
                AND regexp_replace(COALESCE(rec.value, ''), '\D', '', 'g') = ${normPhone}
           )
         )
       ORDER BY updated_at DESC
       LIMIT 1
    `
    return matched[0] ?? null
  }

  async function resolveConfirmedApplication(
    employeeId: number,
    candidate: string
  ): Promise<ApplicationMatch | null> {
    const confirmedRef = await prisma.unmatchedOrderRef.findUnique({
      where: { employee_candidate: { employeeId, candidate } },
      select: { status: true, resolvedOrderId: true, resolvedApplicationNo: true }
    })
    if (confirmedRef?.status !== 'confirmed') return null
    const applicationNo = confirmedRef.resolvedApplicationNo
    if (applicationNo) {
      const appOrders = await prisma.order.findMany({
        where: { rawJson: { path: ['crmApplyNo'], equals: applicationNo } },
        select: { id: true }
      })
      return { applicationNo, orderId: appOrders.length === 1 ? appOrders[0].id : null }
    }
    if (!confirmedRef.resolvedOrderId) return null
    const order = await prisma.order.findFirst({
      where: { id: confirmedRef.resolvedOrderId },
      select: { id: true, rawJson: true }
    })
    if (!order) return null
    const legacyApplicationNo = applicationNosForConversationMatch(order.rawJson)[0] ?? null
    if (!legacyApplicationNo) return { applicationNo: null, orderId: order.id }
    const appOrderCount = await prisma.order.count({
      where: { rawJson: { path: ['crmApplyNo'], equals: legacyApplicationNo } }
    })
    return { applicationNo: legacyApplicationNo, orderId: appOrderCount === 1 ? order.id : null }
  }

  async function resolveApplicationForCandidate(
    employeeId: number,
    channel: string,
    conversationName: string,
    candidateRaw: string,
    candidateKind: string,
    screenshotOssKey: string | null,
    capturedAt: Date
  ): Promise<ApplicationMatch | null> {
    const confirmed = await resolveConfirmedApplication(employeeId, candidateRaw)
    if (confirmed) {
      fastify.log.info(`申请号候选已人工确认: “${candidateRaw}” → application=${confirmed.applicationNo ?? '-'} order=${confirmed.orderId ?? '-'}`)
      return confirmed
    }

    const orders = await prisma.order.findMany({
      select: { id: true, rawJson: true, customerName: true }
    })
    const appToOrders = new Map<string, typeof orders>()
    for (const order of orders) {
      for (const appNo of applicationNosForConversationMatch(order.rawJson)) {
        const arr = appToOrders.get(appNo) ?? []
        arr.push(order)
        appToOrders.set(appNo, arr)
      }
    }

    let fakeId = 1
    const fakeIdToApp = new Map<number, string>()
    const entries: OrderNoEntry[] = Array.from(appToOrders.entries()).map(([appNo, appOrders]) => {
      const id = fakeId++
      fakeIdToApp.set(id, appNo)
      return {
        orderId: id,
        nos: [appNo],
        name: appOrders.map((o) => o.customerName).find(Boolean) ?? null
      }
    })

    const r = resolveOrder(candidateRaw, entries, 2, conversationName)
    if (r.status === 'matched') {
      const applicationNo = fakeIdToApp.get(r.orderId) ?? null
      if (!applicationNo) return null
      const appOrders = appToOrders.get(applicationNo) ?? []
      const orderId = appOrders.length === 1 ? appOrders[0].id : null
      fastify.log.info(
        `申请号解析命中: “${candidateRaw}” → ${applicationNo}（订单数 ${appOrders.length}，距离 ${r.dist}）`
      )
      return { applicationNo, orderId }
    }

    const reason = r.status === 'ambiguous' ? 'ambiguous' : r.status === 'name_mismatch' ? 'name_mismatch' : 'no_match'
    const bestDist = r.status === 'name_mismatch' ? r.dist : r.bestDist
    const candidateOrderIds =
      r.status === 'ambiguous'
        ? r.orderIds.flatMap((id) => appToOrders.get(fakeIdToApp.get(id) ?? '')?.map((o) => o.id) ?? [])
        : undefined

    await prisma.unmatchedOrderRef.upsert({
      where: { employee_candidate: { employeeId, candidate: candidateRaw } },
      create: {
        employeeId,
        channel,
        conversationName,
        candidate: candidateRaw,
        candidateKind,
        reason,
        bestDist,
        candidateOrderIds,
        screenshotOssKey,
        capturedAt
      },
      update: {
        seenCount: { increment: 1 },
        conversationName,
        reason,
        bestDist,
        candidateOrderIds: candidateOrderIds ?? Prisma.JsonNull,
        screenshotOssKey,
        capturedAt
      }
    })
    return null
  }
  
  // 1. 鉴权 Hook
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // 排除健康检查等不需要鉴权的接口。
    // - /api/v1/admin/*：走独立管理员 JWT cookie 鉴权（见 routes/admin.ts）
    // - /admin/*：管理后台前端静态资源（@fastify/static），由前端自身登录态控制
    // 这些都不参与员工 X-Employee-Code 体系，直接放行。
    if (
      request.url === '/health' ||
      request.url === '/api/v1/login' ||
      request.url.startsWith('/ws') ||
      request.url.startsWith('/api/v1/admin') ||
      request.url.startsWith('/api/v1/order-attachments/') ||
      request.url.startsWith('/admin') ||
      request.url.startsWith('/ext') || // 插件分发文件（.crx / update.xml），公开资源
      request.url.startsWith('/download') || // App 安装包下载，公开资源
      request.url.startsWith('/api/v1/departments') ||
      request.url.startsWith('/api/v1/hospitals') ||
      request.url.startsWith('/api/v1/doctors') ||
      request.url.startsWith('/api/v1/channels') ||
      request.url.startsWith('/api/v1/internal-products') ||
      request.url.startsWith('/api/v1/payment-channels') ||
      request.url.startsWith('/api/v1/escorts') ||
      request.url.startsWith('/api/v1/regions') ||
      request.url.startsWith('/api/v1/dim_cslb') ||
      request.url.startsWith('/m/') ||
      request.url.startsWith('/api/v1/escort-feedback')
    ) {
      return
    }

    const employeeCode = normalizeEmployeeCode(request.headers['x-employee-code'])
    if (!employeeCode) {
      reply.status(401).send({ error: '缺少 X-Employee-Code 请求头' })
      return
    }

    request.employee = await ensureEmployeeByCode(prisma, employeeCode)
  })

  // 2. 健康检查接口
  fastify.get('/health', async () => {
    return { status: 'OK', timestamp: new Date().toISOString() }
  })

  // 2.1 员工登录接口（用工号密码换取身份会话）
  fastify.post('/api/v1/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { username?: string; employeeCode?: string; account?: string; password?: string }
    const user = (body.username || body.employeeCode || body.account || '').trim()
    const pwd = (body.password || '').trim()

    if (!user || !pwd) {
      return reply.status(400).send({ error: '工号和密码不能为空' })
    }

    const emp = await prisma.employee.findUnique({
      where: { token: user }
    })

    if (!emp) {
      return reply.status(401).send({ error: '用户名或密码错误' })
    }

    if (emp.enabled === 0) {
      return reply.status(403).send({ error: '账号已被停用，请联系管理员' })
    }

    // 前台登录强制输入明文：现场计算 MD5（彻底杜绝拿 MD5 密文直接登录的哈希传递漏洞）
    const inputMd5 = createHash('md5').update(pwd).digest('hex').toLowerCase()

    const storedPwd = (emp.password || '').trim()
    // 数据库中必须严格是 32 位 MD5 密文，拒绝任何明文存储或非合规数据
    if (!storedPwd || !/^[a-f0-9]{32}$/i.test(storedPwd)) {
      request.log.warn(`[Auth] 员工 ${emp.token} 数据库密码未加密或格式不合规，已拒绝登录`)
      return reply.status(401).send({ error: '用户名或密码错误' })
    }

    if (inputMd5 !== storedPwd.toLowerCase()) {
      return reply.status(401).send({ error: '用户名或密码错误' })
    }

    return reply.send({
      data: {
        id: emp.id,
        employeeCode: emp.token,
        displayName: emp.name || emp.token,
        token: emp.token
      }
    })
  })

  // 2.2 修改密码接口
  fastify.post('/api/v1/me/password', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = (request.body ?? {}) as any
    const empCode = request.headers['x-employee-code'] || parsed.employeeCode || request.employee?.token
    if (!empCode) {
      return reply.status(401).send({ error: '未登录或缺少工号信息' })
    }

    const { oldPassword, newPassword } = parsed
    const oldPwd = String(oldPassword || '').trim()
    const newPwd = String(newPassword || '').trim()

    if (!oldPwd || !newPwd) {
      return reply.status(400).send({ error: '旧密码和新密码不能为空' })
    }

    const emp = await prisma.employee.findUnique({
      where: { token: String(empCode).trim() }
    })

    if (!emp) {
      return reply.status(401).send({ error: '未找到当前登录用户' })
    }

    // 旧密码强制视为明文输入，现场计算 MD5
    const inputOldMd5 = createHash('md5').update(oldPwd).digest('hex').toLowerCase()

    const storedPwd = (emp.password || '').trim()
    if (!storedPwd || !/^[a-f0-9]{32}$/i.test(storedPwd)) {
      return reply.status(400).send({ error: '原账号密码未加密或未设置，请联系管理员重置' })
    }

    if (inputOldMd5 !== storedPwd.toLowerCase()) {
      return reply.status(400).send({ error: '旧密码输入不正确' })
    }

    // 新密码强制视为明文输入，计算 MD5 入库，确保数据库保存严格为 32 位密文
    const newMd5 = createHash('md5').update(newPwd).digest('hex').toLowerCase()

    if (newMd5 === storedPwd.toLowerCase()) {
      return reply.status(400).send({ error: '新密码不能与旧密码相同' })
    }

    await prisma.employee.update({
      where: { id: emp.id },
      data: { password: newMd5 }
    })

    return reply.send({ ok: true, message: '密码修改成功' })
  })

  fastify.get('/api/v1/me', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    return reply.send({
      data: {
        id: request.employee.id,
        employeeCode: request.employee.token,
        displayName: request.employee.name
      }
    })
  })

  // 订单业务轨迹：页面只读取订单实例，首次读取会依据服务类型初始化必选步骤。
  fastify.get<{ Params: { id: string } }>('/api/v1/orders/:id/workflow', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const orderId = Number(request.params.id)
    if (!Number.isInteger(orderId) || orderId <= 0) return reply.status(400).send({ error: '订单 ID 无效' })
    const workflow = await getOrderWorkflow(prisma, orderId)
    if (!workflow) return reply.status(404).send({ error: '订单不存在' })
    return reply.send({ data: workflow })
  })

  // 仅接收已被表单、AI 或人工确认的事实事件；不允许客户端直接创建任意服务包。
  fastify.post<{ Params: { id: string } }>('/api/v1/orders/:id/workflow/events', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const orderId = Number(request.params.id)
    if (!Number.isInteger(orderId) || orderId <= 0) return reply.status(400).send({ error: '订单 ID 无效' })
    const body = (request.body ?? {}) as Partial<WorkflowEventInput>
    if (typeof body.code !== 'string' || !body.code.trim()) return reply.status(400).send({ error: '缺少业务事件 code' })
    if (!['form', 'ai', 'manual'].includes(String(body.source))) return reply.status(400).send({ error: '业务事件 source 无效' })
    const source = body.source as WorkflowEventInput['source']
    if (body.confidence != null && (typeof body.confidence !== 'number' || body.confidence < 0 || body.confidence > 1)) {
      return reply.status(400).send({ error: '置信度必须在 0 到 1 之间' })
    }
    if (body.occurrenceNo != null && (!Number.isInteger(body.occurrenceNo) || body.occurrenceNo < 1)) {
      return reply.status(400).send({ error: '服务包序号无效' })
    }
    try {
      const workflow = await applyOrderWorkflowEvent(prisma, orderId, {
        code: body.code.trim(),
        source,
        sourceRef: typeof body.sourceRef === 'string' ? body.sourceRef : null,
        confidence: body.confidence ?? null,
        evidence: body.evidence,
        note: typeof body.note === 'string' ? body.note : null,
        occurrenceNo: body.occurrenceNo
      })
      if (!workflow) return reply.status(404).send({ error: '订单不存在' })
      return reply.send({ data: workflow })
    } catch (error) {
      const message = error instanceof Error ? error.message : '业务步骤更新失败'
      return reply.status(400).send({ error: message })
    }
  })

  // 寰宇订单下拉字典：仅调用 remoteDictionary 中固定的参数化 SELECT。
  fastify.get<{ Querystring: { q?: string; currentId?: string } }>('/api/v1/dictionaries/huanyu/channels', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const options = await listHuanyuChannels(request.query.q, request.query.currentId)
    return reply.send({ data: options })
  })

  fastify.get<{ Querystring: { channelId?: string; q?: string; currentId?: string } }>('/api/v1/dictionaries/huanyu/channel-products', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const options = await listHuanyuChannelProducts(request.query.channelId, request.query.q, request.query.currentId)
    return reply.send({ data: options })
  })

  // 寰宇订单预约渠道类型为后端固定字典，不连接远端数据库。
  fastify.get('/api/v1/dictionaries/huanyu/booking-channel-types', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    return reply.send({ data: huanyuBookingChannelTypes() })
  })

  // 寰宇订单状态为后端固定字典，不连接远端数据库。
  fastify.get('/api/v1/dictionaries/huanyu/order-statuses', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    return reply.send({ data: huanyuOrderStatuses() })
  })

  // 寰宇订单证件类型为后端固定字典，id 与展示名称一致。
  fastify.get('/api/v1/dictionaries/huanyu/document-types', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    return reply.send({ data: huanyuDocumentTypes() })
  })

  // 寰宇订单医保类型为后端固定字典，id 与展示名称一致。
  fastify.get('/api/v1/dictionaries/huanyu/medicare-types', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    return reply.send({ data: huanyuMedicareTypes() })
  })

  fastify.get<{ Querystring: { q?: string; currentId?: string } }>('/api/v1/dictionaries/huanyu/bd-users', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const options = await listHuanyuBdUsers(request.query.q, request.query.currentId)
    return reply.send({ data: options })
  })

  fastify.get<{ Querystring: { q?: string; currentId?: string } }>('/api/v1/dictionaries/huanyu/hospitals', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    return reply.send({ data: await listHuanyuHospitals(request.query.q, request.query.currentId) })
  })

  fastify.get<{ Params: { id: string } }>('/api/v1/dictionaries/huanyu/hospitals/:id', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const item = await findHuanyuHospitalById(request.params.id)
    return reply.send({ data: item })
  })

  fastify.get<{ Querystring: { hospitalId?: string; q?: string; currentId?: string } }>('/api/v1/dictionaries/huanyu/hospital-addresses', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    return reply.send({ data: await listHuanyuHospitalAddresses(request.query.hospitalId, request.query.q, request.query.currentId) })
  })

  fastify.get<{ Querystring: { hospitalId?: string; q?: string; currentId?: string } }>('/api/v1/dictionaries/huanyu/hospital-departments', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    return reply.send({ data: await listHuanyuHospitalDepartments(request.query.hospitalId, request.query.q, request.query.currentId) })
  })

  fastify.get<{ Params: { id: string } }>('/api/v1/dictionaries/huanyu/departments/:id', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const item = await findHuanyuDepartmentById(request.params.id)
    return reply.send({ data: item })
  })

  fastify.get<{ Querystring: { hospitalId?: string; departmentId?: string; q?: string; currentId?: string } }>('/api/v1/dictionaries/huanyu/hospital-doctors', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    return reply.send({ data: await listHuanyuHospitalDoctors(request.query.hospitalId, request.query.departmentId, request.query.q, request.query.currentId) })
  })

  fastify.get<{ Params: { id: string } }>('/api/v1/dictionaries/huanyu/doctors/:id', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const item = await findHuanyuDoctorById(request.params.id)
    return reply.send({ data: item })
  })

  fastify.get<{ Querystring: { q?: string } }>('/api/v1/dictionaries/huanyu/expert-levels', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    return reply.send({ data: huanyuExpertLevels(request.query.q) })
  })

  fastify.get<{ Querystring: { q?: string; currentId?: string } }>('/api/v1/dictionaries/huanyu/escorts', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    return reply.send({ data: await listHuanyuEscorts(request.query.q, request.query.currentId) })
  })

  fastify.get<{ Params: { id: string } }>('/api/v1/dictionaries/huanyu/escorts/:id', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const item = await findHuanyuEscortById(request.params.id)
    return reply.send({ data: item })
  })

  // 2.5 当前员工 presence 状态查询（给 Tray App 显示警告 banner 用）
  fastify.get('/api/v1/me/presence', async (request, reply) => {
    if (!request.employee) {
      return reply.status(401).send({ error: '未登录' })
    }
    // Tray 桌面端心跳：记录本次轮询时间，供管理后台判断 tray 在线
    trayRestSeenMap.set(request.employee.id, Date.now())

    const info = aggregateExtPresence(request.employee.id)

    // 移动端状态：
    // - 2 分钟内前台/前台服务心跳：在线采集中
    // - 30 分钟内 WorkManager/其他心跳，或 30 分钟内有通话补传：后台等待中
    // - 超过窗口：需要员工打开 App 触发补传，而不是按“故障离线”处理
    const mobileSeen = mobileSeenMap.get(request.employee.id)
    const mobileAge = mobileSeen ? Date.now() - mobileSeen.lastSeenAt : Number.POSITIVE_INFINITY
    const isWorkerHeartbeat = mobileSeen?.source === 'work_manager'
    let mobileState: 'active' | 'background' | 'needs_open' =
      mobileAge <= MOBILE_ACTIVE_WINDOW_MS && !isWorkerHeartbeat
        ? 'active'
        : mobileAge <= MOBILE_BACKGROUND_WINDOW_MS
          ? 'background'
          : 'needs_open'
    let mobileOnlineReason: 'heartbeat' | 'recent_call' | null =
      mobileState === 'needs_open' ? null : 'heartbeat'
    if (mobileState === 'needs_open') {
      const recentCall = await prisma.call.findFirst({
        where: { employeeId: request.employee.id, startedAt: { gte: new Date(Date.now() - MOBILE_BACKGROUND_WINDOW_MS) } },
        select: { id: true }
      })
      if (recentCall) {
        mobileState = 'background'
        mobileOnlineReason = 'recent_call'
      }
    }
    const mobileOnline = mobileState !== 'needs_open'
    const mobileLastSeenAt = mobileSeen ? new Date(mobileSeen.lastSeenAt).toISOString() : null
    const mobileHeartbeatSource = mobileSeen?.source ?? null

    if (!info) {
      // 插件从未上报过 presence
      return reply.send({
        data: {
          extConnected: false,
          taikangTabOpen: false,
          trackingPoolPageActive: false,
          mobileOnline,
          mobileState,
          mobileOnlineReason,
          mobileLastSeenAt,
          mobileHeartbeatSource,
          stale: true,
          lastSeenAt: null
        }
      })
    }

    const stale = Date.now() - info.lastSeenAt > EXT_HEARTBEAT_TIMEOUT_MS
    return reply.send({
      data: {
        extConnected: !stale,
        taikangTabOpen: info.taikangTabOpen,
        trackingPoolPageActive: info.trackingPoolPageActive,
        mobileOnline,
        mobileState,
        mobileOnlineReason,
        mobileLastSeenAt,
        mobileHeartbeatSource,
        stale,
        lastSeenAt: new Date(info.lastSeenAt).toISOString(),
        tokenOk: info.tokenOk ?? null,
        tokenReason: info.tokenReason ?? null,
        tokenLastCheckAt: info.tokenLastCheckAt
          ? new Date(info.tokenLastCheckAt).toISOString()
          : null
      }
    })
  })

  // 2.6 移动端 App 在线心跳：移动端没有 WS，定时 POST 这里上报在线（建议 20~30s 一次）。
  fastify.post<{ Body: { source?: string } }>('/api/v1/me/mobile-heartbeat', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const source = String(request.body?.source ?? 'heartbeat').trim().slice(0, 50) || 'heartbeat'
    markMobileSeen(request.employee.id, source)
    return reply.send({ data: { ok: true } })
  })

  // 3. 上报/同步订单 POST /api/v1/orders
  fastify.post<{ Body: CreateOrderPayload }>('/api/v1/orders', async (request, reply) => {
    const { source, sourceOrderNo, customerName, customerPhone, hospital, dept, doctor, rawJson } = request.body

    try {
      const order = await prisma.order.upsert({
        where: {
          source_sourceOrderNo: {
            source,
            sourceOrderNo
          }
        },
        update: {
          customerName,
          customerPhone: customerPhone ?? null,
          hospital: hospital ?? null,
          dept: dept ?? null,
          doctor: doctor ?? null,
          rawJson: (rawJson as any) ?? null
        },
        create: {
          source,
          sourceOrderNo,
          customerName,
          customerPhone: customerPhone ?? null,
          hospital: hospital ?? null,
          dept: dept ?? null,
          doctor: doctor ?? null,
          status: '候选',
          rawJson: (rawJson as any) ?? null
        }
      })
      await initializeOrderWorkflow(prisma, order.id)

      return reply.send({ data: order })
    } catch (err: any) {
      fastify.log.error('创建/更新订单失败:', err)
      return reply.status(500).send({ error: '创建/更新订单失败: ' + err.message })
    }
  })

function isTaikangRegistrationAssistanceOrder(orderObj: any, rawObj: Record<string, unknown>): boolean {
  const originalRaw = rawObj.taikangRawJson ?? rawObj.rawJson
  const originalRecord = originalRaw && typeof originalRaw === 'object' && !Array.isArray(originalRaw)
    ? originalRaw as Record<string, unknown>
    : {}
  return orderObj.source === 'taikang' && (
    rawObj.poolType === 'register' || originalRecord.poolType === 'register'
  )
}

/** 金额按人民币元处理，拒绝科学计数法与超过两位的小数，避免退款请求精度漂移。 */
function parseRefundAmount(value: unknown): number | null {
  const raw = typeof value === 'number'
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : value != null && typeof (value as { toString?: unknown }).toString === 'function'
        ? String(value).trim()
        : ''
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null
  const amount = Number(raw)
  return Number.isFinite(amount) && amount > 0 ? amount : null
}

async function enrichOrderWithHuanyuFact(orderObj: any): Promise<any> {
  if (!orderObj) return orderObj
  try {
    const rawObj = (orderObj.rawJson || {})
    // 挂号协助的寰宇订单由远端回拉，绝不在泰康采集时本地新建。
    // 仅当本地尚无寰宇订单号时才触发回拉，避免详情页每次打开覆盖人工维护的本地快照。
    const isTaikangRegistrationAssistance = isTaikangRegistrationAssistanceOrder(orderObj, rawObj)
    const orderNoCandidates = [
      orderObj.sourceOrderNo,
      rawObj.sourceOrderNo,
      rawObj.channelOrderNo,
      rawObj.bOrderNo,
      rawObj.bChannelOrderNo,
      orderObj.orderNo,
      rawObj.orderNo,
      orderObj.id ? String(orderObj.id) : null
    ].filter(Boolean)

    if (orderNoCandidates.length === 0) return orderObj

    const placeholders = orderNoCandidates.map((_, i) => `$${i + 1}`).join(',')
    let huanyuRows = await prisma.$queryRawUnsafe<any[]>(`
      SELECT * FROM "HY_FACT_DDCX_NEW"
      WHERE "BDQD_DDBH" IN (${placeholders})
         OR "DDBH" IN (${placeholders})
      ORDER BY "xtsj_" DESC NULLS LAST
      LIMIT 1;
    `, ...orderNoCandidates)

    if ((!huanyuRows || huanyuRows.length === 0) && isTaikangRegistrationAssistance && !orderObj.huanyuOrderNo) {
      const pulled = await pullHuanyuOrderFromMysqlByChannelOrderNo(prisma, String(orderObj.sourceOrderNo || ''))
      if (pulled.found && pulled.ddbh) {
        await prisma.order.update({
          where: { id: orderObj.id },
          data: { huanyuOrderNo: pulled.ddbh }
        })
        // 回拉完成后从本地三张表统一组装，确保展示逻辑与普通寰宇订单一致。
        return enrichOrderWithHuanyuFact({ ...orderObj, huanyuOrderNo: pulled.ddbh })
      }
    }

    if (!huanyuRows || huanyuRows.length === 0) {
      return orderObj
    }

    let h = huanyuRows[0]
    const ddbh = h.DDBH
    let linkedOrder = orderObj
    if (isTaikangRegistrationAssistance && !orderObj.huanyuOrderNo && ddbh) {
      await prisma.order.update({
        where: { id: orderObj.id },
        data: { huanyuOrderNo: String(ddbh) }
      })
      linkedOrder = { ...orderObj, huanyuOrderNo: String(ddbh) }
    }
    if (isTaikangRegistrationAssistance && ddbh) {
      try {
        const refreshed = await refreshRegistrationAssistFieldsFromMysql(prisma, String(ddbh))
        if (refreshed) {
          huanyuRows = await prisma.$queryRaw<any[]>`
            SELECT * FROM "HY_FACT_DDCX_NEW" WHERE "DDBH" = ${String(ddbh)} LIMIT 1
          `
          h = huanyuRows[0] ?? h
        }
      } catch (error) {
        // 远端暂时不可用时继续用本地已保存快照展示，不阻断订单详情打开。
        fastify.log.warn({ err: error, ddbh }, '挂号协助远端权威字段刷新失败')
      }
    }
    // 内部一级/二级不落 orders；每次进入详情页都按已选服务项目码值只读查询维表。
    // 字典库暂时不可用时不影响订单详情其他字段展示。
    let channelProduct = null
    if (h.BDQD_FWXM) {
      try {
        channelProduct = await findHuanyuChannelProductById(String(h.BDQD_FWXM))
      } catch {
        channelProduct = null
      }
    }

    const escortRows = await prisma.$queryRawUnsafe<any[]>(`
      SELECT * FROM "fact_hy_pzrxx"
      WHERE "DDBH" = $1
      ORDER BY "ZJ" ASC;
    `, ddbh)

    const escortList = await Promise.all((escortRows || []).map(async (r: any, idx: number) => {
      let escortType = ''
      let phone = ''
      let area = ''
      if (r.PZR) {
        try {
          const escorts = await listHuanyuEscorts(String(r.PZR))
          const matched = escorts.find((e) => e.id === String(r.PZR) || e.name === String(r.PZR))
          if (matched) {
            escortType = matched.escortType
            phone = matched.phone
            area = matched.area
          }
        } catch {
          // ignore
        }
      }
      return {
        sequence: String(idx + 1),
        escortName: r.PZR || '',
        serviceDate: r.BBQ_FW || '',
        escortType,
        phone,
        area
      }
    }))

    const calculateAgeFromBirthOrId = (val: string | null | undefined): string => {
      if (!val) return ''
      const str = String(val).trim()
      const idMatch = /^(\d{6})(\d{4})(\d{2})(\d{2})\d{3}[\dXx]$/.exec(str)
      if (idMatch) {
        const year = Number(idMatch[2])
        const month = Number(idMatch[3])
        const day = Number(idMatch[4])
        const now = new Date()
        let age = now.getFullYear() - year
        const m = (now.getMonth() + 1) - month
        if (m < 0 || (m === 0 && now.getDate() < day)) age--
        return age >= 0 && age <= 150 ? String(age) : ''
      }
      const bdayMatch = /^(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})/.exec(str)
      if (bdayMatch) {
        const year = Number(bdayMatch[1])
        const month = Number(bdayMatch[2])
        const day = Number(bdayMatch[3])
        const now = new Date()
        let age = now.getFullYear() - year
        const m = (now.getMonth() + 1) - month
        if (m < 0 || (m === 0 && now.getDate() < day)) age--
        return age >= 0 && age <= 150 ? String(age) : ''
      }
      return ''
    }

    const resolvedPatientAge = (h.JZR_NL != null && String(h.JZR_NL).trim() !== '')
      ? String(h.JZR_NL)
      : (
          rawObj.patientAge ||
          rawObj.age ||
          calculateAgeFromBirthOrId(rawObj.birthday || rawObj.birthDate || (orderObj as any).detailJson?.recommendations?.birthday || h.JZR_ZJHM || rawObj.cardId || rawObj.certNo) ||
          ''
        )

    const raw = {
      ...rawObj,
      orderNo: h.DDBH || '',
      orderStatus: h.DD_state || orderObj.status || '',
      channel: h.BDQD || '',
      channelOrderNo: h.BDQD_DDBH || orderObj.sourceOrderNo || '',
      backupOrderNo: h.BDQD_DDBH2 || '',
      channelDetail: h.BDQD_XF || '',
      channelContact: h.BDQD_DJR || '',
      channelBackupContact: h.BDQD_DJR2 || '',
      channelService: h.BDQD_FWXM || '',
      internalLevelOne: channelProduct?.internalLevelOne || '',
      internalLevelTwo: channelProduct?.internalLevelTwo || '',
      orderAmount: h.DDJE != null ? String(h.DDJE) : '',
      accountManager: h.KHJL || '',
      patientName: h.JZR_XM || orderObj.customerName || '',
      documentType: h.JZR_ZJLX || '',
      documentNo: h.JZR_ZJHM || '',
      patientGender: h.JZR_XB || '',
      patientAge: resolvedPatientAge,
      patientPhone: h.JZR_LXDH || orderObj.customerPhone || '',
      familyName: h.JZR_JSMC || '',
      familyRelation: h.JZR_JSGX || '',
      familyPhone: h.JZR_JSLXFS || '',
      disease: h.JZR_JB || '',
      patientRequest: h.JZR_BZ || '',
      hospital: h.H_NAME || orderObj.hospital || '',
      hospitalAddress: h.H_ADDRESS || '',
      department: h.H_KS || orderObj.dept || '',
      doctor: h.H_YS || orderObj.doctor || '',
      serviceRemark: h.DDFWBZ || '',
      requestTime: h.BBQ_XQ || h.DATE_XQ || '',
      responseTime: h.BBQ_YD || h.DATE_YD || '',
      serviceStartTime: h.BBQ_QDFW || h.DATE_QDFW || '',
      bookingFeedbackTime: h.BBQ_FK || h.DATE_FK || '',
      latestTicketTime: h.lastQueuingTime || '',
      lastQueuingTime: h.lastQueuingTime || '',
      escortName: h.PZR || '',
      escortSummary: h.PZXJ || '',
      bookingChannelType: h.YYQDLX || '',
      bd: h.BDYH || '',
      registrationFee: h.registerAmount != null ? String(h.registerAmount) : '',
      advancePayment: h.isAdvancePay || '',
      advanceRegistrationFee: h.advanceRegisterAmount != null ? String(h.advanceRegisterAmount) : '',
      advanceRecovered: h.registerPayStatus || '',
      registrationRefund: h.refundCustAmount != null ? String(h.refundCustAmount) : '',
      alipayAccount: h.aliPayTradeNo || '',
      hasInsurance: h.medicare || '',
      insuranceType: h.medicareType || '',
      isTaiKang: h.isTaiKang || '0',
      expertLevel: h.expert_level || '',
      tkHospital: h.expectedHospital || rawObj.intendHos || '',
      tkProvince: h.expectedProvince || rawObj.intendProvince || rawObj.province || '',
      tkCity: h.expectedCity || rawObj.intendCity || rawObj.city || '',
      tkDepartment: h.expectedDepartment || rawObj.intendDept || '',
      escortList
    }

    let displayHospital = orderObj.hospital
    if (h.H_NAME) {
      const hosp = await findHuanyuHospitalById(h.H_NAME).catch(() => null)
      displayHospital = hosp?.name || h.H_NAME
    }
    let displayDept = orderObj.dept
    if (h.H_KS) {
      const d = await findHuanyuDepartmentById(h.H_KS).catch(() => null)
      displayDept = d?.name || h.H_KS
    }
    let displayDoctor = orderObj.doctor
    if (h.H_YS) {
      const doc = await findHuanyuDoctorById(h.H_YS).catch(() => null)
      displayDoctor = doc?.name || h.H_YS
    }

    return {
      ...linkedOrder,
      customerName: h.JZR_XM || linkedOrder.customerName,
      customerPhone: h.JZR_LXDH || linkedOrder.customerPhone,
      hospital: displayHospital,
      dept: displayDept,
      doctor: displayDoctor,
      status: h.DD_state || linkedOrder.status,
      rawJson: raw
    }
  } catch (err) {
    fastify.log.error({ err }, 'enrichOrderWithHuanyuFact error')
    return orderObj
  }
}

  // 3.1 保存/更新寰宇订单（同时落库 HY_FACT_DDCX_NEW, fact_hy_pzrxx 和 orders 表）
  fastify.post('/api/v1/orders/huanyu/save', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const body = (request.body as any) || {}
    // 内部一级/二级是 B 端服务项目的维表衍生展示字段，不应写回 orders.raw_json。
    const { internalLevelOne: _internalLevelOne, internalLevelTwo: _internalLevelTwo, ...orderRawBody } = body
    let orderNo = String(body.orderNo || '').trim()
    if (body.mode === 'update' && !orderNo) {
      return reply.status(400).send({ ok: false, error: '当前订单尚无寰宇订单编号，不能保存或创建本地寰宇订单' })
    }
    if (!orderNo && body.channelOrderNo) {
      const existing = await prisma.$queryRawUnsafe<Array<{ DDBH: string }>>(
        `SELECT "DDBH" FROM "HY_FACT_DDCX_NEW" WHERE "BDQD_DDBH" = $1 AND "DDBH" LIKE 'HYYD%' LIMIT 1;`,
        String(body.channelOrderNo).trim()
      )
      if (existing && existing.length > 0 && existing[0].DDBH) {
        orderNo = existing[0].DDBH
      }
    }
    if (!orderNo) {
      const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const rnd = Math.floor(10000000 + Math.random() * 90000000)
      orderNo = `HYYD${ymd}${rnd}`
    }
    const patientName = String(body.patientName || '').trim()
    if (body.mode === 'create' && !patientName) {
      return reply.status(400).send({ ok: false, error: '就诊人姓名不能为空' })
    }

    const employeeName = request.employee.name || request.employee.token
    const accountManager = String(body.accountManager || '').trim() || employeeName
    const orderStatus = String(body.orderStatus || '待跟进').trim()
    const nowStr = new Date().toISOString()

    const toHuanyuStorageFormat = (val: string | null | undefined): string | null => {
      if (!val) return null
      const trimmed = String(val).trim()
      if (!trimmed) return null
      if (/^\d{8}\s+\d{2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed
      const match = trimmed.match(/^(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/)
      if (match) {
        const yyyy = match[1]
        const mm = match[2].padStart(2, '0')
        const dd = match[3].padStart(2, '0')
        const hh = match[4].padStart(2, '0')
        const min = match[5].padStart(2, '0')
        const ss = (match[6] || '00').padStart(2, '0')
        return `${yyyy}${mm}${dd} ${hh}:${min}:${ss}`
      }
      return trimmed
    }

    const extractDateOnly = (val: string | null | undefined): string | null => {
      const dt = toHuanyuStorageFormat(val)
      if (!dt) return null
      const match = /^(\d{8})/.exec(dt)
      return match ? match[1] : null
    }

    const reqTimeFormatted = toHuanyuStorageFormat(body.requestTime)
    const respTimeFormatted = toHuanyuStorageFormat(body.responseTime || body.expectedBookingTime)
    const srvStartTimeFormatted = toHuanyuStorageFormat(body.serviceStartTime)
    const fkTimeFormatted = toHuanyuStorageFormat(body.bookingFeedbackTime)
    const lastQueueFormatted = toHuanyuStorageFormat(body.lastQueuingTime || body.latestTicketTime)

    try {
      // 1. 保存/更新主表 HY_FACT_DDCX_NEW
      await prisma.$executeRawUnsafe(`
        INSERT INTO "HY_FACT_DDCX_NEW" (
          "DDBH", "DD_state", "BDQD", "BDQD_DDBH", "BDQD_DDBH2", "BDQD_XF",
          "BDQD_DJR", "BDQD_DJR2", "BDQD_FWXM", "DDJE", "KHJL", "JZR_XM",
          "JZR_ZJLX", "JZR_ZJHM", "JZR_XB", "JZR_NL", "JZR_LXDH", "JZR_JSMC",
          "JZR_JSGX", "JZR_JSLXFS", "JZR_JB", "JZR_BZ", "H_NAME", "H_ADDRESS",
          "H_KS", "H_YS", "DDFWBZ", "BBQ_XQ", "DATE_XQ", "BBQ_YD", "DATE_YD",
          "BBQ_QDFW", "DATE_QDFW", "BBQ_FK", "DATE_FK", "BBQ_FW", "DATE_FW",
          "PZR", "PZXJ", "YYQDLX", "BDYH", "registerAmount", "isAdvancePay",
          "advanceRegisterAmount", "registerPayStatus", "refundCustAmount",
          "medicare", "medicareType", "isTaiKang", "expert_level", "lastQueuingTime", "xtsj_"
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17, $18,
          $19, $20, $21, $22, $23, $24,
          $25, $26, $27, $28, $29, $30, $31,
          $32, $33, $34, $35, $36, $37,
          $38, $39, $40, $41, $42, $43,
          $44, $45, $46,
          $47, $48, $49, $50, $51, $52
        )
        ON CONFLICT ("DDBH") DO UPDATE SET
          "DD_state" = EXCLUDED."DD_state",
          "BDQD" = EXCLUDED."BDQD",
          "BDQD_DDBH" = EXCLUDED."BDQD_DDBH",
          "BDQD_DDBH2" = EXCLUDED."BDQD_DDBH2",
          "BDQD_XF" = EXCLUDED."BDQD_XF",
          "BDQD_DJR" = EXCLUDED."BDQD_DJR",
          "BDQD_DJR2" = EXCLUDED."BDQD_DJR2",
          "BDQD_FWXM" = EXCLUDED."BDQD_FWXM",
          "DDJE" = EXCLUDED."DDJE",
          "KHJL" = EXCLUDED."KHJL",
          "JZR_XM" = EXCLUDED."JZR_XM",
          "JZR_ZJLX" = EXCLUDED."JZR_ZJLX",
          "JZR_ZJHM" = EXCLUDED."JZR_ZJHM",
          "JZR_XB" = EXCLUDED."JZR_XB",
          "JZR_NL" = EXCLUDED."JZR_NL",
          "JZR_LXDH" = EXCLUDED."JZR_LXDH",
          "JZR_JSMC" = EXCLUDED."JZR_JSMC",
          "JZR_JSGX" = EXCLUDED."JZR_JSGX",
          "JZR_JSLXFS" = EXCLUDED."JZR_JSLXFS",
          "JZR_JB" = EXCLUDED."JZR_JB",
          "JZR_BZ" = EXCLUDED."JZR_BZ",
          "H_NAME" = EXCLUDED."H_NAME",
          "H_ADDRESS" = EXCLUDED."H_ADDRESS",
          "H_KS" = EXCLUDED."H_KS",
          "H_YS" = EXCLUDED."H_YS",
          "DDFWBZ" = EXCLUDED."DDFWBZ",
          "BBQ_XQ" = EXCLUDED."BBQ_XQ",
          "DATE_XQ" = EXCLUDED."DATE_XQ",
          "BBQ_YD" = EXCLUDED."BBQ_YD",
          "DATE_YD" = EXCLUDED."DATE_YD",
          "BBQ_QDFW" = EXCLUDED."BBQ_QDFW",
          "DATE_QDFW" = EXCLUDED."DATE_QDFW",
          "BBQ_FK" = EXCLUDED."BBQ_FK",
          "DATE_FK" = EXCLUDED."DATE_FK",
          "BBQ_FW" = EXCLUDED."BBQ_FW",
          "DATE_FW" = EXCLUDED."DATE_FW",
          "PZR" = EXCLUDED."PZR",
          "PZXJ" = EXCLUDED."PZXJ",
          "YYQDLX" = EXCLUDED."YYQDLX",
          "BDYH" = EXCLUDED."BDYH",
          "registerAmount" = EXCLUDED."registerAmount",
          "isAdvancePay" = EXCLUDED."isAdvancePay",
          "advanceRegisterAmount" = EXCLUDED."advanceRegisterAmount",
          "registerPayStatus" = EXCLUDED."registerPayStatus",
          "refundCustAmount" = EXCLUDED."refundCustAmount",
          "medicare" = EXCLUDED."medicare",
          "medicareType" = EXCLUDED."medicareType",
          "isTaiKang" = EXCLUDED."isTaiKang",
          "expert_level" = EXCLUDED."expert_level",
          "lastQueuingTime" = EXCLUDED."lastQueuingTime",
          "xtsj_" = COALESCE("HY_FACT_DDCX_NEW"."xtsj_", EXCLUDED."xtsj_");
      `,
        orderNo,
        orderStatus,
        body.channel || null,
        body.channelOrderNo || null,
        body.backupOrderNo || null,
        body.channelDetail || null,
        body.channelContact || null,
        body.channelBackupContact || null,
        body.channelService || null,
        body.orderAmount ? parseFloat(body.orderAmount) || 0 : null,
        accountManager,
        patientName,
        body.documentType || null,
        body.documentNo || null,
        body.patientGender || null,
        body.patientAge ? parseInt(body.patientAge, 10) || null : null,
        body.patientPhone || null,
        body.familyName || null,
        body.familyRelation || null,
        body.familyPhone || null,
        body.disease || null,
        body.patientRequest || null,
        body.hospital || null,
        body.hospitalAddress || null,
        body.department || null,
        body.doctor || null,
        body.serviceRemark || null,
        reqTimeFormatted,
        extractDateOnly(body.requestTime) || body.requestDefaultDate || null,
        respTimeFormatted,
        extractDateOnly(body.responseTime || body.expectedBookingTime) || body.responseDefaultDate || null,
        srvStartTimeFormatted,
        extractDateOnly(body.serviceStartTime) || body.serviceStartDefaultDate || null,
        fkTimeFormatted,
        extractDateOnly(body.bookingFeedbackTime) || body.bookingFeedbackDefaultDate || null,
        null,
        null,
        body.escortName || null,
        body.escortSummary || null,
        body.bookingChannelType || null,
        body.bd || null,
        body.registrationFee ? parseFloat(body.registrationFee) || null : null,
        body.advancePayment || null,
        body.advanceRegistrationFee ? parseFloat(body.advanceRegistrationFee) || null : null,
        body.advanceRecovered || null,
        body.registrationRefund ? parseFloat(body.registrationRefund) || null : null,
        body.hasInsurance || null,
        body.insuranceType || null,
        body.isTaiKang || '0',
        body.expertLevel || null,
        lastQueueFormatted,
        nowStr
      )

      // 2. 更新陪诊人表 fact_hy_pzrxx
      if (Array.isArray(body.escortList)) {
        await prisma.$executeRawUnsafe(`DELETE FROM "fact_hy_pzrxx" WHERE "DDBH" = $1;`, orderNo)
        for (let i = 0; i < body.escortList.length; i++) {
          const item = body.escortList[i]
          if (item && item.escortName) {
            const seq = item.sequence || String(i + 1)
            const zj = `${orderNo}_${seq}`
            await prisma.$executeRawUnsafe(`
              INSERT INTO "fact_hy_pzrxx" ("DDBH", "PZR", "BBQ_FW", "ZJ", "xtsj")
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT ("ZJ") DO UPDATE SET
                "PZR" = EXCLUDED."PZR",
                "BBQ_FW" = EXCLUDED."BBQ_FW",
                "xtsj" = EXCLUDED."xtsj";
            `, orderNo, item.escortName, item.serviceDate || '', zj, nowStr)
          }
        }
      }

      // 3. 自建单原则：自建单不在 orders 表记录，绝对不查、不写、不碰 orders 表！
      // 只有在明确存在第三方外部 B 端渠道工单号（且不是自建单、非 HYYD 自身单号）时，才同步原 B 端工单镜像
      const channelOrderNoStr = String(body.channelOrderNo || '').trim()
      const isPureSelfOperated = body.source === 'huanyu' || 
        body.isSelfOperated === true ||
        !channelOrderNoStr ||
        channelOrderNoStr.startsWith('HYYD') ||
        (orderNo.startsWith('HYYD') && (!channelOrderNoStr || channelOrderNoStr === orderNo))

      let resolvedHospitalName = body.hospital || null
      if (body.hospital) {
        const hosp = await findHuanyuHospitalById(body.hospital).catch(() => null)
        if (hosp?.name) resolvedHospitalName = hosp.name
      }
      let resolvedDeptName = body.department || null
      if (body.department) {
        const d = await findHuanyuDepartmentById(body.department).catch(() => null)
        if (d?.name) resolvedDeptName = d.name
      }
      let resolvedDoctorName = body.doctor || null
      if (body.doctor) {
        const doc = await findHuanyuDoctorById(body.doctor).catch(() => null)
        if (doc?.name) resolvedDoctorName = doc.name
      }

      let syncedOrder: any = null
      if (!isPureSelfOperated && channelOrderNoStr) {
        const existingOrder = await prisma.order.findFirst({
          where: { sourceOrderNo: channelOrderNoStr }
        })
        if (existingOrder) {
          syncedOrder = await prisma.order.update({
            where: { id: existingOrder.id },
            data: {
              customerName: patientName || existingOrder.customerName,
              customerPhone: body.patientPhone || existingOrder.customerPhone,
              hospital: resolvedHospitalName || existingOrder.hospital,
              dept: resolvedDeptName || existingOrder.dept,
              doctor: resolvedDoctorName || existingOrder.doctor,
              status: orderStatus,
              rawJson: {
                ...(typeof existingOrder.rawJson === 'object' && existingOrder.rawJson ? existingOrder.rawJson : {}),
                ...orderRawBody,
                orderNo,
                DDBH: orderNo
              }
            }
          })

          await initializeOrderWorkflow(prisma, syncedOrder.id)

          // 用户保存时，只有实际采纳且值一致的 AI 候选才标为 adopted；手工改成其他值时不误标。
          const candidateValueByCode: Record<string, unknown> = {
            hospital: body.hospital,
            hospital_address: body.hospitalAddress,
            department: body.department,
            doctor: body.doctor,
            expert_level: body.expertLevel,
            service_remark: body.serviceRemark,
            appointment_time: body.responseTime,
            appointment_success_time: body.bookingFeedbackTime,
            service_start_time: body.serviceStartTime,
            latest_ticket_time: body.latestTicketTime || body.lastQueuingTime,
            registration_fee_amount: body.registrationFee,
            escort_service_summary: body.escortSummary,
            order_status: body.orderStatus
          }
          const pendingCandidates = await prisma.$queryRaw<Array<{ id: bigint; field_code: string; value_text: string }>>`
            SELECT id, field_code, value_text FROM b_order_ai_field_candidates
            WHERE order_id = ${syncedOrder.id} AND status = 'pending'
          `
          for (const candidate of pendingCandidates) {
            const saved = candidateValueByCode[candidate.field_code]
            if (typeof saved === 'string' && saved.trim() && saved.trim() === candidate.value_text.trim()) {
              await prisma.$executeRaw`
                UPDATE b_order_ai_field_candidates
                SET status = 'adopted', adopted_at = now(), adopted_by_employee_id = ${request.employee.id}
                WHERE id = ${candidate.id}
              `
            }
          }
        }
      }

      if (!syncedOrder) {
        // 自建寰宇订单：坚决不写、不碰 orders 表，直接构造返回对象
        syncedOrder = {
          id: `huanyu-${orderNo}`,
          source: 'huanyu',
          sourceOrderNo: '',
          huanyuOrderNo: orderNo,
          customerName: patientName,
          customerPhone: body.patientPhone || null,
          hospital: resolvedHospitalName,
          dept: resolvedDeptName,
          doctor: resolvedDoctorName,
          status: orderStatus,
          rawJson: { ...orderRawBody, orderNo, DDBH: orderNo }
        }
      }

      // 4. 触发远程 MySQL 核心主数据（医院、院区、对外科室、医生、陪诊人员）查重与自动建档
      void (async () => {
        try {
          await autoSyncOrderMasterData({
            hospitalName: resolvedHospitalName || body.hospital,
            hospitalAddress: body.hospitalAddress,
            departmentName: resolvedDeptName || body.department,
            doctorName: resolvedDoctorName || body.doctor,
            expertLevel: body.expertLevel,
            escortName: body.escortName,
            escortPhone: body.escortPhone || (Array.isArray(body.escortList) ? body.escortList[0]?.phone : null)
          })
          if (Array.isArray(body.escortList)) {
            for (const item of body.escortList) {
              if (item?.escortName && item?.phone) {
                await ensureRemoteEscort(item.escortName, item.phone)
              }
            }
          }
        } catch (syncErr) {
          fastify.log.warn({ err: syncErr }, '[master-data] 手工保存订单后触发主数据同步异常')
        }
      })()

      return reply.send({ ok: true, order: syncedOrder, message: '寰宇订单保存成功' })
    } catch (err: any) {
      fastify.log.error('保存寰宇订单失败:', err)
      return reply.status(500).send({ ok: false, error: '保存寰宇订单失败: ' + err.message })
    }
  })

  // 3.1.1 复制寰宇订单（仅复制三张寰宇业务表：HY_FACT_DDCX_NEW, fact_hy_pzrxx, hy_d_tp，更新单号，其余不动）
  fastify.post('/api/v1/orders/huanyu/copy', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const body = (request.body as any) || {}
    const sourceOrderNo = String(body.sourceOrderNo || '').trim()
    if (!sourceOrderNo) {
      return reply.status(400).send({ ok: false, error: '原订单编号不能为空' })
    }

    try {
      // 1. 查询原订单主表
      const existingRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM "HY_FACT_DDCX_NEW" WHERE "DDBH" = $1 LIMIT 1;`,
        sourceOrderNo
      )
      if (!existingRows || existingRows.length === 0) {
        return reply.status(404).send({ ok: false, error: `原寰宇订单 ${sourceOrderNo} 不存在` })
      }

      // 2. 生成全新不重复的寰宇单号
      let newOrderNo = ''
      for (let attempt = 0; attempt < 5; attempt++) {
        const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '')
        const rnd = Math.floor(10000000 + Math.random() * 90000000)
        const candidate = `HYYD${ymd}${rnd}`
        const dup = await prisma.$queryRawUnsafe<any[]>(
          `SELECT "DDBH" FROM "HY_FACT_DDCX_NEW" WHERE "DDBH" = $1 LIMIT 1;`,
          candidate
        )
        if (!dup || dup.length === 0) {
          newOrderNo = candidate
          break
        }
      }
      if (!newOrderNo) {
        return reply.status(500).send({ ok: false, error: '生成新订单号失败，请稍后重试' })
      }

      const nowStr = new Date().toISOString()

      // 3. 克隆主表 HY_FACT_DDCX_NEW
      const sourceOrder = { ...existingRows[0] }
      sourceOrder.DDBH = newOrderNo
      sourceOrder.xtsj_ = nowStr

      const mainCols = Object.keys(sourceOrder).map((k) => `"${k}"`).join(', ')
      const mainPlaceholders = Object.keys(sourceOrder).map((_, idx) => `$${idx + 1}`).join(', ')
      const mainVals = Object.values(sourceOrder)

      await prisma.$executeRawUnsafe(
        `INSERT INTO "HY_FACT_DDCX_NEW" (${mainCols}) VALUES (${mainPlaceholders});`,
        ...mainVals
      )

      // 4. 克隆陪诊人员表 fact_hy_pzrxx
      const pzrRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM "fact_hy_pzrxx" WHERE "DDBH" = $1 ORDER BY "ZJ" ASC;`,
        sourceOrderNo
      )
      if (pzrRows && pzrRows.length > 0) {
        for (let i = 0; i < pzrRows.length; i++) {
          const pzr = { ...pzrRows[i] }
          pzr.DDBH = newOrderNo
          let seq = String(i + 1)
          if (pzr.ZJ && typeof pzr.ZJ === 'string' && pzr.ZJ.includes('_')) {
            const parts = pzr.ZJ.split('_')
            seq = parts[parts.length - 1] || String(i + 1)
          }
          pzr.ZJ = `${newOrderNo}_${seq}`
          pzr.xtsj = nowStr

          const pzrCols = Object.keys(pzr).map((k) => `"${k}"`).join(', ')
          const pzrPlaceholders = Object.keys(pzr).map((_, idx) => `$${idx + 1}`).join(', ')
          const pzrVals = Object.values(pzr)

          await prisma.$executeRawUnsafe(
            `INSERT INTO "fact_hy_pzrxx" (${pzrCols}) VALUES (${pzrPlaceholders}) ON CONFLICT ("ZJ") DO UPDATE SET "PZR" = EXCLUDED."PZR", "BBQ_FW" = EXCLUDED."BBQ_FW", "xtsj" = EXCLUDED."xtsj";`,
            ...pzrVals
          )
        }
      }

      // 5. 克隆图片/附件表 hy_d_tp
      const tpRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM "hy_d_tp" WHERE "DDBH" = $1 LIMIT 1;`,
        sourceOrderNo
      )
      if (tpRows && tpRows.length > 0) {
        const tp = { ...tpRows[0] }
        tp.DDBH = newOrderNo
        const tpCols = Object.keys(tp).map((k) => `"${k}"`).join(', ')
        const tpPlaceholders = Object.keys(tp).map((_, idx) => `$${idx + 1}`).join(', ')
        const tpVals = Object.values(tp)

        await prisma.$executeRawUnsafe(
          `INSERT INTO "hy_d_tp" (${tpCols}) VALUES (${tpPlaceholders}) ON CONFLICT ("DDBH") DO NOTHING;`,
          ...tpVals
        )
      }

      // 构造前端友好的新订单包装对象，不碰 orders 表
      const newOrderView = {
        id: newOrderNo,
        source: 'huanyu',
        sourceOrderNo: newOrderNo,
        huanyuOrderNo: newOrderNo,
        customerName: sourceOrder.JZR_XM || '',
        customerPhone: sourceOrder.JZR_LXDH || '',
        hospital: sourceOrder.H_NAME || '',
        dept: sourceOrder.H_KS || '',
        doctor: sourceOrder.H_YS || '',
        status: sourceOrder.DD_state || '待跟进',
        rawJson: {
          ...sourceOrder,
          orderNo: newOrderNo,
          DDBH: newOrderNo
        }
      }

      return reply.send({
        ok: true,
        newOrderNo,
        order: newOrderView,
        message: `订单复制成功！新订单号：${newOrderNo}`
      })
    } catch (error: any) {
      request.log.error(error, `复制寰宇订单 ${sourceOrderNo} 失败`)
      return reply.status(500).send({
        ok: false,
        error: error?.message || '复制订单失败，请稍后重试'
      })
    }
  })

  // 3.2 人工确认推送寰宇订单。只把本地 PostgreSQL 三张寰宇表的已保存快照写入 MySQL，
  // 不会由抓单、AI 分析或定时任务自动调用。
  fastify.post<{ Params: { id: string } }>('/api/v1/orders/:id/huanyu/push', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const orderId = parseInt(request.params.id, 10)
    if (!Number.isFinite(orderId)) return reply.status(400).send({ error: '订单ID非法' })
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, source: true, sourceOrderNo: true, huanyuOrderNo: true, rawJson: true }
    })
    if (!order) return reply.status(404).send({ error: '订单不存在' })
    let ddbh = order.huanyuOrderNo
    if (!ddbh) {
      const rows = await prisma.$queryRaw<Array<{ DDBH: string }>>`
        SELECT "DDBH" FROM "HY_FACT_DDCX_NEW"
        WHERE "BDQD_DDBH" = ${order.sourceOrderNo} OR "DDBH" = ${order.sourceOrderNo}
        ORDER BY "xtsj_" DESC NULLS LAST LIMIT 1
      `
      ddbh = rows[0]?.DDBH ?? null
    }
    if (!ddbh) return reply.status(400).send({ error: '请先保存并创建本地寰宇订单后再推送' })
    try {
      const raw = (order.rawJson && typeof order.rawJson === 'object' && !Array.isArray(order.rawJson))
        ? order.rawJson as Record<string, unknown>
        : {}
      const isTaikangRegistrationAssistance = isTaikangRegistrationAssistanceOrder(order, raw)
      const result = await pushHuanyuOrderToMysql(prisma, ddbh, {
        excludeOrderUpdateColumns: isTaikangRegistrationAssistance
          ? REGISTRATION_ASSIST_REMOTE_AUTHORITATIVE_COLUMNS
          : []
      })
      await prisma.$executeRaw`
        INSERT INTO b_order_huanyu_push_logs (order_id, huanyu_order_no, status, message, pushed_by_employee_id)
        VALUES (${orderId}, ${ddbh}, 'succeeded', ${isTaikangRegistrationAssistance
          ? `已推送主订单、${result.escortCount} 条陪诊明细及附件快照；6 项挂号协助远端权威字段未覆盖`
          : `已推送主订单、${result.escortCount} 条陪诊明细及附件快照`}, ${request.employee.id})
      `
      return reply.send({ data: { ok: true, ddbh, escortCount: result.escortCount } })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MySQL 推送失败'
      await prisma.$executeRaw`
        INSERT INTO b_order_huanyu_push_logs (order_id, huanyu_order_no, status, message, pushed_by_employee_id)
        VALUES (${orderId}, ${ddbh}, 'failed', ${message.slice(0, 4000)}, ${request.employee.id})
      `.catch(() => undefined)
      fastify.log.error({ err: error, orderId, ddbh }, '推送寰宇订单到 MySQL 失败')
      return reply.status(500).send({ error: `推送寰宇订单失败：${message}` })
    }
  })

  // 挂号协助退款成功后使用：只把远端 MySQL 的六项权威字段回写到本地 PostgreSQL。
  // 退款接口不在本服务内，后续由其成功回调/前端成功分支调用本接口；绝不向远端写入退款字段。
  fastify.post<{ Params: { id: string } }>('/api/v1/orders/:id/huanyu/refresh-registration-assist-fields', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const orderId = parseInt(request.params.id, 10)
    if (!Number.isFinite(orderId)) return reply.status(400).send({ error: '订单ID非法' })

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, source: true, sourceOrderNo: true, huanyuOrderNo: true, rawJson: true }
    })
    if (!order) return reply.status(404).send({ error: '订单不存在' })
    const raw = (order.rawJson && typeof order.rawJson === 'object' && !Array.isArray(order.rawJson))
      ? order.rawJson as Record<string, unknown>
      : {}
    if (!isTaikangRegistrationAssistanceOrder(order, raw)) {
      return reply.status(400).send({ error: '仅泰康挂号协助订单可刷新挂号退款字段' })
    }

    let ddbh = order.huanyuOrderNo
    if (!ddbh) {
      const rows = await prisma.$queryRaw<Array<{ DDBH: string }>>`
        SELECT "DDBH" FROM "HY_FACT_DDCX_NEW"
        WHERE "BDQD_DDBH" = ${order.sourceOrderNo} OR "DDBH" = ${order.sourceOrderNo}
        ORDER BY "xtsj_" DESC NULLS LAST LIMIT 1
      `
      ddbh = rows[0]?.DDBH ?? null
    }
    if (!ddbh) return reply.status(404).send({ error: '尚未关联寰宇订单，无法刷新挂号退款字段' })

    try {
      const refreshed = await refreshRegistrationAssistFieldsFromMysql(prisma, String(ddbh))
      if (!refreshed) return reply.status(404).send({ error: '远端寰宇订单不存在，无法刷新挂号退款字段' })
      return reply.send({ data: { ok: true, ddbh: String(ddbh) } })
    } catch (error) {
      const message = error instanceof Error ? error.message : '远端 MySQL 查询失败'
      fastify.log.error({ err: error, orderId, ddbh }, '刷新挂号协助退款字段失败')
      return reply.status(500).send({ error: `刷新挂号退款字段失败：${message}` })
    }
  })

  // 泰康挂号协助退款：客户端只提交退款金额；ABI 鉴权及 appsecret 均留在后端。
  fastify.post<{ Params: { id: string }; Body: { refundAmount?: unknown } }>('/api/v1/orders/:id/huanyu/register-refund', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const orderId = parseInt(request.params.id, 10)
    if (!Number.isFinite(orderId)) return reply.status(400).send({ error: '订单ID非法' })
    const refundAmount = parseRefundAmount(request.body?.refundAmount)
    if (refundAmount == null) return reply.status(400).send({ error: '退款金额必须是大于 0 的数值，且最多保留两位小数' })

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, source: true, sourceOrderNo: true, huanyuOrderNo: true, rawJson: true }
    })
    if (!order) return reply.status(404).send({ error: '订单不存在' })
    const raw = (order.rawJson && typeof order.rawJson === 'object' && !Array.isArray(order.rawJson))
      ? order.rawJson as Record<string, unknown>
      : {}
    if (!isTaikangRegistrationAssistanceOrder(order, raw)) {
      return reply.status(400).send({ error: '仅泰康挂号协助订单可办理挂号退款' })
    }

    let ddbh = order.huanyuOrderNo
    if (!ddbh) {
      const rows = await prisma.$queryRaw<Array<{ DDBH: string }>>`
        SELECT "DDBH" FROM "HY_FACT_DDCX_NEW"
        WHERE "BDQD_DDBH" = ${order.sourceOrderNo} OR "DDBH" = ${order.sourceOrderNo}
        ORDER BY "xtsj_" DESC NULLS LAST LIMIT 1
      `
      ddbh = rows[0]?.DDBH ?? null
    }
    if (!ddbh) return reply.status(404).send({ error: '尚未关联寰宇订单，无法办理退款' })

    const huanyuRows = await prisma.$queryRaw<Array<{
      DDBH: string
      registerAmount: unknown
      advanceRegisterAmount: unknown
      aliPayTradeNo: unknown
    }>>`
      SELECT "DDBH", "registerAmount", "advanceRegisterAmount", "aliPayTradeNo"
      FROM "HY_FACT_DDCX_NEW" WHERE "DDBH" = ${String(ddbh)} LIMIT 1
    `
    const huanyuOrder = huanyuRows[0]
    if (!huanyuOrder) return reply.status(404).send({ error: '本地寰宇订单不存在，无法办理退款' })
    const advanceRegistrationFee = parseRefundAmount(huanyuOrder.advanceRegisterAmount)
    if (advanceRegistrationFee == null) {
      return reply.status(400).send({ error: '垫付挂号费金额未大于 0，不能办理退款' })
    }
    const registrationFee = parseRefundAmount(huanyuOrder.registerAmount)
    if (registrationFee == null) return reply.status(400).send({ error: '挂号费金额无效，不能办理退款' })
    if (refundAmount > registrationFee) {
      return reply.status(400).send({ error: `退款金额不能大于挂号费金额 ${registrationFee}` })
    }
    const aliTradeNo = typeof huanyuOrder.aliPayTradeNo === 'string' ? huanyuOrder.aliPayTradeNo.trim() : String(huanyuOrder.aliPayTradeNo ?? '').trim()
    if (!aliTradeNo) return reply.status(400).send({ error: '缺少支付宝支付账号，不能办理退款' })

    let refundResult
    try {
      refundResult = await requestAbiRefund({ orderNo: String(ddbh), aliTradeNo, refundAmount })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ABI 退款请求失败'
      fastify.log.warn({ orderId, ddbh, refundAmount, err: error }, 'ABI 挂号退款失败')
      return reply.status(502).send({ error: `退款失败：${message}` })
    }

    // ABI 已明确成功后才刷新；远端写入若有延迟，不改变已退款的结论，详情下次加载会再次尝试刷新。
    let refreshed = false
    try {
      refreshed = await refreshRegistrationAssistFieldsFromMysql(prisma, String(ddbh))
    } catch (error) {
      fastify.log.warn({ orderId, ddbh, err: error }, '退款成功后的挂号协助字段刷新失败')
    }
    return reply.send({ data: { ok: true, ddbh: String(ddbh), message: refundResult.message, refreshed } })
  })

function cleanHospitalName(val: unknown): string | null {
  if (typeof val !== 'string') return null
  const s = val.trim()
  if (!s || s === '-' || s === '--') return null
  if (/^\d+$/.test(s)) return null
  // 过滤形如 "江苏省-泰州市-泰兴市" 或以省/市/区/县结尾且不含医院关键词的地区字符串
  const isRegionFormat = /(?:省.*市|市.*区|市.*县)/.test(s) || /^[^-]+-[^-]+-[^-]+$/.test(s)
  const hasHospitalKeyword = /(?:医院|卫生院|诊所|中心|门诊部|妇幼|医学院)/.test(s)
  if (isRegionFormat && !hasHospitalKeyword) return null
  if (/(?:省|市|区|县)$/.test(s) && !hasHospitalKeyword) return null
  return s
}

function cleanDeptName(val: unknown): string | null {
  if (typeof val !== 'string') return null
  const s = val.trim()
  if (!s || s === '-' || s === '--') return null
  if (/^\d+$/.test(s)) return null
  return s
}

function cleanDoctorName(val: unknown): string | null {
  if (typeof val !== 'string') return null
  const s = val.trim()
  if (!s || s === '-' || s === '--') return null
  if (/^\d+$/.test(s)) return null
  return s
}

function isCancelledOrderText(status: string | null | undefined): boolean {
  return Boolean(status && (status.includes('已取消') || status.includes('无责取消') || status.includes('取消')))
}

let channelProductCache: {
  timestamp: number
  p72: Array<{ id: string; name: string; price: string }>
  p62: Array<{ id: string; name: string; price: string }>
} | null = null

async function getCachedChannelProducts() {
  const now = Date.now()
  if (channelProductCache && now - channelProductCache.timestamp < 5 * 60 * 1000) {
    return channelProductCache
  }
  try {
    const [p72, p62] = await Promise.all([
      listHuanyuChannelProducts('0072', ''),
      listHuanyuChannelProducts('0062', '')
    ])
    channelProductCache = { timestamp: now, p72, p62 }
    return channelProductCache
  } catch (err) {
    if (channelProductCache) return channelProductCache
    return { timestamp: now, p72: [], p62: [] }
  }
}

function calculateChannelProductPrice(
  products: Array<{ id: string; name: string; price: string }>,
  candidateNames: unknown[],
  isCancelled: boolean
): number | null {
  if (isCancelled) return 0
  const cleanCandidates = candidateNames
    .map((c) => (typeof c === 'string' ? c.trim() : ''))
    .filter(Boolean)
  if (cleanCandidates.length === 0) return null

  // 1. 精确匹配（ID 或 名称）
  for (const c of cleanCandidates) {
    const byId = products.find((p) => p.id === c)
    if (byId && byId.price && Number.isFinite(Number(byId.price))) return Number(byId.price)
    const byName = products.find((p) => p.name === c)
    if (byName && byName.price && Number.isFinite(Number(byName.price))) return Number(byName.price)
  }

  // 2. 常见业务类型关键词智能模糊匹配
  for (const c of cleanCandidates) {
    if (c.includes('挂号协助')) {
      const p = products.find((x) => x.name.includes('挂号协助（副高及以上）')) || products.find((x) => x.name.includes('挂号协助'))
      if (p && p.price && Number.isFinite(Number(p.price))) return Number(p.price)
    }
    if (c.includes('全程门诊') || c.includes('全程专家门诊')) {
      if (c.includes('点名')) {
        const p = products.find((x) => x.name === '全程门诊（点名）')
        if (p && p.price && Number.isFinite(Number(p.price))) return Number(p.price)
      }
      const p = products.find((x) => x.name === '全程门诊')
      if (p && p.price && Number.isFinite(Number(p.price))) return Number(p.price)
    }
    if (c.includes('单次门诊')) {
      if (c.includes('点名')) {
        const p = products.find((x) => x.name === '单次门诊（点名）')
        if (p && p.price && Number.isFinite(Number(p.price))) return Number(p.price)
      }
      const p = products.find((x) => x.name === '单次门诊')
      if (p && p.price && Number.isFinite(Number(p.price))) return Number(p.price)
    }
    if (c.includes('住院护工')) {
      const p = products.find((x) => x.name.includes('住院护工协助（15天）')) || products.find((x) => x.name.includes('住院护工协助'))
      if (p && p.price && Number.isFinite(Number(p.price))) return Number(p.price)
    }
    if (c.includes('住院') || c.includes('病房')) {
      const p = products.find((x) => x.name === '住院服务')
      if (p && p.price && Number.isFinite(Number(p.price))) return Number(p.price)
    }
    if (c.includes('电话问诊') || c.includes('问诊')) {
      const p = products.find((x) => x.name === '电话问诊')
      if (p && p.price && Number.isFinite(Number(p.price))) return Number(p.price)
    }
    if (c.includes('检查加急') || c.includes('加急')) {
      const p = products.find((x) => x.name.includes(c) || c.includes(x.name))
      if (p && p.price && Number.isFinite(Number(p.price))) return Number(p.price)
    }
    if (c.includes('就医交通') || c.includes('接送')) {
      const p = products.find((x) => x.name.includes('就医交通协助'))
      if (p && p.price && Number.isFinite(Number(p.price))) return Number(p.price)
    }
    const fuzzy = products.find((x) => x.name.includes(c) || c.includes(x.name))
    if (fuzzy && fuzzy.price && Number.isFinite(Number(fuzzy.price))) return Number(fuzzy.price)
  }
  return null
}

interface SelfOpQueryParams {
  captureEmployeeId: number | null
  query?: string
  status?: string
  lane?: string
  applicationNo?: string
  sourceOrderNo?: string
  huanyuOrderNo?: string
  serviceType?: string
  customerName?: string
  accountManager?: string
  hospital?: string
  dept?: string
  doctor?: string
  minAmount?: string | number
  maxAmount?: string | number
  startDate?: string
  endDate?: string
}

async function querySelfOperatedHuanyuOrders(prisma: PrismaClient, params: SelfOpQueryParams): Promise<any[]> {
  if (params.applicationNo && typeof params.applicationNo === 'string' && params.applicationNo.trim()) {
    return []
  }

  let employeeName: string | null = null
  if (params.captureEmployeeId) {
    const employee = await prisma.employee.findUnique({
      where: { id: params.captureEmployeeId },
      select: { name: true }
    })
    employeeName = employee?.name || null
  }

  try {
    const q = (params.query && typeof params.query === 'string') ? params.query.trim() : ''
    const docParam = (params.doctor && typeof params.doctor === 'string') ? params.doctor.trim() : ''
    const deptParam = (params.dept && typeof params.dept === 'string') ? params.dept.trim() : ''
    const hospParam = (params.hospital && typeof params.hospital === 'string') ? params.hospital.trim() : ''
    const prodParam = (params.serviceType && typeof params.serviceType === 'string') ? params.serviceType.trim() : ''

    const [
      qDocIds, qDeptIds, qHospIds, qProdIds,
      fDocIds, fDeptIds, fHospIds, fProdIds
    ] = await Promise.all([
      q ? findHuanyuDoctorIdsByName(q).catch(() => []) : Promise.resolve([]),
      q ? findHuanyuDepartmentIdsByName(q).catch(() => []) : Promise.resolve([]),
      q ? findHuanyuHospitalIdsByName(q).catch(() => []) : Promise.resolve([]),
      q ? findHuanyuProductIdsByName(q).catch(() => []) : Promise.resolve([]),
      docParam ? findHuanyuDoctorIdsByName(docParam).catch(() => []) : Promise.resolve([]),
      deptParam ? findHuanyuDepartmentIdsByName(deptParam).catch(() => []) : Promise.resolve([]),
      hospParam ? findHuanyuHospitalIdsByName(hospParam).catch(() => []) : Promise.resolve([]),
      prodParam ? findHuanyuProductIdsByName(prodParam).catch(() => []) : Promise.resolve([])
    ])

    const qDocIdSet = new Set(qDocIds)
    const qDeptIdSet = new Set(qDeptIds)
    const qHospIdSet = new Set(qHospIds)
    const qProdIdSet = new Set(qProdIds)
    const fDocIdSet = new Set(fDocIds)
    const fDeptIdSet = new Set(fDeptIds)
    const fHospIdSet = new Set(fHospIds)
    const fProdIdSet = new Set(fProdIds)

    const sqlConditions: Prisma.Sql[] = [
      Prisma.sql`"DDBH" LIKE 'HYYD%'`,
      Prisma.sql`("BDQD_DDBH" IS NULL OR "BDQD_DDBH" = '')`
    ]

    if (q) {
      const qConds: Prisma.Sql[] = [
        Prisma.sql`"JZR_XM" ILIKE ${'%' + q + '%'}`,
        Prisma.sql`"DDBH" ILIKE ${'%' + q + '%'}`,
        Prisma.sql`"KHJL" ILIKE ${'%' + q + '%'}`,
        Prisma.sql`"H_YS" ILIKE ${'%' + q + '%'}`,
        Prisma.sql`"H_KS" ILIKE ${'%' + q + '%'}`,
        Prisma.sql`"H_NAME" ILIKE ${'%' + q + '%'}`,
        Prisma.sql`"BDQD_FWXM" ILIKE ${'%' + q + '%'}`
      ]
      if (qDocIds.length > 0) qConds.push(Prisma.sql`"H_YS" IN (${Prisma.join(qDocIds)})`)
      if (qDeptIds.length > 0) qConds.push(Prisma.sql`"H_KS" IN (${Prisma.join(qDeptIds)})`)
      if (qHospIds.length > 0) qConds.push(Prisma.sql`"H_NAME" IN (${Prisma.join(qHospIds)})`)
      if (qProdIds.length > 0) qConds.push(Prisma.sql`"BDQD_FWXM" IN (${Prisma.join(qProdIds)})`)
      sqlConditions.push(Prisma.sql`(${Prisma.join(qConds, ' OR ')})`)
    }

    if (docParam) {
      const docConds: Prisma.Sql[] = [Prisma.sql`"H_YS" ILIKE ${'%' + docParam + '%'}`]
      if (fDocIds.length > 0) docConds.push(Prisma.sql`"H_YS" IN (${Prisma.join(fDocIds)})`)
      sqlConditions.push(Prisma.sql`(${Prisma.join(docConds, ' OR ')})`)
    }

    if (deptParam) {
      const deptConds: Prisma.Sql[] = [Prisma.sql`"H_KS" ILIKE ${'%' + deptParam + '%'}`]
      if (fDeptIds.length > 0) deptConds.push(Prisma.sql`"H_KS" IN (${Prisma.join(fDeptIds)})`)
      sqlConditions.push(Prisma.sql`(${Prisma.join(deptConds, ' OR ')})`)
    }

    if (hospParam) {
      const hospConds: Prisma.Sql[] = [Prisma.sql`"H_NAME" ILIKE ${'%' + hospParam + '%'}`]
      if (fHospIds.length > 0) hospConds.push(Prisma.sql`"H_NAME" IN (${Prisma.join(fHospIds)})`)
      sqlConditions.push(Prisma.sql`(${Prisma.join(hospConds, ' OR ')})`)
    }

    if (prodParam) {
      const prodConds: Prisma.Sql[] = [Prisma.sql`"BDQD_FWXM" ILIKE ${'%' + prodParam + '%'}`]
      if (fProdIds.length > 0) prodConds.push(Prisma.sql`"BDQD_FWXM" IN (${Prisma.join(fProdIds)})`)
      sqlConditions.push(Prisma.sql`(${Prisma.join(prodConds, ' OR ')})`)
    }

    if (params.customerName && typeof params.customerName === 'string' && params.customerName.trim()) {
      sqlConditions.push(Prisma.sql`"JZR_XM" ILIKE ${'%' + params.customerName.trim() + '%'}`)
    }
    if (params.huanyuOrderNo && typeof params.huanyuOrderNo === 'string' && params.huanyuOrderNo.trim()) {
      sqlConditions.push(Prisma.sql`"DDBH" ILIKE ${'%' + params.huanyuOrderNo.trim() + '%'}`)
    }
    if (params.accountManager && typeof params.accountManager === 'string' && params.accountManager.trim()) {
      sqlConditions.push(Prisma.sql`"KHJL" ILIKE ${'%' + params.accountManager.trim() + '%'}`)
    }
    if (params.startDate) {
      sqlConditions.push(Prisma.sql`"xtsj_" >= ${new Date(params.startDate)}`)
    }
    if (params.endDate) {
      const end = new Date(params.endDate)
      end.setHours(23, 59, 59, 999)
      sqlConditions.push(Prisma.sql`"xtsj_" <= ${end}`)
    }

    let selfOpRows = await prisma.$queryRaw<Array<any>>`
      SELECT *
      FROM "HY_FACT_DDCX_NEW"
      WHERE ${Prisma.join(sqlConditions, ' AND ')}
      ORDER BY "xtsj_" DESC NULLS LAST
      LIMIT 500
    `

    if (selfOpRows.length === 0) return []

    const bound = await prisma.order.findMany({
      where: {
        OR: [
          { huanyuOrderNo: { in: selfOpRows.map((r) => r.DDBH) } },
          { sourceOrderNo: { in: selfOpRows.map((r) => r.DDBH) } }
        ]
      },
      select: { huanyuOrderNo: true, sourceOrderNo: true }
    })
    const boundSet = new Set(bound.flatMap((b) => [b.huanyuOrderNo, b.sourceOrderNo]).filter((x): x is string => Boolean(x)))
    selfOpRows = selfOpRows.filter((r) => !boundSet.has(r.DDBH))

    if (params.accountManager && typeof params.accountManager === 'string' && params.accountManager.trim()) {
      const am = params.accountManager.trim().toLowerCase()
      selfOpRows = selfOpRows.filter((r) => (r.KHJL || '').toLowerCase().includes(am))
    } else if (employeeName) {
      selfOpRows = selfOpRows.filter((r) => !r.KHJL || r.KHJL === employeeName)
    }

    if (params.status && typeof params.status === 'string' && params.status.trim()) {
      const targetStatus = params.status.trim()
      selfOpRows = selfOpRows.filter((r) => (r.DD_state || '待跟进') === targetStatus)
    }

    if (params.huanyuOrderNo && typeof params.huanyuOrderNo === 'string' && params.huanyuOrderNo.trim()) {
      const hNo = params.huanyuOrderNo.trim().toLowerCase()
      selfOpRows = selfOpRows.filter((r) => (r.DDBH || '').toLowerCase().includes(hNo))
    }
    if (params.sourceOrderNo && typeof params.sourceOrderNo === 'string' && params.sourceOrderNo.trim()) {
      const sNo = params.sourceOrderNo.trim().toLowerCase()
      selfOpRows = selfOpRows.filter((r) => (r.DDBH || '').toLowerCase().includes(sNo))
    }

    if (params.customerName && typeof params.customerName === 'string' && params.customerName.trim()) {
      const cn = params.customerName.trim().toLowerCase()
      selfOpRows = selfOpRows.filter((r) => (r.JZR_XM || '').toLowerCase().includes(cn))
    }

    if (hospParam) {
      const h = hospParam.toLowerCase()
      selfOpRows = selfOpRows.filter((r) => {
        const val = (r.H_NAME || '').trim()
        return val.toLowerCase().includes(h) || fHospIdSet.has(val)
      })
    }
    if (deptParam) {
      const d = deptParam.toLowerCase()
      selfOpRows = selfOpRows.filter((r) => {
        const val = (r.H_KS || '').trim()
        return val.toLowerCase().includes(d) || fDeptIdSet.has(val)
      })
    }
    if (docParam) {
      const doc = docParam.toLowerCase()
      selfOpRows = selfOpRows.filter((r) => {
        const val = (r.H_YS || '').trim()
        return val.toLowerCase().includes(doc) || fDocIdSet.has(val)
      })
    }
    if (prodParam) {
      const st = prodParam.toLowerCase()
      selfOpRows = selfOpRows.filter((r) => {
        const val = (r.BDQD_FWXM || '').trim()
        return val.toLowerCase().includes(st) || fProdIdSet.has(val)
      })
    }

    if (params.minAmount !== undefined && params.minAmount !== '') {
      const min = Number(params.minAmount)
      if (Number.isFinite(min)) {
        selfOpRows = selfOpRows.filter((r) => r.DDJE != null && Number(r.DDJE) >= min)
      }
    }
    if (params.maxAmount !== undefined && params.maxAmount !== '') {
      const max = Number(params.maxAmount)
      if (Number.isFinite(max)) {
        selfOpRows = selfOpRows.filter((r) => r.DDJE != null && Number(r.DDJE) <= max)
      }
    }

    if (params.startDate) {
      const startTs = new Date(params.startDate).getTime()
      selfOpRows = selfOpRows.filter((r) => r.xtsj_ && new Date(r.xtsj_).getTime() >= startTs)
    }
    if (params.endDate) {
      const end = new Date(params.endDate)
      end.setHours(23, 59, 59, 999)
      const endTs = end.getTime()
      selfOpRows = selfOpRows.filter((r) => r.xtsj_ && new Date(r.xtsj_).getTime() <= endTs)
    }

    if (q) {
      const qLower = q.toLowerCase()
      selfOpRows = selfOpRows.filter((r) => {
        const jzr = (r.JZR_XM || '').toLowerCase()
        const name = (r.H_NAME || '').trim()
        const ks = (r.H_KS || '').trim()
        const ys = (r.H_YS || '').trim()
        const khjl = (r.KHJL || '').toLowerCase()
        const ddbh = (r.DDBH || '').toLowerCase()
        const fwxm = (r.BDQD_FWXM || '').trim()

        return (
          jzr.includes(qLower) ||
          ddbh.includes(qLower) ||
          khjl.includes(qLower) ||
          name.toLowerCase().includes(qLower) || qHospIdSet.has(name) ||
          ks.toLowerCase().includes(qLower) || qDeptIdSet.has(ks) ||
          ys.toLowerCase().includes(qLower) || qDocIdSet.has(ys) ||
          fwxm.toLowerCase().includes(qLower) || qProdIdSet.has(fwxm)
        )
      })
    }

    const allSelfOpFwxm = selfOpRows.map(r => r.BDQD_FWXM).filter((x): x is string => Boolean(x && x.trim()))
    const selfOpProductMap = await findHuanyuChannelProductsByIds(allSelfOpFwxm)

    const result: any[] = []
    for (const row of selfOpRows) {
      let dept = cleanDeptName(row.H_KS) ?? null
      if (row.H_KS && (/^\d+$/.test(row.H_KS.trim()) || !dept)) {
        const dObj = await findHuanyuDepartmentById(row.H_KS).catch(() => null)
        if (dObj?.name) dept = dObj.name
      }
      let doctor = cleanDoctorName(row.H_YS) ?? null
      if (row.H_YS && (/^\d+$/.test(row.H_YS.trim()) || !doctor)) {
        const docObj = await findHuanyuDoctorById(row.H_YS).catch(() => null)
        if (docObj?.name) doctor = docObj.name
      }
      let hospital = cleanHospitalName(row.H_NAME) ?? null
      if (row.H_NAME && (/^\d+$/.test(row.H_NAME.trim()) || !hospital)) {
        const hObj = await findHuanyuHospitalById(row.H_NAME).catch(() => null)
        if (hObj?.name) hospital = hObj.name
      }

      const amount = row.DDJE != null && Number.isFinite(Number(row.DDJE)) && Number(row.DDJE) > 0 ? Number(row.DDJE) : null
      const status = row.DD_state || '待跟进'
      const workbenchLane = deriveWorkbenchLane(status)
      const serviceStage = deriveServiceStage(workbenchLane)

      if (params.lane && params.lane !== 'all' && workbenchLane !== params.lane) {
        continue
      }

      const matchedSelfProd = row.BDQD_FWXM ? selfOpProductMap.get(row.BDQD_FWXM.trim()) : null
      const resolvedSelfServiceName = matchedSelfProd?.name || (row.BDQD_FWXM && !/^\d+$/.test(row.BDQD_FWXM.trim()) ? row.BDQD_FWXM : null)

      result.push({
        id: `huanyu-${row.DDBH}`,
        source: 'huanyu',
        sourceOrderNo: '',
        bOrderNo: null,
        huanyuOrderNo: row.DDBH,
        customerName: row.JZR_XM || '',
        customerPhone: row.JZR_LXDH || null,
        hospital,
        dept,
        doctor,
        status,
        orderState: null,
        rawJson: { ...row, orderNo: row.DDBH, DDBH: row.DDBH, patientName: row.JZR_XM, patientPhone: row.JZR_LXDH },
        assignedEmployee: employeeName ? { id: params.captureEmployeeId!, name: employeeName } : null,
        createdAt: row.xtsj_ || new Date().toISOString(),
        updatedAt: row.xtsj_ || new Date().toISOString(),
        huanyuOrderStatus: status,
        taikangOrderState: null,
        taikangOrderStateName: null,
        taikangCaseStatus: null,
        taikangWaitType: null,
        taikangServState: null,
        workbenchLane,
        serviceStage,
        accountManager: row.KHJL || employeeName || null,
        orderAmount: amount,
        serviceType: resolvedSelfServiceName,
        huanyuOrders: [{
          id: row.DDBH,
          ddbh: row.DDBH,
          huanyuOrderNo: row.DDBH,
          bOrderNo: null,
          isClone: false,
          sequence: 1,
          status,
          serviceName: resolvedSelfServiceName,
          amount,
          accountManager: row.KHJL || employeeName || null,
          hospital: hospital || '',
          dept: dept || '',
          doctor: doctor || '',
          patientName: row.JZR_XM || null,
          createdAt: row.xtsj_ || new Date().toISOString()
        }],
        isAiHospital: false,
        isAiDept: false,
        isAiDoctor: false,
        intendDate: null,
        intendDateAmorpm: null,
        claimedAt: row.xtsj_ || new Date().toISOString(),
        audioCount: 0,
        textCount: 0,
        imageCount: 0,
        materialCount: 0,
        lastMaterialAt: null
      })
    }
    return result
  } catch (err: any) {
    return []
  }
}

  // 4. 查询订单 GET /api/v1/orders
  fastify.get<{
    Querystring: {
      source?: string
      status?: string
      pool?: string
      assignedEmployeeId?: string
      assignedEmployeeCode?: string
      page?: string | number
      pageSize?: string | number
      query?: string
      sortKey?: string
      sortDir?: 'asc' | 'desc'
      applicationNo?: string
      sourceOrderNo?: string
      huanyuOrderNo?: string
      serviceType?: string
      customerName?: string
      accountManager?: string
      hospital?: string
      dept?: string
      doctor?: string
      minAmount?: string | number
      maxAmount?: string | number
      startDate?: string
      endDate?: string
    }
  }>(
    '/api/v1/orders',
    async (request, reply) => {
      const {
        source,
        status,
        pool,
        assignedEmployeeId,
        assignedEmployeeCode,
        page,
        pageSize,
        query,
        sortKey,
        sortDir,
        applicationNo,
        sourceOrderNo,
        huanyuOrderNo,
        serviceType,
        customerName,
        accountManager,
        hospital,
        dept,
        doctor,
        startDate,
        endDate
      } = request.query

      const where: any = {}
      let captureEmployeeId: number | null = null
      if (source) where.source = source
      if (pool) where.rawJson = { path: ['pool'], equals: pool }
      if (assignedEmployeeId) {
        captureEmployeeId = parseInt(assignedEmployeeId, 10)
        where.assignedEmployeeId = captureEmployeeId
      } else if (assignedEmployeeCode) {
        const employee = await ensureEmployeeByCode(prisma, assignedEmployeeCode)
        captureEmployeeId = employee.id
        where.assignedEmployeeId = employee.id
      } else if (pool !== 'public') {
        if (!request.employee) return reply.status(401).send({ error: '未登录' })
        captureEmployeeId = request.employee.id
        where.assignedEmployeeId = request.employee.id
      }

      const andConditions: any[] = []

      // 0. 状态筛选 (支持主表状态、事实表 DD_state 穿透、候选/待跟进映射)
      if (status && typeof status === 'string' && status.trim()) {
        const st = status.trim()
        let factKeysByStatus: string[] = []
        try {
          const matched = await prisma.$queryRaw<Array<{ DDBH: string; BDQD_DDBH: string | null }>>`
            SELECT "DDBH", "BDQD_DDBH"
            FROM "HY_FACT_DDCX_NEW"
            WHERE "DD_state" = ${st}
            LIMIT 500
          `
          factKeysByStatus = Array.from(new Set(matched.flatMap(m => [m.DDBH, m.BDQD_DDBH].filter((k): k is string => Boolean(k)))))
        } catch {}

        andConditions.push({
          OR: [
            { status: st },
            ...(st === '待跟进' ? [{ status: '候选' }] : []),
            ...(factKeysByStatus.length > 0
              ? [{ sourceOrderNo: { in: factKeysByStatus } }, { huanyuOrderNo: { in: factKeysByStatus } }]
              : [])
          ]
        })
      }

      // 1. 全局模糊搜索 (query) - 完全覆盖列表展示的全部源头
      if (query && typeof query === 'string' && query.trim()) {
        const q = query.trim()
        const [docIds, deptIds, hospIds, prodIds] = await Promise.all([
          findHuanyuDoctorIdsByName(q).catch(() => []),
          findHuanyuDepartmentIdsByName(q).catch(() => []),
          findHuanyuHospitalIdsByName(q).catch(() => []),
          findHuanyuProductIdsByName(q).catch(() => [])
        ])

        let factMatchedKeys: string[] = []
        try {
          const factConditions: Prisma.Sql[] = [
            Prisma.sql`"JZR_XM" ILIKE ${'%' + q + '%'}`,
            Prisma.sql`"DDBH" ILIKE ${'%' + q + '%'}`,
            Prisma.sql`"BDQD_DDBH" ILIKE ${'%' + q + '%'}`,
            Prisma.sql`"KHJL" ILIKE ${'%' + q + '%'}`,
            Prisma.sql`"H_YS" ILIKE ${'%' + q + '%'}`,
            Prisma.sql`"H_KS" ILIKE ${'%' + q + '%'}`,
            Prisma.sql`"H_NAME" ILIKE ${'%' + q + '%'}`,
            Prisma.sql`"BDQD_FWXM" ILIKE ${'%' + q + '%'}`
          ]
          if (docIds.length > 0) factConditions.push(Prisma.sql`"H_YS" IN (${Prisma.join(docIds)})`)
          if (deptIds.length > 0) factConditions.push(Prisma.sql`"H_KS" IN (${Prisma.join(deptIds)})`)
          if (hospIds.length > 0) factConditions.push(Prisma.sql`"H_NAME" IN (${Prisma.join(hospIds)})`)
          if (prodIds.length > 0) factConditions.push(Prisma.sql`"BDQD_FWXM" IN (${Prisma.join(prodIds)})`)

          const matchedFacts = await prisma.$queryRaw<Array<{ DDBH: string; BDQD_DDBH: string | null }>>`
            SELECT "DDBH", "BDQD_DDBH"
            FROM "HY_FACT_DDCX_NEW"
            WHERE ${Prisma.join(factConditions, ' OR ')}
            LIMIT 500
          `
          factMatchedKeys = Array.from(
            new Set(matchedFacts.flatMap((f) => [f.DDBH, f.BDQD_DDBH].filter((k): k is string => Boolean(k))))
          )
        } catch {
          // ignore fact query failure
        }

        let aiMatchedOrderIds: number[] = []
        try {
          const aiRows = await prisma.$queryRaw<Array<{ order_id: number }>>`
            SELECT DISTINCT order_id FROM b_order_ai_field_candidates
            WHERE value_text ILIKE ${'%' + q + '%'}
            LIMIT 200
          `
          aiMatchedOrderIds = aiRows.map(r => r.order_id)
        } catch {}

        andConditions.push({
          OR: [
            // 姓名
            { customerName: { contains: q, mode: 'insensitive' } },
            { rawJson: { path: ['patientName'], string_contains: q } },
            { rawJson: { path: ['paName'], string_contains: q } },
            { rawJson: { path: ['trueName'], string_contains: q } },
            { rawJson: { path: ['insurName'], string_contains: q } },
            { detailJson: { path: ['recommendations', 'patientName'], string_contains: q } },
            { detailJson: { path: ['recommendations', 'insurName'], string_contains: q } },
            // 手机号
            { customerPhone: { contains: q } },
            { rawJson: { path: ['paMobile'], string_contains: q } },
            { rawJson: { path: ['patientPhone'], string_contains: q } },
            { detailJson: { path: ['recommendations', 'paMobile'], string_contains: q } },
            { detailJson: { path: ['recommendations', 'ecpPhone'], string_contains: q } },
            // 医院
            { hospital: { contains: q, mode: 'insensitive' } },
            { rawJson: { path: ['hospital'], string_contains: q } },
            { rawJson: { path: ['intendHos'], string_contains: q } },
            { rawJson: { path: ['clinicHos'], string_contains: q } },
            { rawJson: { path: ['visitingHospital'], string_contains: q } },
            { detailJson: { path: ['recommendations', 'intendHos'], string_contains: q } },
            { detailJson: { path: ['recommendations', 'visitingHospital'], string_contains: q } },
            { aiBriefJson: { path: ['keyInfo', '目标医院'], string_contains: q } },
            // 科室
            { dept: { contains: q, mode: 'insensitive' } },
            { rawJson: { path: ['dept'], string_contains: q } },
            { detailJson: { path: ['recommendations', 'intendDept'], string_contains: q } },
            { aiBriefJson: { path: ['keyInfo', '科室或病种'], string_contains: q } },
            // 医生
            { doctor: { contains: q, mode: 'insensitive' } },
            { rawJson: { path: ['doctor'], string_contains: q } },
            { detailJson: { path: ['recommendations', 'intendDoc'], string_contains: q } },
            { aiBriefJson: { path: ['keyInfo', '意向专家'], string_contains: q } },
            // 单号
            { sourceOrderNo: { contains: q, mode: 'insensitive' } },
            { huanyuOrderNo: { contains: q, mode: 'insensitive' } },
            { rawJson: { path: ['sourceOrderNo'], string_contains: q } },
            { rawJson: { path: ['channelOrderNo'], string_contains: q } },
            { rawJson: { path: ['bOrderNo'], string_contains: q } },
            { rawJson: { path: ['bChannelOrderNo'], string_contains: q } },
            { rawJson: { path: ['subOrderNo'], string_contains: q } },
            { detailJson: { path: ['recommendations', 'subOrderNo'], string_contains: q } },
            { rawJson: { path: ['crmApplyNo'], string_contains: q } },
            { rawJson: { path: ['applyNo'], string_contains: q } },
            { detailJson: { path: ['recommendations', 'crmApplyNo'], string_contains: q } },
            { detailJson: { path: ['recommendations', 'applyNo'], string_contains: q } },
            // 业务类型
            { rawJson: { path: ['itemName'], string_contains: q } },
            { rawJson: { path: ['serviceType'], string_contains: q } },
            { rawJson: { path: ['serviceName'], string_contains: q } },
            { rawJson: { path: ['serviceItemName'], string_contains: q } },
            { detailJson: { path: ['recommendations', 'itemName'], string_contains: q } },
            { detailJson: { path: ['recommendations', 'serviceName'], string_contains: q } },
            { detailJson: { path: ['recommendations', 'subPlanName'], string_contains: q } },
            // 客户经理
            { assignedEmployee: { name: { contains: q, mode: 'insensitive' } } },
            { rawJson: { path: ['accountManager'], string_contains: q } },
            { rawJson: { path: ['cmgrName'], string_contains: q } },
            { rawJson: { path: ['mmgrName'], string_contains: q } },
            // 维表与事实表穿透与AI候选词
            ...(docIds.length > 0 ? [{ doctor: { in: docIds } }] : []),
            ...(deptIds.length > 0 ? [{ dept: { in: deptIds } }] : []),
            ...(hospIds.length > 0 ? [{ hospital: { in: hospIds } }] : []),
            ...(factMatchedKeys.length > 0
              ? [{ sourceOrderNo: { in: factMatchedKeys } }, { huanyuOrderNo: { in: factMatchedKeys } }]
              : []),
            ...(aiMatchedOrderIds.length > 0 ? [{ id: { in: aiMatchedOrderIds } }] : [])
          ]
        })
      }

      // 2. 高级筛选 - 申请号
      if (applicationNo && typeof applicationNo === 'string' && applicationNo.trim()) {
        const appQ = applicationNo.trim()
        andConditions.push({
          OR: [
            { rawJson: { path: ['crmApplyNo'], string_contains: appQ } },
            { rawJson: { path: ['applyNo'], string_contains: appQ } },
            { detailJson: { path: ['recommendations', 'crmApplyNo'], string_contains: appQ } },
            { detailJson: { path: ['recommendations', 'applyNo'], string_contains: appQ } }
          ]
        })
      }

      // 3. 高级筛选 - B端订单号
      if (sourceOrderNo && typeof sourceOrderNo === 'string' && sourceOrderNo.trim()) {
        const sNo = sourceOrderNo.trim()
        let factKeysBySourceNo: string[] = []
        try {
          const matched = await prisma.$queryRaw<Array<{ DDBH: string; BDQD_DDBH: string | null }>>`
            SELECT "DDBH", "BDQD_DDBH"
            FROM "HY_FACT_DDCX_NEW"
            WHERE "BDQD_DDBH" ILIKE ${'%' + sNo + '%'}
            LIMIT 200
          `
          factKeysBySourceNo = Array.from(new Set(matched.flatMap(m => [m.DDBH, m.BDQD_DDBH].filter((k): k is string => Boolean(k)))))
        } catch {}

        andConditions.push({
          OR: [
            { sourceOrderNo: { contains: sNo, mode: 'insensitive' } },
            { rawJson: { path: ['sourceOrderNo'], string_contains: sNo } },
            { rawJson: { path: ['channelOrderNo'], string_contains: sNo } },
            { rawJson: { path: ['bOrderNo'], string_contains: sNo } },
            { rawJson: { path: ['bChannelOrderNo'], string_contains: sNo } },
            { rawJson: { path: ['subOrderNo'], string_contains: sNo } },
            { detailJson: { path: ['recommendations', 'subOrderNo'], string_contains: sNo } },
            ...(factKeysBySourceNo.length > 0 ? [{ sourceOrderNo: { in: factKeysBySourceNo } }, { huanyuOrderNo: { in: factKeysBySourceNo } }] : [])
          ]
        })
      }

      // 4. 高级筛选 - 寰宇订单号 (覆盖主表、自建单号与事实表)
      if (huanyuOrderNo && typeof huanyuOrderNo === 'string' && huanyuOrderNo.trim()) {
        const hNo = huanyuOrderNo.trim()
        let factKeysByHuanyuNo: string[] = []
        try {
          const matched = await prisma.$queryRaw<Array<{ DDBH: string; BDQD_DDBH: string | null }>>`
            SELECT "DDBH", "BDQD_DDBH"
            FROM "HY_FACT_DDCX_NEW"
            WHERE "DDBH" ILIKE ${'%' + hNo + '%'}
            LIMIT 200
          `
          factKeysByHuanyuNo = Array.from(new Set(matched.flatMap(m => [m.DDBH, m.BDQD_DDBH].filter((k): k is string => Boolean(k)))))
        } catch {}

        andConditions.push({
          OR: [
            { huanyuOrderNo: { contains: hNo, mode: 'insensitive' } },
            { sourceOrderNo: { contains: hNo, mode: 'insensitive' } },
            ...(factKeysByHuanyuNo.length > 0 ? [{ sourceOrderNo: { in: factKeysByHuanyuNo } }, { huanyuOrderNo: { in: factKeysByHuanyuNo } }] : [])
          ]
        })
      }

      // 5. 高级筛选 - 客户姓名 (带事实表联动与 recommendations 覆盖)
      if (customerName && typeof customerName === 'string' && customerName.trim()) {
        const cName = customerName.trim()
        let factKeysByCustomer: string[] = []
        try {
          const matched = await prisma.$queryRaw<Array<{ DDBH: string; BDQD_DDBH: string | null }>>`
            SELECT "DDBH", "BDQD_DDBH"
            FROM "HY_FACT_DDCX_NEW"
            WHERE "JZR_XM" ILIKE ${'%' + cName + '%'}
            LIMIT 200
          `
          factKeysByCustomer = Array.from(new Set(matched.flatMap(m => [m.DDBH, m.BDQD_DDBH].filter((k): k is string => Boolean(k)))))
        } catch {}

        andConditions.push({
          OR: [
            { customerName: { contains: cName, mode: 'insensitive' } },
            { rawJson: { path: ['patientName'], string_contains: cName } },
            { rawJson: { path: ['paName'], string_contains: cName } },
            { rawJson: { path: ['trueName'], string_contains: cName } },
            { rawJson: { path: ['insurName'], string_contains: cName } },
            { detailJson: { path: ['recommendations', 'patientName'], string_contains: cName } },
            { detailJson: { path: ['recommendations', 'insurName'], string_contains: cName } },
            ...(factKeysByCustomer.length > 0 ? [{ sourceOrderNo: { in: factKeysByCustomer } }, { huanyuOrderNo: { in: factKeysByCustomer } }] : [])
          ]
        })
      }

      // 6. 高级筛选 - 医院 (覆盖主表、rawJson、recommendations、AI 提取与事实/维表穿透)
      if (hospital && typeof hospital === 'string' && hospital.trim()) {
        const hName = hospital.trim()
        const hIds = await findHuanyuHospitalIdsByName(hName).catch(() => [])
        let factKeysByHosp: string[] = []
        try {
          const hospConds: Prisma.Sql[] = [Prisma.sql`"H_NAME" ILIKE ${'%' + hName + '%'}`]
          if (hIds.length > 0) hospConds.push(Prisma.sql`"H_NAME" IN (${Prisma.join(hIds)})`)
          const matched = await prisma.$queryRaw<Array<{ DDBH: string; BDQD_DDBH: string | null }>>`
            SELECT "DDBH", "BDQD_DDBH"
            FROM "HY_FACT_DDCX_NEW"
            WHERE ${Prisma.join(hospConds, ' OR ')}
            LIMIT 200
          `
          factKeysByHosp = Array.from(new Set(matched.flatMap(m => [m.DDBH, m.BDQD_DDBH].filter((k): k is string => Boolean(k)))))
        } catch {}

        let aiMatchedOrderIds: number[] = []
        try {
          const aiRows = await prisma.$queryRaw<Array<{ order_id: number }>>`
            SELECT DISTINCT order_id FROM b_order_ai_field_candidates
            WHERE field_code = 'hospital' AND value_text ILIKE ${'%' + hName + '%'}
            LIMIT 200
          `
          aiMatchedOrderIds = aiRows.map(r => r.order_id)
        } catch {}

        andConditions.push({
          OR: [
            { hospital: { contains: hName, mode: 'insensitive' } },
            { rawJson: { path: ['hospital'], string_contains: hName } },
            { rawJson: { path: ['intendHos'], string_contains: hName } },
            { rawJson: { path: ['clinicHos'], string_contains: hName } },
            { rawJson: { path: ['visitingHospital'], string_contains: hName } },
            { detailJson: { path: ['recommendations', 'intendHos'], string_contains: hName } },
            { detailJson: { path: ['recommendations', 'visitingHospital'], string_contains: hName } },
            { aiBriefJson: { path: ['keyInfo', '目标医院'], string_contains: hName } },
            ...(hIds.length > 0 ? [{ hospital: { in: hIds } }] : []),
            ...(factKeysByHosp.length > 0 ? [{ sourceOrderNo: { in: factKeysByHosp } }, { huanyuOrderNo: { in: factKeysByHosp } }] : []),
            ...(aiMatchedOrderIds.length > 0 ? [{ id: { in: aiMatchedOrderIds } }] : [])
          ]
        })
      }

      // 7. 高级筛选 - 科室 (覆盖主表、rawJson、recommendations.intendDept、AI 提取与事实/维表穿透)
      if (dept && typeof dept === 'string' && dept.trim()) {
        const dName = dept.trim()
        const dIds = await findHuanyuDepartmentIdsByName(dName).catch(() => [])
        let factKeysByDept: string[] = []
        try {
          const deptConds: Prisma.Sql[] = [Prisma.sql`"H_KS" ILIKE ${'%' + dName + '%'}`]
          if (dIds.length > 0) deptConds.push(Prisma.sql`"H_KS" IN (${Prisma.join(dIds)})`)
          const matched = await prisma.$queryRaw<Array<{ DDBH: string; BDQD_DDBH: string | null }>>`
            SELECT "DDBH", "BDQD_DDBH"
            FROM "HY_FACT_DDCX_NEW"
            WHERE ${Prisma.join(deptConds, ' OR ')}
            LIMIT 200
          `
          factKeysByDept = Array.from(new Set(matched.flatMap(m => [m.DDBH, m.BDQD_DDBH].filter((k): k is string => Boolean(k)))))
        } catch {}

        let aiMatchedOrderIds: number[] = []
        try {
          const aiRows = await prisma.$queryRaw<Array<{ order_id: number }>>`
            SELECT DISTINCT order_id FROM b_order_ai_field_candidates
            WHERE field_code = 'department' AND value_text ILIKE ${'%' + dName + '%'}
            LIMIT 200
          `
          aiMatchedOrderIds = aiRows.map(r => r.order_id)
        } catch {}

        andConditions.push({
          OR: [
            { dept: { contains: dName, mode: 'insensitive' } },
            { rawJson: { path: ['dept'], string_contains: dName } },
            { detailJson: { path: ['recommendations', 'intendDept'], string_contains: dName } },
            { aiBriefJson: { path: ['keyInfo', '科室或病种'], string_contains: dName } },
            ...(dIds.length > 0 ? [{ dept: { in: dIds } }] : []),
            ...(factKeysByDept.length > 0 ? [{ sourceOrderNo: { in: factKeysByDept } }, { huanyuOrderNo: { in: factKeysByDept } }] : []),
            ...(aiMatchedOrderIds.length > 0 ? [{ id: { in: aiMatchedOrderIds } }] : [])
          ]
        })
      }

      // 8. 高级筛选 - 医生 (覆盖主表、rawJson、recommendations.intendDoc、AI 提取与事实/维表穿透)
      if (doctor && typeof doctor === 'string' && doctor.trim()) {
        const docName = doctor.trim()
        const docIds = await findHuanyuDoctorIdsByName(docName).catch(() => [])
        let factKeysByDoc: string[] = []
        try {
          const docConds: Prisma.Sql[] = [Prisma.sql`"H_YS" ILIKE ${'%' + docName + '%'}`]
          if (docIds.length > 0) docConds.push(Prisma.sql`"H_YS" IN (${Prisma.join(docIds)})`)
          const matched = await prisma.$queryRaw<Array<{ DDBH: string; BDQD_DDBH: string | null }>>`
            SELECT "DDBH", "BDQD_DDBH"
            FROM "HY_FACT_DDCX_NEW"
            WHERE ${Prisma.join(docConds, ' OR ')}
            LIMIT 200
          `
          factKeysByDoc = Array.from(new Set(matched.flatMap(m => [m.DDBH, m.BDQD_DDBH].filter((k): k is string => Boolean(k)))))
        } catch {}

        let aiMatchedOrderIds: number[] = []
        try {
          const aiRows = await prisma.$queryRaw<Array<{ order_id: number }>>`
            SELECT DISTINCT order_id FROM b_order_ai_field_candidates
            WHERE field_code = 'doctor' AND value_text ILIKE ${'%' + docName + '%'}
            LIMIT 200
          `
          aiMatchedOrderIds = aiRows.map(r => r.order_id)
        } catch {}

        andConditions.push({
          OR: [
            { doctor: { contains: docName, mode: 'insensitive' } },
            { rawJson: { path: ['doctor'], string_contains: docName } },
            { detailJson: { path: ['recommendations', 'intendDoc'], string_contains: docName } },
            { aiBriefJson: { path: ['keyInfo', '意向专家'], string_contains: docName } },
            ...(docIds.length > 0 ? [{ doctor: { in: docIds } }] : []),
            ...(factKeysByDoc.length > 0 ? [{ sourceOrderNo: { in: factKeysByDoc } }, { huanyuOrderNo: { in: factKeysByDoc } }] : []),
            ...(aiMatchedOrderIds.length > 0 ? [{ id: { in: aiMatchedOrderIds } }] : [])
          ]
        })
      }

      // 9. 高级筛选 - 业务类型 (覆盖 rawJson、recommendations、挂号协助与事实表穿透)
      if (serviceType && typeof serviceType === 'string' && serviceType.trim()) {
        const sType = serviceType.trim()
        const prodIds = await findHuanyuProductIdsByName(sType).catch(() => [])
        let factKeysByProd: string[] = []
        try {
          const prodConds: Prisma.Sql[] = [Prisma.sql`"BDQD_FWXM" ILIKE ${'%' + sType + '%'}`]
          if (prodIds.length > 0) prodConds.push(Prisma.sql`"BDQD_FWXM" IN (${Prisma.join(prodIds)})`)
          const matched = await prisma.$queryRaw<Array<{ DDBH: string; BDQD_DDBH: string | null }>>`
            SELECT "DDBH", "BDQD_DDBH"
            FROM "HY_FACT_DDCX_NEW"
            WHERE ${Prisma.join(prodConds, ' OR ')}
            LIMIT 200
          `
          factKeysByProd = Array.from(new Set(matched.flatMap(m => [m.DDBH, m.BDQD_DDBH].filter((k): k is string => Boolean(k)))))
        } catch {}

        andConditions.push({
          OR: [
            { rawJson: { path: ['itemName'], string_contains: sType } },
            { rawJson: { path: ['serviceType'], string_contains: sType } },
            { rawJson: { path: ['serviceName'], string_contains: sType } },
            { rawJson: { path: ['serviceItemName'], string_contains: sType } },
            { detailJson: { path: ['recommendations', 'itemName'], string_contains: sType } },
            { detailJson: { path: ['recommendations', 'serviceName'], string_contains: sType } },
            { detailJson: { path: ['recommendations', 'subPlanName'], string_contains: sType } },
            ...(sType.includes('挂号') ? [{ rawJson: { path: ['poolType'], equals: 'register' } }] : []),
            ...(factKeysByProd.length > 0 ? [{ sourceOrderNo: { in: factKeysByProd } }, { huanyuOrderNo: { in: factKeysByProd } }] : [])
          ]
        })
      }

      // 10. 高级筛选 - 客户经理 (带事实表 KHJL 穿透联动)
      if (accountManager && typeof accountManager === 'string' && accountManager.trim()) {
        const amName = accountManager.trim()
        let factKeysByManager: string[] = []
        try {
          const matched = await prisma.$queryRaw<Array<{ DDBH: string; BDQD_DDBH: string | null }>>`
            SELECT "DDBH", "BDQD_DDBH"
            FROM "HY_FACT_DDCX_NEW"
            WHERE "KHJL" ILIKE ${'%' + amName + '%'}
            LIMIT 200
          `
          factKeysByManager = Array.from(new Set(matched.flatMap(m => [m.DDBH, m.BDQD_DDBH].filter((k): k is string => Boolean(k)))))
        } catch {}

        andConditions.push({
          OR: [
            { assignedEmployee: { name: { contains: amName, mode: 'insensitive' } } },
            { rawJson: { path: ['accountManager'], string_contains: amName } },
            { rawJson: { path: ['cmgrName'], string_contains: amName } },
            { rawJson: { path: ['mmgrName'], string_contains: amName } },
            ...(factKeysByManager.length > 0 ? [{ sourceOrderNo: { in: factKeysByManager } }, { huanyuOrderNo: { in: factKeysByManager } }] : [])
          ]
        })
      }

      // 11. 高级筛选 - 入池日期范围 (覆盖 orders.createdAt、rawJson.applyDate/applicationDate/applyTime)
      if (startDate || endDate) {
        const startDt = startDate ? new Date(startDate) : new Date('1970-01-01')
        const endDt = endDate ? new Date(endDate) : new Date('2099-12-31')
        if (endDate) endDt.setHours(23, 59, 59, 999)

        const startStr = startDate ? startDate.slice(0, 10) : '1970-01-01'
        const endStr = endDate ? endDate.slice(0, 10) + ' 23:59:59' : '2099-12-31 23:59:59'

        let dateMatchedOrderIds: number[] = []
        try {
          const matched = await prisma.$queryRaw<Array<{ id: number }>>`
            SELECT id FROM "Order"
            WHERE (
              (NULLIF("rawJson"->>'applyDate', '') IS NOT NULL AND ("rawJson"->>'applyDate') >= ${startStr} AND ("rawJson"->>'applyDate') <= ${endStr})
              OR (NULLIF("rawJson"->>'applicationDate', '') IS NOT NULL AND ("rawJson"->>'applicationDate') >= ${startStr} AND ("rawJson"->>'applicationDate') <= ${endStr})
              OR (NULLIF("rawJson"->>'applyTime', '') IS NOT NULL AND ("rawJson"->>'applyTime') >= ${startStr} AND ("rawJson"->>'applyTime') <= ${endStr})
            )
            LIMIT 5000
          `
          dateMatchedOrderIds = matched.map(m => m.id)
        } catch {}

        const createdAtCond: any = {}
        if (startDate) createdAtCond.gte = startDt
        if (endDate) createdAtCond.lte = endDt

        andConditions.push({
          OR: [
            { createdAt: createdAtCond },
            ...(dateMatchedOrderIds.length > 0 ? [{ id: { in: dateMatchedOrderIds } }] : [])
          ]
        })
      }

      if (andConditions.length > 0) {
        where.AND = andConditions
      }

      const isPaginated = page !== undefined || pageSize !== undefined
      const pageNum = Math.max(1, parseInt(String(page || 1), 10) || 1)
      const sizeNum = Math.max(1, Math.min(100, parseInt(String(pageSize || 20), 10) || 20))

      let orderBy: any = { createdAt: 'desc' }
      if (sortKey) {
        const dir = sortDir === 'asc' ? 'asc' : 'desc'
        if (sortKey === 'poolEnteredAt' || sortKey === 'createdAt') orderBy = { createdAt: dir }
        else if (sortKey === 'hospital') orderBy = { hospital: dir }
        else if (sortKey === 'customerName') orderBy = { customerName: dir }
        else if (sortKey === 'updatedAt') orderBy = { updatedAt: dir }
      }

      try {
        const selfOpData = await querySelfOperatedHuanyuOrders(prisma, {
          captureEmployeeId,
          query,
          status,
          lane: (request.query as any).lane,
          applicationNo,
          sourceOrderNo,
          huanyuOrderNo,
          serviceType,
          customerName,
          accountManager,
          hospital,
          dept,
          doctor,
          minAmount: (request.query as any).minAmount,
          maxAmount: (request.query as any).maxAmount,
          startDate,
          endDate
        })

        const selfOpCount = selfOpData.length
        const orderTableCount = isPaginated ? await prisma.order.count({ where }) : 0
        const totalCount = isPaginated ? (orderTableCount + selfOpCount) : undefined

        let pageSelfOps: any[] = []
        let ordersSkip = 0
        let ordersTake = sizeNum

        if (isPaginated) {
          const globalStart = (pageNum - 1) * sizeNum
          const globalEnd = globalStart + sizeNum

          if (globalStart < selfOpCount) {
            pageSelfOps = selfOpData.slice(globalStart, globalEnd)
            ordersSkip = 0
            ordersTake = Math.max(0, sizeNum - pageSelfOps.length)
          } else {
            pageSelfOps = []
            ordersSkip = globalStart - selfOpCount
            ordersTake = sizeNum
          }
        }

        const orders = (isPaginated && ordersTake === 0)
          ? []
          : await prisma.order.findMany({
              where,
              orderBy,
              ...(isPaginated ? { skip: ordersSkip, take: ordersTake } : {}),
          select: {
            id: true,
            source: true,
            sourceOrderNo: true,
            customerName: true,
            customerPhone: true,
            hospital: true,
            dept: true,
            doctor: true,
            status: true,
            orderState: true,
            huanyuOrderNo: true,
            rawJson: true,
            detailJson: true,
            aiBriefJson: true,
            assignedEmployee: {
              select: { id: true, name: true }
            },
            createdAt: true,
            updatedAt: true,
            _count: { select: { calls: true, materials: true } },
            calls: {
              select: { startedAt: true },
              orderBy: { startedAt: 'desc' },
              take: 1
            },
            materials: {
              select: { type: true, createdAt: true },
              orderBy: { createdAt: 'desc' }
            }
          }
        })

        // 批量查询对应的 HY_FACT_DDCX_NEW 记录
        const huanyuOrderKeys = Array.from(
          new Set(
            orders.flatMap((o) => {
              const raw = (o.rawJson ?? {}) as Record<string, unknown>
              return [
                o.huanyuOrderNo,
                o.sourceOrderNo,
                stringOrNull(raw.sourceOrderNo),
                stringOrNull(raw.channelOrderNo),
                stringOrNull(raw.bOrderNo),
                stringOrNull(raw.bChannelOrderNo),
                stringOrNull(raw.orderNo)
              ].filter((value): value is string => Boolean(value))
            })
          )
        )
        const huanyuRows = huanyuOrderKeys.length > 0
          ? await prisma.$queryRaw<Array<{
              DDBH: string
              BDQD_DDBH: string | null
              DD_state: string | null
              DDJE: any
              KHJL: string | null
              H_NAME: string | null
              H_KS: string | null
              H_YS: string | null
              JZR_XM: string | null
              BDQD_FWXM: string | null
              xtsj_: string | null
            }>>`
              SELECT "DDBH", "BDQD_DDBH", "DD_state", "DDJE", "KHJL", "H_NAME", "H_KS", "H_YS", "JZR_XM", "BDQD_FWXM", "xtsj_"
              FROM "HY_FACT_DDCX_NEW"
              WHERE "DDBH" IN (${Prisma.join(huanyuOrderKeys)})
                 OR "BDQD_DDBH" IN (${Prisma.join(huanyuOrderKeys)})
            `
          : []

        // 按 orderKey 归类所有的 HY_FACT_DDCX_NEW 记录（支持一单多次服务）
        const huanyuRowsByKey = new Map<string, Array<{
          DDBH: string
          BDQD_DDBH: string | null
          DD_state: string | null
          DDJE: any
          KHJL: string | null
          H_NAME: string | null
          H_KS: string | null
          H_YS: string | null
          JZR_XM: string | null
          BDQD_FWXM: string | null
          xtsj_: string | null
        }>>()

        for (const row of huanyuRows) {
          const keys = [row.DDBH, row.BDQD_DDBH].filter((k): k is string => Boolean(k))
          for (const k of keys) {
            const list = huanyuRowsByKey.get(k) ?? []
            if (!list.some(item => item.DDBH === row.DDBH)) {
              list.push(row)
            }
            huanyuRowsByKey.set(k, list)
          }
        }

        const allFwxmCodes = huanyuRows.map(r => r.BDQD_FWXM).filter((x): x is string => Boolean(x && x.trim()))
        const allHospCodes = huanyuRows.map(r => r.H_NAME).filter((x): x is string => Boolean(x && x.trim()))
        const allDeptCodes = huanyuRows.map(r => r.H_KS).filter((x): x is string => Boolean(x && x.trim()))
        const allDoctorCodes = huanyuRows.map(r => r.H_YS).filter((x): x is string => Boolean(x && x.trim()))

        const [channelProductMap, hospitalDictMap, deptDictMap, doctorDictMap] = await Promise.all([
          findHuanyuChannelProductsByIds(allFwxmCodes),
          findHuanyuHospitalsByIds(allHospCodes),
          findHuanyuDepartmentsByIds(allDeptCodes),
          findHuanyuDoctorsByIds(allDoctorCodes)
        ])

        const orderIds = orders.map((o) => o.id)
        const applicationNos = Array.from(
          new Set(
            orders
              .map((o) => ((o.rawJson ?? {}) as Record<string, unknown>).crmApplyNo)
              .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
              .map((x) => x.trim())
          )
        )
        const messagesForOrders = (orderIds.length || applicationNos.length)
          ? await prisma.message.findMany({
              where: {
                ...(captureEmployeeId ? { employeeId: captureEmployeeId } : {}),
                OR: [
                  ...(orderIds.length ? [{ orderId: { in: orderIds } }] : []),
                  ...(applicationNos.length ? [{ applicationNo: { in: applicationNos } }] : [])
                ]
              },
              select: { id: true, orderId: true, applicationNo: true }
            })
          : []
        const appToOrderIds = new Map<string, number[]>()
        for (const o of orders) {
          const appNo = ((o.rawJson ?? {}) as Record<string, unknown>).crmApplyNo
          if (typeof appNo !== 'string' || !appNo.trim()) continue
          const key = appNo.trim()
          const ids = appToOrderIds.get(key) ?? []
          ids.push(o.id)
          appToOrderIds.set(key, ids)
        }
        const messageIdsByOrderId = new Map<number, Set<number>>()
        for (const orderId of orderIds) messageIdsByOrderId.set(orderId, new Set<number>())
        for (const message of messagesForOrders) {
          if (message.orderId && messageIdsByOrderId.has(message.orderId)) {
            messageIdsByOrderId.get(message.orderId)!.add(message.id)
          }
          if (message.applicationNo) {
            for (const orderId of appToOrderIds.get(message.applicationNo) ?? []) {
              messageIdsByOrderId.get(orderId)?.add(message.id)
            }
          }
        }

        const channelCache = await getCachedChannelProducts()

        // 批量查询当前页订单未处理的 AI 识别业务字段（b_order_ai_field_candidates）
        const aiCandidateRows = orderIds.length > 0
          ? await prisma.$queryRaw<Array<{
              order_id: number
              field_code: string
              value_text: string
            }>>`
              SELECT DISTINCT ON (order_id, field_code)
                order_id, field_code, value_text
              FROM b_order_ai_field_candidates
              WHERE order_id IN (${Prisma.join(orderIds)}) AND status = 'pending'
              ORDER BY order_id, field_code, created_at DESC, id DESC
            `
          : []
        const aiCandidatesByOrderId = new Map<number, Map<string, string>>()
        for (const row of aiCandidateRows) {
          let fieldMap = aiCandidatesByOrderId.get(row.order_id)
          if (!fieldMap) {
            fieldMap = new Map<string, string>()
            aiCandidatesByOrderId.set(row.order_id, fieldMap)
          }
          if (row.value_text && row.value_text.trim()) {
            fieldMap.set(row.field_code, row.value_text.trim())
          }
        }

        const data = orders.map((o: any) => {
          const raw = (o.rawJson ?? {}) as Record<string, unknown>
          const orderKeys = [
            o.huanyuOrderNo,
            o.sourceOrderNo,
            stringOrNull(raw.sourceOrderNo),
            stringOrNull(raw.channelOrderNo),
            stringOrNull(raw.bOrderNo),
            stringOrNull(raw.bChannelOrderNo),
            stringOrNull(raw.orderNo)
          ].filter((v): v is string => Boolean(v))

          // 匹配当前订单的所有寰宇服务记录
          const matchedHuanyuRows: Array<{
            DDBH: string
            BDQD_DDBH: string | null
            DD_state: string | null
            DDJE: any
            KHJL: string | null
            H_NAME: string | null
            H_KS: string | null
            H_YS: string | null
            JZR_XM: string | null
            BDQD_FWXM: string | null
            xtsj_: string | null
          }> = []
          for (const k of orderKeys) {
            const list = huanyuRowsByKey.get(k) || []
            for (const item of list) {
              if (!matchedHuanyuRows.some(r => r.DDBH === item.DDBH)) {
                matchedHuanyuRows.push(item)
              }
            }
          }

          // 寰宇状态
          const huanyuOrderStatus = matchedHuanyuRows[0]?.DD_state || null
          const taikangOrderStateName = taikangOrderStateNameOf(raw, o.status)
          const taikangOrderState = taikangOrderStateOf(raw, o.orderState)
          const taikangCaseStatus = stringOrNull(raw.taikangCaseStatus) ?? stringOrNull(raw.caseStatus)
          const taikangWaitType = stringOrNull(raw.taikangWaitType) ?? stringOrNull(raw.waitType)
          const taikangServState = stringOrNull(raw.taikangServState) ?? stringOrNull(raw.servState)
          const workbenchLane = deriveWorkbenchLane(huanyuOrderStatus)
          const serviceStage = deriveServiceStage(workbenchLane)
          const rec = ((o.detailJson as any)?.recommendations ?? {}) as Record<string, unknown>
          const claimedAt =
            (raw.applyDate as string | undefined) ??
            (raw.applicationDate as string | undefined) ??
            (raw.applyTime as string | undefined) ??
            o.createdAt.toISOString()

          // 1. 客户姓名：优先取不含 * 的真实姓名
          const hPatientName = matchedHuanyuRows.find(r => r.JZR_XM && !r.JZR_XM.includes('*'))?.JZR_XM
          const customerNameRow =
            (hPatientName ? hPatientName.trim() : undefined) ??
            (rec.patientName && !String(rec.patientName).includes('*') ? String(rec.patientName).trim() : undefined) ??
            (rec.insurName && !String(rec.insurName).includes('*') ? String(rec.insurName).trim() : undefined) ??
            (raw.patientName && !String(raw.patientName).includes('*') ? String(raw.patientName).trim() : undefined) ??
            (raw.insurName && !String(raw.insurName).includes('*') ? String(raw.insurName).trim() : undefined) ??
            (o.customerName && !String(o.customerName).includes('*') ? String(o.customerName).trim() : undefined) ??
            (raw.patientName as string | undefined) ??
            o.customerName

          const customerPhoneRow =
            (raw.paMobile as string | undefined) ??
            (rec.paMobile as string | undefined) ??
            (rec.ecpPhone as string | undefined) ??
            o.customerPhone ??
            null

          // AI 分析结果（包含 aiBriefJson 与 b_order_ai_field_candidates）
          const aiKeyInfo = ((o.aiBriefJson as any)?.keyInfo ?? {}) as Record<string, unknown>
          const aiFieldMap = aiCandidatesByOrderId.get(o.id)
          const aiHospital = stringOrNull(aiFieldMap?.get('hospital')) ?? stringOrNull(aiKeyInfo['目标医院'])
          const aiDept = stringOrNull(aiFieldMap?.get('department')) ?? stringOrNull(aiKeyInfo['科室或病种'])
          const aiDoctor = stringOrNull(aiFieldMap?.get('doctor')) ?? stringOrNull(aiKeyInfo['意向专家'])

          // 2. 医院：1 优先 HY_FACT_DDCX_NEW 维表反查/清洗 -> 2 优先 AI 目标医院 -> 3 优先上游意向/原单（清洗过滤省市区）
          const rawHospital = typeof raw.hospital === 'string' ? raw.hospital : undefined
          const hNameRaw = matchedHuanyuRows.find(r => r.H_NAME?.trim())?.H_NAME?.trim()
          const hNameResolved = hNameRaw ? (hospitalDictMap.get(hNameRaw)?.name ?? cleanHospitalName(hNameRaw)) : null
          const hospitalRow =
            hNameResolved ??
            cleanHospitalName(aiHospital) ??
            cleanHospitalName(rec.visitingHospital) ??
            cleanHospitalName(rec.intendHos) ??
            cleanHospitalName(raw.clinicHos) ??
            cleanHospitalName(raw.intendHos) ??
            cleanHospitalName(raw.visitingHospital) ??
            cleanHospitalName(rawHospital) ??
            cleanHospitalName(o.hospital) ??
            null

          // 3. 科室：1 优先 HY_FACT_DDCX_NEW 维表反查/清洗 -> 2 优先 AI 科室病种 -> 3 优先原订单
          const rawDept = typeof raw.dept === 'string' ? raw.dept : undefined
          const isNumericDeptId = rawDept && /^\d{6,12}$/.test(rawDept.trim())
          const hKsRaw = matchedHuanyuRows.find(r => r.H_KS?.trim())?.H_KS?.trim()
          const hKsResolved = hKsRaw ? (deptDictMap.get(hKsRaw)?.name ?? cleanDeptName(hKsRaw)) : null
          const deptRow =
            hKsResolved ??
            cleanDeptName(aiDept) ??
            (!isNumericDeptId ? cleanDeptName(rawDept) : undefined) ??
            cleanDeptName(rec.intendDept as string | undefined) ??
            (o.dept && !/^\d{6,12}$/.test(o.dept.trim()) ? o.dept : undefined) ??
            cleanDeptName(rawDept) ??
            cleanDeptName(o.dept) ??
            null

          // 4. 医生：1 优先 HY_FACT_DDCX_NEW 维表反查/清洗 -> 2 优先 AI 意向专家 -> 3 优先原订单
          const rawDoctor = typeof raw.doctor === 'string' ? raw.doctor : undefined
          const isNumericDoctorId = rawDoctor && /^\d{4,10}$/.test(rawDoctor.trim())
          const hYsRaw = matchedHuanyuRows.find(r => r.H_YS?.trim())?.H_YS?.trim()
          const hYsResolved = hYsRaw ? (doctorDictMap.get(hYsRaw)?.name ?? cleanDoctorName(hYsRaw)) : null
          const doctorRow =
            hYsResolved ??
            cleanDoctorName(aiDoctor) ??
            (!isNumericDoctorId ? cleanDoctorName(rawDoctor) : undefined) ??
            cleanDoctorName(rec.intendDoc as string | undefined) ??
            (o.doctor && !/^\d{4,10}$/.test(o.doctor.trim()) ? o.doctor : undefined) ??
            cleanDoctorName(rawDoctor) ??
            cleanDoctorName(o.doctor) ??
            null

          // 5. 客户经理：优先取 HY_FACT_DDCX_NEW 的客户经理，没有的话取 orders 表的 assigned_employee_id (关联 employees.name)
          const hKhjl = matchedHuanyuRows.find(r => r.KHJL?.trim())?.KHJL?.trim()
          const accountManagerRow =
            hKhjl ??
            o.assignedEmployee?.name ??
            null

          // 7. 业务类型名称
          const primaryFwxm = matchedHuanyuRows[0]?.BDQD_FWXM
          const matchedPrimaryProd = primaryFwxm ? channelProductMap.get(primaryFwxm.trim()) : null
          const serviceTypeRow =
            (raw.poolType === 'register' ? '挂号协助' : null) ??
            matchedPrimaryProd?.name ??
            (primaryFwxm && !/^\d+$/.test(primaryFwxm.trim()) ? primaryFwxm : null) ??
            stringOrNull(raw.itemName) ??
            stringOrNull(raw.serviceType) ??
            stringOrNull(raw.serviceName) ??
            null

          // 6. 订单金额：优先取 HY_FACT_DDCX_NEW.DDJE；当没有的时候，按照订单B端渠道服务项目计算出来
          const isCancelled = isCancelledOrderText(o.status) || isCancelledOrderText(huanyuOrderStatus)
          const isRegister = raw.poolType === 'register' || o.source === 'taikang_register' || raw.serviceType === '挂号协助'
          const channelProds = isRegister ? channelCache.p62 : channelCache.p72

          const primaryItemCandidates = [
            matchedHuanyuRows[0]?.BDQD_FWXM,
            raw.itemName,
            raw.serviceType,
            raw.serviceItemName,
            raw.serviceName,
            rec.itemName,
            rec.serviceName,
            rec.subPlanName,
            serviceTypeRow
          ]
          const computedPrice = calculateChannelProductPrice(channelProds, primaryItemCandidates, isCancelled)

          const firstJe = matchedHuanyuRows[0]?.DDJE != null && Number.isFinite(Number(matchedHuanyuRows[0].DDJE)) && Number(matchedHuanyuRows[0].DDJE) > 0
            ? Number(matchedHuanyuRows[0].DDJE)
            : null

          const orderAmountRow = isCancelled
            ? 0
            : (firstJe ?? computedPrice ?? (raw.orderAmount != null ? Number(raw.orderAmount) : null))

          // 区分自营订单（无B端单号，只有寰宇订单号）与外部渠道订单
          const isSelfOperated = o.source === 'huanyu' || (typeof o.sourceOrderNo === 'string' && o.sourceOrderNo.startsWith('HYYD'))
          const huanyuOrderNoRow =
            o.huanyuOrderNo ??
            matchedHuanyuRows[0]?.DDBH ??
            (isSelfOperated ? o.sourceOrderNo : null) ??
            null
          const bOrderNoRow = isSelfOperated ? null : o.sourceOrderNo

          // 多次复制服务单列表
          const huanyuOrders = matchedHuanyuRows.map((r, index) => {
            const rowJe = r.DDJE != null && Number.isFinite(Number(r.DDJE)) && Number(r.DDJE) > 0 ? Number(r.DDJE) : null
            const subCandidates = [r.BDQD_FWXM, r.BDQD_FWXM ? null : serviceTypeRow]
            const subComputed = calculateChannelProductPrice(channelProds, subCandidates, isCancelled)
            const matchedSubProd = r.BDQD_FWXM ? channelProductMap.get(r.BDQD_FWXM.trim()) : null
            const resolvedSubServiceName =
              matchedSubProd?.name ||
              (r.BDQD_FWXM && !/^\d+$/.test(r.BDQD_FWXM.trim()) ? r.BDQD_FWXM : null) ||
              serviceTypeRow ||
              ''
            return {
              id: r.DDBH,
              ddbh: r.DDBH,
              huanyuOrderNo: r.DDBH,
              bOrderNo: r.BDQD_DDBH || (isSelfOperated ? null : o.sourceOrderNo),
              isClone: index > 0,
              sequence: index + 1,
              status: r.DD_state || '待跟进',
              serviceName: resolvedSubServiceName,
              amount: isCancelled ? 0 : (rowJe ?? subComputed ?? null),
              accountManager: r.KHJL || accountManagerRow || '',
              hospital: (r.H_NAME ? (hospitalDictMap.get(r.H_NAME.trim())?.name || cleanHospitalName(r.H_NAME)) : null) || hospitalRow || '',
              dept: (r.H_KS ? (deptDictMap.get(r.H_KS.trim())?.name || cleanDeptName(r.H_KS)) : null) || deptRow || '',
              doctor: (r.H_YS ? (doctorDictMap.get(r.H_YS.trim())?.name || cleanDoctorName(r.H_YS)) : null) || doctorRow || '',
              patientName: r.JZR_XM || customerNameRow,
              createdAt: r.xtsj_ || o.createdAt.toISOString()
            }
          })

          const intendDateRow =
            (raw.intendDate as string | undefined) ??
            (rec.intendDate as string | undefined) ??
            null
          const intendDateAmorpmRow =
            (raw.intendDateAmorpm as string | undefined) ??
            (rec.intendDateAmorpm as string | undefined) ??
            null

          const audioCount = o._count?.calls ?? 0
          const messageCount = messageIdsByOrderId.get(o.id)?.size ?? 0
          const textCount = messageCount + (o.materials ?? []).filter((m: any) => m.type === 'text').length
          const imageCount = (o.materials ?? []).filter((m: any) => m.type === 'image').length
          const materialCount = audioCount + textCount + imageCount

          const lastCallAt = o.calls?.[0]?.startedAt
            ? new Date(o.calls[0].startedAt).getTime()
            : 0
          const lastMatAt = o.materials?.[0]?.createdAt
            ? new Date(o.materials[0].createdAt).getTime()
            : 0
          const lastTs = Math.max(lastCallAt, lastMatAt)
          const lastMaterialAt = lastTs > 0 ? new Date(lastTs).toISOString() : null

          const { _count, calls, materials, detailJson, aiBriefJson, assignedEmployee, ...rest } = o
          void _count
          void calls
          void materials
          void detailJson
          void aiBriefJson
          void assignedEmployee

          return {
            ...rest,
            sourceOrderNo: bOrderNoRow ?? '',
            bOrderNo: bOrderNoRow,
            huanyuOrderNo: huanyuOrderNoRow,
            status: huanyuOrderStatus ?? (o.status === '候选' ? '待跟进' : o.status),
            huanyuOrderStatus,
            taikangOrderState,
            taikangOrderStateName,
            taikangCaseStatus,
            taikangWaitType,
            taikangServState,
            workbenchLane,
            serviceStage,
            customerName: customerNameRow,
            customerPhone: customerPhoneRow,
            accountManager: accountManagerRow,
            hospital: hospitalRow,
            dept: deptRow,
            doctor: doctorRow,
            orderAmount: orderAmountRow,
            serviceType: serviceTypeRow,
            huanyuOrders,
            isAiHospital: Boolean(!hNameRaw && aiHospital),
            isAiDept: Boolean(!hKsRaw && aiDept),
            isAiDoctor: Boolean(!hYsRaw && aiDoctor),
            intendDate: intendDateRow,
            intendDateAmorpm: intendDateAmorpmRow,
            claimedAt,
            audioCount,
            textCount,
            imageCount,
            materialCount,
            lastMaterialAt
          }
        })

        const finalData = isPaginated ? [...pageSelfOps, ...data] : [...selfOpData, ...data]

        if (isPaginated) {
          return reply.send({
            data: finalData,
            total: totalCount ?? finalData.length,
            page: pageNum,
            pageSize: sizeNum,
            totalPages: Math.ceil((totalCount ?? finalData.length) / sizeNum)
          })
        }

        return reply.send({ data: finalData })
      } catch (err: any) {
        return reply.status(500).send({ error: '查询订单失败: ' + err.message })
      }
    }
  )

  // 5. 工作台触发申领 POST /api/v1/orders/:id/claim
  // 注意: 申领的员工 ID 直接从 token 解出来（auth 中间件已注入 request.employee），
  // 忽略 body 里的 employeeId，避免客户端写死 ID 与数据库不匹配
  fastify.post<{ Params: { id: string }; Body: ClaimOrderPayload }>('/api/v1/orders/:id/claim', async (request, reply) => {
    const orderId = parseInt(request.params.id, 10)
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const employeeId = request.employee.id

    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId }
      })

      if (!order) {
        return reply.status(404).send({ error: '订单不存在' })
      }

      if (order.status !== '候选') {
        return reply.status(400).send({ error: '只能申领“候选”状态的订单' })
      }

      // 更新订单状态及分配的员工
      const updatedOrder = await prisma.order.update({
        where: { id: orderId },
        data: {
          status: '已申领',
          assignedEmployeeId: employeeId
        }
      })

      // skipTaikang：待申领页"只展示、先不写泰康"——只在我方库里标记申领，不下发插件指令、不操作泰康。
      if (request.body?.skipTaikang) {
        return reply.send({ data: { order: updatedOrder, commandId: null, taikangSkipped: true } })
      }

      // 创建一个发给插件 (ext) 的申领控制指令
      const command = await prisma.command.create({
        data: {
          target: 'ext',
          action: 'claim',
          payloadJson: {
            orderId: order.id,
            sourceOrderNo: order.sourceOrderNo,
            customerName: order.customerName,
            hospital: order.hospital,
            dept: order.dept,
            doctor: order.doctor
          },
          status: 'pending'
        }
      })

      // 通过 WebSocket 主动推送指令给该员工绑定的浏览器插件 (ext)
      const conn = activeConnections.get(employeeId)
      if (conn && conn.ext && conn.ext.readyState === 1) { // 1 = OPEN
        conn.ext.send(JSON.stringify({
          type: 'command',
          commandId: command.id,
          action: command.action,
          payload: command.payloadJson
        }))
        fastify.log.info(`已通过 WebSocket 向员工 ${employeeId} 推送申领指令 ${command.id}`)
      } else {
        fastify.log.warn(`员工 ${employeeId} 的浏览器插件未建立 WebSocket 连接，指令 ${command.id} 将由其短轮询获取`)
      }

      return reply.send({ data: { order: updatedOrder, commandId: command.id } })
    } catch (err: any) {
      fastify.log.error('申领订单出错:', err)
      return reply.status(500).send({ error: '申领订单失败: ' + err.message })
    }
  })

  // 6. 插件轮询待执行指令 GET /api/v1/commands
  fastify.get<{ Querystring: { target?: string; status?: string } }>('/api/v1/commands', async (request, reply) => {
    const { target, status } = request.query

    const where: any = {}
    if (target) where.target = target
    if (status) where.status = status

    try {
      const commands = await prisma.command.findMany({
        where,
        orderBy: { createdAt: 'asc' }
      })
      return reply.send({ data: commands })
    } catch (err: any) {
      return reply.status(500).send({ error: '获取指令失败: ' + err.message })
    }
  })

  // 7. 指令完成回报 POST /api/v1/commands/:id/done
  fastify.post<{ Params: { id: string }; Body: CommandDonePayload }>('/api/v1/commands/:id/done', async (request, reply) => {
    const commandId = parseInt(request.params.id, 10)
    const { result, error } = request.body

    try {
      const command = await prisma.command.findUnique({
        where: { id: commandId }
      })

      if (!command) {
        return reply.status(404).send({ error: '指令不存在' })
      }

      const isSuccess = !error
      const updatedCommand = await prisma.command.update({
        where: { id: commandId },
        data: {
          status: isSuccess ? 'done' : 'failed',
          executedAt: new Date()
        }
      })

      // 如果申领指令执行成功，我们可以直接在这里把订单状态更正为“进行中”
      const orderId = (command.payloadJson as any).orderId
      if (orderId && isSuccess) {
        await prisma.order.update({
          where: { id: orderId },
          data: { status: '进行中' }
        })
      }

      return reply.send({ data: updatedCommand })
    } catch (err: any) {
      return reply.status(500).send({ error: '更新指令状态失败: ' + err.message })
    }
  })

  // 7.5 会话列表 GET /api/v1/conversations （当前员工，按 channel+conversationName 聚合）
  // 返回每个会话：消息数、最近一条预览、关联订单（如有）
  fastify.get<{ Querystring: { channel?: string } }>('/api/v1/conversations', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const employeeId = request.employee.id
    const channelFilter = request.query.channel
    try {
      // 用原生 SQL 一次性聚合，避免 N+1
      const rows = await prisma.$queryRaw<Array<{
        channel: string
        conversation_name: string
        message_count: bigint
        last_at: Date
        last_text: string
        last_order_id: number | null
      }>>`
        SELECT m.channel,
               m.conversation_name,
               COUNT(*)::bigint AS message_count,
               MAX(m.captured_at) AS last_at,
               (
                 SELECT content_text FROM messages m2
                  WHERE m2.employee_id = m.employee_id
                    AND m2.channel = m.channel
                    AND m2.conversation_name = m.conversation_name
                  ORDER BY m2.captured_at DESC LIMIT 1
               ) AS last_text,
               (
                 SELECT order_id FROM messages m3
                  WHERE m3.employee_id = m.employee_id
                    AND m3.channel = m.channel
                    AND m3.conversation_name = m.conversation_name
                    AND m3.order_id IS NOT NULL
                  ORDER BY m3.captured_at DESC LIMIT 1
               ) AS last_order_id
          FROM messages m
         WHERE m.employee_id = ${employeeId}
           ${channelFilter ? Prisma.sql`AND m.channel = ${channelFilter}` : Prisma.empty}
         GROUP BY m.channel, m.conversation_name, m.employee_id
         ORDER BY MAX(m.captured_at) DESC
      `

      // 一次性查关联订单
      const orderIds = Array.from(new Set(rows.map((r) => r.last_order_id).filter((x): x is number => x !== null)))
      const orders = orderIds.length > 0
        ? await prisma.order.findMany({
            where: { id: { in: orderIds } },
            select: { id: true, sourceOrderNo: true, customerName: true, status: true }
          })
        : []
      const orderMap = new Map(orders.map((o) => [o.id, o]))

      const data = rows.map((r) => ({
        channel: r.channel as 'wechat' | 'wxwork',
        conversationName: r.conversation_name,
        messageCount: Number(r.message_count),
        lastMessageAt: r.last_at.toISOString(),
        lastMessagePreview: (r.last_text || '').slice(0, 30),
        order: r.last_order_id ? (orderMap.get(r.last_order_id) ?? null) : null
      }))
      return reply.send({ data })
    } catch (err: any) {
      fastify.log.error('查询会话列表失败:', err)
      return reply.status(500).send({ error: '查询会话列表失败: ' + err.message })
    }
  })

  // 7.6 单个会话的全部消息 GET /api/v1/conversations/:channel/:name/messages
  fastify.get<{ Params: { channel: string; name: string } }>(
    '/api/v1/conversations/:channel/:name/messages',
    async (request, reply) => {
      if (!request.employee) return reply.status(401).send({ error: '未登录' })
      const employeeId = request.employee.id
      const employeeName = request.employee.name
      const { channel, name } = request.params
      const conversationName = decodeURIComponent(name)
      try {
        const messages = await prisma.message.findMany({
          where: { employeeId, channel, conversationName },
          orderBy: [{ sortTime: { sort: 'asc', nulls: 'last' } }, { capturedAt: 'asc' }]
        })
        // 取该会话最近一条关联的订单
        const latestWithOrder = [...messages].reverse().find((m) => m.orderId !== null)
        const order = latestWithOrder?.orderId
          ? await prisma.order.findUnique({
              where: { id: latestWithOrder.orderId },
              select: { id: true, sourceOrderNo: true, customerName: true, status: true }
            })
          : null
        return reply.send({
          data: {
            messages: messages.map((m) => ({
              id: m.id,
              senderName: m.senderName,
              contentText: m.contentText,
              capturedAt: m.capturedAt.toISOString(),
              isMine: m.senderName === employeeName, // 后端判断我方
              hasScreenshot: !!m.screenshotOssKey,
              orderId: m.orderId
            })),
            order
          }
        })
      } catch (err: any) {
        fastify.log.error('查询会话消息失败:', err)
        return reply.status(500).send({ error: '查询会话消息失败: ' + err.message })
      }
    }
  )

  // 7.7 单条消息截图的 presigned URL
  fastify.get<{ Params: { id: string } }>('/api/v1/messages/:id/screenshot-url', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const messageId = parseInt(request.params.id, 10)
    try {
      const msg = await prisma.message.findUnique({ where: { id: messageId } })
      if (!msg) return reply.status(404).send({ error: '消息不存在' })
      if (msg.employeeId !== request.employee.id) {
        return reply.status(403).send({ error: '不能查看他人的消息' })
      }
      if (!msg.screenshotOssKey) {
        return reply.status(404).send({ error: '该消息无截图' })
      }
      const url = await minioPublicClient.presignedGetObject(
        env.minioBucketScreenshots,
        msg.screenshotOssKey,
        60 * 60
      )
      return reply.send({ data: { url, expiresIn: 3600 } })
    } catch (err: any) {
      fastify.log.error('获取消息截图 URL 失败:', err)
      return reply.status(500).send({ error: '获取消息截图 URL 失败: ' + err.message })
    }
  })

  // 7.8 订单的消息类 AI 摘要 GET /api/v1/orders/:id/messages/ai-summary
  // 返回该订单最新一条 type='message' 的 AiSummary，用户接 LLM 后 INSERT 即可
  fastify.get<{ Params: { id: string } }>('/api/v1/orders/:id/messages/ai-summary', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const orderId = parseInt(request.params.id, 10)
    try {
      const summary = await prisma.aiSummary.findFirst({
        where: { orderId, type: 'message' },
        orderBy: { createdAt: 'desc' }
      })
      return reply.send({
        data: summary
          ? {
              id: summary.id,
              content: summary.content,
              model: summary.model,
              createdAt: summary.createdAt.toISOString()
            }
          : null
      })
    } catch (err: any) {
      fastify.log.error('查询消息 AI 摘要失败:', err)
      return reply.status(500).send({ error: '查询消息 AI 摘要失败: ' + err.message })
    }
  })

  // 8. 上报微信消息 POST /api/v1/messages
  fastify.post<{ Body: CreateMessagePayload }>('/api/v1/messages', async (request, reply) => {
    const { channel, conversationName, senderName, contentText, screenshotOssKey, capturedAt, orderId, orderNoCandidate } = request.body
    // 优先用鉴权头对应的员工（sidecar 采集上报时只带工号，不带 employeeId）
    const employeeId = request.employee?.id ?? request.body.employeeId
    if (!employeeId) return reply.status(401).send({ error: '未登录或缺少 employeeId' })

    try {
      let finalOrderId = orderId ?? null
      let finalApplicationNo: string | null = null
      if (finalOrderId) {
        const providedOrder = await prisma.order.findFirst({
          where: { id: finalOrderId, assignedEmployeeId: employeeId },
          select: { rawJson: true }
        })
        finalApplicationNo = providedOrder ? applicationNosForConversationMatch(providedOrder.rawJson)[0] ?? null : null
      }
      // 调试信息：记录每一步匹配过程，随响应返回给客户端（tray-app 展示在采集调试日志里）
      const _debug: {
        matchMethod: string; candidate?: string
        matchedOrderId?: number | null; matchedApplicationNo?: string | null; reason?: string
      } = { matchMethod: 'none' }

      // 客户会话只按申请号字段 rawJson.crmApplyNo 识别；COD/sourceOrderNo 不参与自动绑定。
      // 但对于陪诊派单标准模板（陪诊人与电话均非空），精准通过正文 source_order_no 关联当前消息
      if (!finalOrderId) {
        const escortMatch = parseEscortDispatchTemplate(contentText)
        if (escortMatch.matched && escortMatch.sourceOrderNo) {
          const matchedOrder = await prisma.order.findFirst({
            where: { sourceOrderNo: { equals: escortMatch.sourceOrderNo, mode: 'insensitive' } },
            select: { id: true, rawJson: true }
          })
          if (matchedOrder) {
            finalOrderId = matchedOrder.id
            finalApplicationNo = applicationNosForConversationMatch(matchedOrder.rawJson)[0] ?? null
            _debug.matchMethod = 'escort_dispatch_template'
            _debug.matchedOrderId = matchedOrder.id
            _debug.matchedApplicationNo = finalApplicationNo
          }
        }
      }

      if (!finalOrderId) {
        const cand = extractOrderCandidate(orderNoCandidate) ?? extractOrderCandidate(conversationName)
        if (cand) {
          _debug.candidate = cand.raw
          const matched = await resolveApplicationForCandidate(
            employeeId,
            channel,
            conversationName,
            cand.raw,
            cand.kind,
            screenshotOssKey ?? null,
            new Date(capturedAt)
          )
          if (matched) {
            finalApplicationNo = matched.applicationNo
            finalOrderId = matched.orderId
            _debug.matchMethod = 'application_no'
            _debug.matchedApplicationNo = matched.applicationNo
            _debug.matchedOrderId = matched.orderId
          } else {
            _debug.matchMethod = 'unmatched_ref'
            _debug.reason = 'application_no_not_found'
          }
        } else {
          _debug.matchMethod = 'no_candidate'
        }
      } else {
        _debug.matchMethod = 'provided'
        _debug.matchedOrderId = finalOrderId
        _debug.matchedApplicationNo = finalApplicationNo
      }

      const content = contentText.trim()
      if (!content) return reply.status(400).send({ error: 'contentText 不能为空' })
      const capAt = new Date(capturedAt)
      const senderType = 'other'
      const normalized = normalizeMessageContentForDedupe(content)
      const contentHash = hashDedupePart(normalized)
      const dedupeScope = finalApplicationNo
        ? `application:${finalApplicationNo}`
        : `conversation:${normalizeConversationNameForDedupe(conversationName)}`
      const dedupeKey = hashDedupePart(`${employeeId}|${channel}|${dedupeScope}|${senderType}|${contentHash}`)
      const legacyNormalized = content.replace(/\s+/g, '')
      const legacyContentHash = hashDedupePart(legacyNormalized)
      const legacyDedupeKey = hashDedupePart(`${employeeId}|${conversationName}|${senderType}|${legacyContentHash}`)

      const existing = await prisma.message.findUnique({
        where: { dedupeKey },
        select: { id: true, orderId: true, applicationNo: true }
      }) ?? await prisma.message.findUnique({
        where: { dedupeKey: legacyDedupeKey },
        select: { id: true, orderId: true, applicationNo: true }
      })

      const message = existing
        ? await prisma.message.update({
            where: { id: existing.id },
            data: {
              seenCount: { increment: 1 },
              lastSeenAt: capAt,
              orderId: existing.orderId ?? finalOrderId,
              applicationNo: existing.applicationNo ?? finalApplicationNo,
              contentHash,
              dedupeKey
            }
          })
        : await prisma.message.create({
            data: {
              orderId: finalOrderId,
              applicationNo: finalApplicationNo,
              channel,
              conversationName,
              senderName: senderName ?? null,
              senderType,
              contentText: content,
              screenshotOssKey: screenshotOssKey ?? null,
              capturedAt: capAt,
              employeeId,
              sortTime: capAt,
              contentHash,
              dedupeKey,
              seenCount: 1,
              firstSeenAt: capAt,
              lastSeenAt: capAt
            }
          })

      return reply.send({ data: message, _debug })
    } catch (err: any) {
      fastify.log.error('微信消息上报失败:', err)
      return reply.status(500).send({ error: '微信消息上报失败: ' + err.message })
    }
  })

  // 8.2 待确认订单号引用 —— 截图标题里有订单号(COD/fwyy…)但解析不到订单，存这里给员工/客户确认。
  //     UI 由另一端开发，这里提供：列出 / 确认绑定 / 忽略 三个接口。详见 docs/订单号待确认_交接说明.md
  // 列表（当前员工，默认只看 pending）
  fastify.get<{ Querystring: { status?: string } }>('/api/v1/unmatched-order-refs', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const status = request.query.status || 'pending'
    const rows = await prisma.unmatchedOrderRef.findMany({
      where: { employeeId: request.employee.id, status },
      orderBy: { updatedAt: 'desc' }
    })
    const allOrderIds = new Set<number>()
    for (const r of rows) {
      const ids = (r.candidateOrderIds as unknown as number[] | null) ?? []
      for (const id of ids) if (typeof id === 'number') allOrderIds.add(id)
    }
    const candidateOrders = allOrderIds.size
      ? await prisma.order.findMany({
          where: { id: { in: [...allOrderIds] }, assignedEmployeeId: request.employee.id },
          select: { id: true, sourceOrderNo: true, customerName: true, status: true, rawJson: true }
        })
      : []
    const candidateMap = new Map(candidateOrders.map((o) => [o.id, o]))
    return reply.send({
      data: rows.map((r) => {
        const ids = (r.candidateOrderIds as unknown as number[] | null) ?? []
        return {
          ...r,
          candidateOrders: ids.map((id) => candidateMap.get(id)).filter(Boolean).map((o) => ({
            id: o!.id,
            sourceOrderNo: o!.sourceOrderNo,
            customerName: o!.customerName,
            status: o!.status,
            applicationNo: ((o!.rawJson ?? {}) as Record<string, unknown>).crmApplyNo ?? null,
            ccodApplyNo: ((o!.rawJson ?? {}) as Record<string, unknown>).applyNo ?? null
          }))
        }
      })
    })
  })

  // 确认：把某条待确认绑定到指定订单（同时回填该会话下未关联的消息到该订单）
  fastify.post<{ Params: { id: string }; Body: { orderId: number } }>(
    '/api/v1/unmatched-order-refs/:id/confirm',
    async (request, reply) => {
      if (!request.employee) return reply.status(401).send({ error: '未登录' })
      const id = parseInt(request.params.id, 10)
      const { orderId } = request.body || ({} as { orderId: number })
      if (!Number.isFinite(orderId)) return reply.status(400).send({ error: 'orderId 必填' })

      const ref = await prisma.unmatchedOrderRef.findUnique({ where: { id } })
      if (!ref || ref.employeeId !== request.employee.id) {
        return reply.status(404).send({ error: '记录不存在' })
      }
      const order = await prisma.order.findUnique({ where: { id: orderId } })
      if (!order) return reply.status(404).send({ error: '订单不存在' })
      if (order.assignedEmployeeId !== request.employee.id) {
        return reply.status(403).send({ error: '不能确认到其他员工的订单' })
      }

      const applicationNo = applicationNosForConversationMatch(order.rawJson)[0] ?? null
      const applicationOrderCount = applicationNo
        ? await prisma.order.count({ where: { rawJson: { path: ['crmApplyNo'], equals: applicationNo } } })
        : 0
      const compatibleOrderId = !applicationNo || applicationOrderCount === 1 ? orderId : null
      await prisma.unmatchedOrderRef.update({
        where: { id },
        data: { status: 'confirmed', resolvedOrderId: orderId, resolvedApplicationNo: applicationNo }
      })
      // 回填：该员工、该会话名下、还没关联申请号/订单的消息，挂到确认的申请号/订单上
      const backfilled = await prisma.message.updateMany({
        where: { employeeId: ref.employeeId, conversationName: ref.conversationName, applicationNo: null, orderId: null },
        data: { orderId: compatibleOrderId, applicationNo }
      })
      return reply.send({ data: { ok: true, applicationNo, orderId: compatibleOrderId, backfilledMessages: backfilled.count } })
    }
  )

  // 忽略：标记为 rejected（不是客户会话 / 不需要绑定）
  fastify.post<{ Params: { id: string } }>(
    '/api/v1/unmatched-order-refs/:id/reject',
    async (request, reply) => {
      if (!request.employee) return reply.status(401).send({ error: '未登录' })
      const id = parseInt(request.params.id, 10)
      const ref = await prisma.unmatchedOrderRef.findUnique({ where: { id } })
      if (!ref || ref.employeeId !== request.employee.id) {
        return reply.status(404).send({ error: '记录不存在' })
      }
      await prisma.unmatchedOrderRef.update({ where: { id }, data: { status: 'rejected' } })
      return reply.send({ data: { ok: true } })
    }
  )

  // ──────────────── 8.3 订单跟进提醒与桌面通知 ────────────────
  // 列表（当前员工，支持按 orderNo 或 status 过滤）
  fastify.get<{ Querystring: { status?: string; orderNo?: string } }>('/api/v1/order-reminders', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const { status, orderNo } = request.query
    const employeeId = request.employee.id

    const conditions: string[] = ['employee_id = $1']
    const params: any[] = [employeeId]

    if (status && status !== 'all') {
      if (status === 'pending') {
        conditions.push(`status IN ('pending', 'unread')`)
        // 日常录音上传提醒具有当天时效性，跨天自动失效，不查询历史往日的日常提醒
        conditions.push(`NOT (type = 'upload_recording' AND remind_time < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date)`)
      } else {
        params.push(status)
        conditions.push(`status = $${params.length}`)
      }
    }
    if (orderNo) {
      params.push(orderNo)
      conditions.push(`order_no = $${params.length}`)
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const sql = `SELECT * FROM order_reminders ${whereClause} ORDER BY remind_time ASC, id DESC`
    
    try {
      const rows = await (prisma as any).$queryRawUnsafe(sql, ...params)
      return reply.send({ data: rows })
    } catch (err: any) {
      fastify.log.error('查询提醒失败:', err)
      return reply.status(500).send({ error: '查询提醒列表失败: ' + err.message })
    }
  })

  // 新建手工提醒
  fastify.post<{ Body: { orderNo: string; remindTime: string; content: string; type?: string; extraData?: any } }>(
    '/api/v1/order-reminders',
    async (request, reply) => {
      if (!request.employee) return reply.status(401).send({ error: '未登录' })
      const employeeId = request.employee.id
      const { orderNo, remindTime, content, type = 'manual', extraData = null } = request.body || {}

      if (!orderNo || !remindTime || !content) {
        return reply.status(400).send({ error: 'orderNo、remindTime 和 content 均为必填项' })
      }

      const parsedRemindTime = new Date(remindTime)
      if (isNaN(parsedRemindTime.getTime())) {
        return reply.status(400).send({ error: 'remindTime 格式非法' })
      }

      try {
        const insertSql = `
          INSERT INTO order_reminders (order_no, employee_id, type, content, remind_time, status, extra_data, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, 'pending', $6::jsonb, NOW(), NOW())
          RETURNING *;
        `
        const rows = await (prisma as any).$queryRawUnsafe(
          insertSql,
          orderNo,
          employeeId,
          type,
          content,
          parsedRemindTime,
          extraData ? JSON.stringify(extraData) : null
        )
        return reply.send({ data: rows[0] })
      } catch (err: any) {
        fastify.log.error('创建提醒失败:', err)
        return reply.status(500).send({ error: '创建提醒失败: ' + err.message })
      }
    }
  )

  // 延后提醒（默认延后 10 分钟）
  fastify.post<{ Params: { id: string }; Body?: { minutes?: number } }>(
    '/api/v1/order-reminders/:id/snooze',
    async (request, reply) => {
      if (!request.employee) return reply.status(401).send({ error: '未登录' })
      const id = parseInt(request.params.id, 10)
      const minutes = Number(request.body?.minutes) || 10
      const employeeId = request.employee.id

      try {
        const updateSql = `
          UPDATE order_reminders 
          SET remind_time = NOW() + ($1 || ' minutes')::INTERVAL, 
              status = 'pending', 
              updated_at = NOW()
          WHERE id = $2 AND employee_id = $3
          RETURNING *;
        `
        const rows = await (prisma as any).$queryRawUnsafe(updateSql, String(minutes), id, employeeId)
        if (!rows || rows.length === 0) {
          return reply.status(404).send({ error: '提醒不存在或无权操作' })
        }
        return reply.send({ data: rows[0] })
      } catch (err: any) {
        fastify.log.error('延后提醒失败:', err)
        return reply.status(500).send({ error: '延后提醒失败: ' + err.message })
      }
    }
  )

  // 标记提醒已完成
  fastify.post<{ Params: { id: string } }>(
    '/api/v1/order-reminders/:id/done',
    async (request, reply) => {
      if (!request.employee) return reply.status(401).send({ error: '未登录' })
      const id = parseInt(request.params.id, 10)
      const employeeId = request.employee.id

      try {
        const updateSql = `
          UPDATE order_reminders 
          SET status = 'done', updated_at = NOW()
          WHERE id = $1 AND employee_id = $2
          RETURNING *;
        `
        const rows = await (prisma as any).$queryRawUnsafe(updateSql, id, employeeId)
        if (!rows || rows.length === 0) {
          return reply.status(404).send({ error: '提醒不存在或无权操作' })
        }
        return reply.send({ data: rows[0] })
      } catch (err: any) {
        fastify.log.error('完成提醒失败:', err)
        return reply.status(500).send({ error: '完成提醒失败: ' + err.message })
      }
    }
  )

  // 删除手工提醒
  fastify.delete<{ Params: { id: string } }>(
    '/api/v1/order-reminders/:id',
    async (request, reply) => {
      if (!request.employee) return reply.status(401).send({ error: '未登录' })
      const id = parseInt(request.params.id, 10)
      const employeeId = request.employee.id

      try {
        await (prisma as any).$queryRawUnsafe(
          'DELETE FROM order_reminders WHERE id = $1 AND employee_id = $2;',
          id,
          employeeId
        )
        return reply.send({ data: { ok: true } })
      } catch (err: any) {
        fastify.log.error('删除提醒失败:', err)
        return reply.status(500).send({ error: '删除提醒失败: ' + err.message })
      }
    }
  )

  // 顶部通知统计（获取待办提醒数、待确认单号数）
  fastify.get('/api/v1/notifications/summary', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const employeeId = request.employee.id

    try {
      const reminderCountRes: any = await (prisma as any).$queryRawUnsafe(
        "SELECT COUNT(*)::int AS count FROM order_reminders WHERE employee_id = $1 AND status = 'pending';",
        employeeId
      )
      const remindersCount = Number(reminderCountRes?.[0]?.count || 0)

      const unmatchedCount = await prisma.unmatchedOrderRef.count({
        where: { employeeId, status: 'pending' }
      })

      return reply.send({
        data: {
          remindersCount,
          unmatchedRefsCount: unmatchedCount
        }
      })
    } catch (err: any) {
      fastify.log.error('查询通知统计失败:', err)
      return reply.status(500).send({ error: '查询通知统计失败: ' + err.message })
    }
  })

  // 8.4 整帧上报（新链路）——sidecar 出结构化、tray 逐帧转发全部 messages（含 system），
  //     后端做跨帧单消息去重 + 订单关联（+ 时间链 chatTime 在后续步骤填）。
  //     去重键 = 员工+会话名+说话人+内容哈希；命中只累加 seenCount，不重复入库/进时间线。
  //     与旧的逐条 /api/v1/messages 暂时并存：tray 切到本接口后再废弃旧接口。
  interface CaptureFrameBody {
    channel: string
    conversationName: string
    orderNoCandidate?: string
    screenshotOssKey?: string
    capturedAt: string
    messages: Array<{ speaker: string; name?: string | null; text: string; kind?: string | null }>
  }

  // 客户会话归属：标题候选号只匹配申请号字段 rawJson.crmApplyNo。
  // 返回申请号，以及仅当该申请号下只有 1 单时的兼容 orderId。
  async function resolveApplicationForConversation(
    employeeId: number,
    channel: string,
    conversationName: string,
    orderNoCandidate: string | undefined,
    screenshotOssKey: string | null,
    capturedAt: Date
  ): Promise<ApplicationMatch | null> {
    const cand = extractOrderCandidate(orderNoCandidate) ?? extractOrderCandidate(conversationName)
    if (!cand) return null
    return resolveApplicationForCandidate(
      employeeId,
      channel,
      conversationName,
      cand.raw,
      cand.kind,
      screenshotOssKey,
      capturedAt
    )
  }

  fastify.post<{ Body: CaptureFrameBody }>('/api/v1/capture/frame', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录或缺少工号' })
    const employeeId = request.employee.id
    const { channel, conversationName, orderNoCandidate, screenshotOssKey, capturedAt, messages } = request.body
    if (!Array.isArray(messages)) return reply.status(400).send({ error: 'messages 必填且为数组' })
    const capAt = new Date(capturedAt)

    // 申请号归属：整帧只算一次
    const applicationMatch = await resolveApplicationForConversation(
      employeeId, channel, conversationName, orderNoCandidate, screenshotOssKey ?? null, capAt
    )
    const orderId = applicationMatch?.orderId ?? null
    const applicationNo = applicationMatch?.applicationNo ?? null

    let created = 0
    let merged = 0
    // 时间链：messages 已是屏幕从上到下的顺序；遇到时间锚点(system:time)就更新 anchor，
    // 其下方的消息 chatTime = 最近一个 anchor（往上翻看的历史消息靠它定位真实时间）。
    let anchor: Date | null = null
    for (const m of messages) {
      const content = (m.text ?? '').trim()
      if (!content) continue
      const senderType = m.speaker === 'self' || m.speaker === 'system' ? m.speaker : 'other'
      let chatTime: Date | null = anchor
      if (senderType === 'system' && m.kind === 'time') {
        const parsed = parseChatTime(content, capAt)
        if (parsed) {
          anchor = parsed
          chatTime = parsed
        }
      }
      let itemOrderId = orderId
      let itemApplicationNo = applicationNo
      if (!itemOrderId) {
        const escortMatch = parseEscortDispatchTemplate(content)
        if (escortMatch.matched && escortMatch.sourceOrderNo) {
          const matchedOrder = await prisma.order.findFirst({
            where: { sourceOrderNo: { equals: escortMatch.sourceOrderNo, mode: 'insensitive' } },
            select: { id: true, rawJson: true }
          })
          if (matchedOrder) {
            itemOrderId = matchedOrder.id
            itemApplicationNo = applicationNosForConversationMatch(matchedOrder.rawJson)[0] ?? null
          }
        }
      }

      const normalized = normalizeMessageContentForDedupe(content)
      const contentHash = hashDedupePart(normalized)
      const dedupeScope = itemApplicationNo
        ? `application:${itemApplicationNo}`
        : `conversation:${normalizeConversationNameForDedupe(conversationName)}`
      const dedupeKey = hashDedupePart(`${employeeId}|${channel}|${dedupeScope}|${senderType}|${contentHash}`)

      // 兼容旧 key：老数据按 employee+conversationName+senderType+去空白内容 去重，且没有 channel/applicationNo。
      // 命中旧记录时把它迁到新 key，避免部署后同一条旧消息被重新插入一次。
      const legacyNormalized = content.replace(/\s+/g, '')
      const legacyContentHash = hashDedupePart(legacyNormalized)
      const legacyDedupeKey = hashDedupePart(`${employeeId}|${conversationName}|${senderType}|${legacyContentHash}`)

      const existing = await prisma.message.findUnique({
        where: { dedupeKey },
        select: { id: true, orderId: true, applicationNo: true, chatTime: true }
      }) ?? await prisma.message.findUnique({
        where: { dedupeKey: legacyDedupeKey },
        select: { id: true, orderId: true, applicationNo: true, chatTime: true }
      })
      if (existing) {
        // 跨帧重复：累加次数 + 刷新最近时刻；订单/时间后补（之前没算出来、这次算出来了就补上）
        await prisma.message.update({
          where: { id: existing.id },
          data: {
            seenCount: { increment: 1 },
            lastSeenAt: capAt,
            orderId: existing.orderId ?? itemOrderId,
            applicationNo: existing.applicationNo ?? itemApplicationNo,
            contentHash,
            dedupeKey,
            chatTime: existing.chatTime ?? chatTime,
            // 之前没算出真实时间、这次算出来了 → 把排序键从 capturedAt 升级成真实 chatTime
            ...(existing.chatTime == null && chatTime != null ? { sortTime: chatTime } : {})
          }
        })
        merged++
      } else {
        await prisma.message.create({
          data: {
            orderId: itemOrderId,
            applicationNo: itemApplicationNo,
            channel,
            conversationName,
            senderName: m.name ?? null,
            contentText: content,
            screenshotOssKey: screenshotOssKey ?? null,
            capturedAt: capAt,
            employeeId,
            senderType,
            kind: senderType === 'system' ? (m.kind ?? 'other') : null,
            chatTime,
            sortTime: chatTime ?? capAt, // 排序键：有真实聊天时间用它，否则退回截图时刻
            contentHash,
            dedupeKey,
            seenCount: 1,
            firstSeenAt: capAt,
            lastSeenAt: capAt
          }
        })
        created++
      }
    }
    return reply.send({ data: { orderId, applicationNo, created, merged } })
  })

  interface CaptureDiagnosticImageBody {
    applicationNo: string
    channel: string
    conversationName: string
    capturedAt: string
    mimeType: string
    imageBase64: string
  }

  // 临时诊断图片：不参与消息去重，只保存客户端明确选中的一张图片及业务元数据。
  fastify.post<{ Body: CaptureDiagnosticImageBody }>('/api/v1/capture/diagnostic-image', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录或缺少工号' })
    const body = request.body
    if (!body || typeof body !== 'object') return reply.status(400).send({ error: '请求体不能为空' })
    const applicationNo = String(body.applicationNo ?? '').trim()
    const channel = String(body.channel ?? '').trim()
    const conversationName = String(body.conversationName ?? '').trim()
    const mimeType = String(body.mimeType ?? '').trim().toLowerCase()
    const capturedAt = new Date(body.capturedAt)
    if (!applicationNo || !channel || !conversationName || Number.isNaN(capturedAt.getTime())) {
      return reply.status(400).send({ error: 'applicationNo、channel、conversationName、capturedAt 必填且合法' })
    }
    if (!/^image\/(png|jpeg|jpg|bmp|webp)$/.test(mimeType)) {
      return reply.status(400).send({ error: 'mimeType 必须是支持的图片类型' })
    }
    if (typeof body.imageBase64 !== 'string' || !body.imageBase64.trim()) {
      return reply.status(400).send({ error: 'imageBase64 必填' })
    }

    let image: Buffer
    try {
      image = Buffer.from(body.imageBase64, 'base64')
    } catch {
      return reply.status(400).send({ error: '图片内容不是合法 base64' })
    }
    if (image.length === 0) return reply.status(400).send({ error: '图片内容为空' })
    if (image.length > 18 * 1024 * 1024) return reply.status(413).send({ error: '图片不能超过 18MB' })

    const minioBucket = 'capture-diagnostics'
    const extension = mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? 'jpg' : mimeType.slice('image/'.length)
    const safeApplicationNo = encodeURIComponent(applicationNo)
    const safeConversationName = encodeURIComponent(conversationName).slice(0, 180)
    const timestamp = capturedAt.toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
    const minioKey = `capture-diagnostics/emp-${request.employee.id}__app-${safeApplicationNo}__at-${timestamp}__channel-${channel}__conv-${safeConversationName}__${randomUUID()}.${extension}`
    try {
      await minioClient.putObject(minioBucket, minioKey, image, image.length, { 'Content-Type': mimeType })
      return reply.send({ data: { objectKey: minioKey, applicationNo, capturedAt: capturedAt.toISOString() } })
    } catch (error: any) {
      await minioClient.removeObject(minioBucket, minioKey).catch(() => undefined)
      fastify.log.error('诊断图片上传失败:', error)
      return reply.status(500).send({ error: '诊断图片上传失败: ' + error.message })
    }
  })

  // 8.3 关键信息抽取（路线1 的 AI 环节）—— 后端调百炼文本 LLM，从"带说话人的对话"抽可回填关键字段。
  //     接口已建好、可独立调（body 直接传 messages），但不自动触发（先测 sidecar 结构化效果）。
  //     说话人已由 sidecar 用 OCR+颜色确定性判好，这里只做文本抽取，不用 VLM。
  fastify.post<{
    Body: { messages: KeyInfoMessage[]; orderContext?: KeyInfoContext }
  }>('/api/v1/ai/extract-key-info', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const { messages, orderContext } = request.body || ({} as { messages: KeyInfoMessage[] })
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.status(400).send({ error: 'messages 必填且非空' })
    }
    try {
      const result = await extractKeyInfo(messages, orderContext)
      return reply.send({ data: result })
    } catch (e: any) {
      fastify.log.error('关键信息抽取失败: ' + e.message)
      return reply.status(500).send({ error: '关键信息抽取失败: ' + e.message })
    }
  })

  // 8.4 消息结构化（路线1 的"解释层"）—— OCR 词块(含气泡颜色样本) → 带说话人的消息列表。
  //     纯函数、无状态：每帧自带输入、输出仅依赖本帧，多员工并发天然隔离不串。
  //     算法从 sidecar(C#)挪到后端(TS)，便于热更新/测试，且不必上传图片(只传词块+颜色样本)。
  fastify.post<{ Body: StructInput }>('/api/v1/capture/structure', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const body = request.body
    if (!body || !Array.isArray(body.blocks)) {
      return reply.status(400).send({ error: 'blocks 必填' })
    }
    try {
      const messages = structureMessages(body)
      return reply.send({ data: { messages } })
    } catch (e: any) {
      fastify.log.error('消息结构化失败: ' + e.message)
      return reply.status(500).send({ error: '消息结构化失败: ' + e.message })
    }
  })

  // 8.45 订单 AI 滚动简报 —— 手动刷新（员工点"刷新简报"按钮）。综合该订单的微信/企微消息 +
  //      通话/录音转写，一次 LLM 调用产出 摘要/阶段/待办/风险 + 回填关键信息。增量(基于上一版简报)。
  //      自动触发由扫描器负责(静默5min/攒够10条)；这里是手动兜底，force=true 强制重算。
  fastify.post<{ Params: { id: string } }>('/api/v1/orders/:id/brief/refresh', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const id = parseInt(request.params.id, 10)
    if (!Number.isFinite(id)) return reply.status(400).send({ error: 'id 非法' })
    try {
      const result = await refreshOrderBrief(prisma, minioClient, id, { force: true })
      if (!result) return reply.status(404).send({ error: '订单不存在' })
      return reply.send({ data: result.brief })
    } catch (e: any) {
      fastify.log.error('订单简报刷新失败: ' + e.message)
      return reply.status(500).send({ error: '订单简报刷新失败: ' + e.message })
    }
  })

  // 8.46 读订单 AI 简报（已存的 aiBriefJson，不触发 LLM）。详情页打开时调。
  fastify.get<{ Params: { id: string } }>('/api/v1/orders/:id/brief', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const id = parseInt(request.params.id, 10)
    if (!Number.isFinite(id)) return reply.status(400).send({ error: 'id 非法' })
    const order = await prisma.order.findUnique({
      where: { id },
      select: { aiBriefJson: true, briefUpdatedAt: true }
    })
    if (!order) return reply.status(404).send({ error: '订单不存在' })
    return reply.send({ data: { brief: order.aiBriefJson ?? null, updatedAt: order.briefUpdatedAt } })
  })

  // 8.46a 读取本订单最新、尚未采用的 AI 字段候选。正式寰宇字段始终优先，前端仅在
  // 正式字段为空时用这些候选值展示；点击保存才会写入 HY_FACT_DDCX_NEW。
  fastify.get<{ Params: { id: string } }>('/api/v1/orders/:id/ai-field-candidates', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const orderId = parseInt(request.params.id, 10)
    if (!Number.isFinite(orderId)) return reply.status(400).send({ error: '订单ID非法' })
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } })
    if (!order) return reply.status(404).send({ error: '订单不存在' })
    const rows = await prisma.$queryRaw<Array<{
      id: bigint
      field_code: string
      field_label: string
      value_text: string
      normalized_value_json: unknown
      candidate_type: string
      confidence: number
      requires_confirmation: boolean
      evidence_json: unknown
      created_at: Date
    }>>`
      SELECT DISTINCT ON (field_code)
        id, field_code, field_label, value_text, normalized_value_json, candidate_type, confidence,
        requires_confirmation, evidence_json, created_at
      FROM b_order_ai_field_candidates
      WHERE order_id = ${orderId} AND status = 'pending'
      ORDER BY field_code, created_at DESC, id DESC
    `
    return reply.send({ data: rows.map((row) => ({
      id: Number(row.id), fieldCode: row.field_code, fieldLabel: row.field_label,
      value: row.value_text, normalizedValue: row.normalized_value_json, candidateType: row.candidate_type,
      confidence: Number(row.confidence), requiresConfirmation: row.requires_confirmation,
      evidence: row.evidence_json, createdAt: row.created_at.toISOString()
    })) })
  })

  // 8.47 申请级 AI 沟通总结 —— 综合同一申请号下微信/企微消息 + 通话录音转写。
  fastify.post<{ Params: { applicationNo: string } }>('/api/v1/applications/:applicationNo/brief/refresh', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const applicationNo = decodeURIComponent(request.params.applicationNo || '').trim()
    if (!applicationNo) return reply.status(400).send({ error: 'applicationNo 必填' })
    try {
      const result = await refreshApplicationBrief(prisma, applicationNo, { force: true })
      return reply.send({ data: result.brief })
    } catch (e: any) {
      fastify.log.error('申请级沟通总结刷新失败: ' + e.message)
      return reply.status(500).send({ error: '申请级沟通总结刷新失败: ' + e.message })
    }
  })

  fastify.get<{ Params: { applicationNo: string } }>('/api/v1/applications/:applicationNo/brief', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const applicationNo = decodeURIComponent(request.params.applicationNo || '').trim()
    if (!applicationNo) return reply.status(400).send({ error: 'applicationNo 必填' })
    const brief = await prisma.applicationBrief.findUnique({
      where: { applicationNo },
      select: { briefJson: true, briefUpdatedAt: true }
    })
    return reply.send({ data: { brief: brief?.briefJson ?? null, updatedAt: brief?.briefUpdatedAt ?? null } })
  })

  // 8.5 通话列表 GET /api/v1/calls （当前员工，按时间倒序）
  //
  // 关联订单策略（不依赖 LLM）：
  //   实时按 call.phone 在当前员工所有订单里找匹配，匹配源：
  //     - Order.customerPhone（DB 列，目前 ORDERS_SYNCED 不写，多为 null）
  //     - detail_json.recommendations.paMobile / ecpPhone（chrome 插件详情）
  //   匹配上几条就返回几条（一般 1 条，偶尔 0 或多条），
  //   响应里用 relatedOrders: Order[]。Call.orderId（兜底单一关联）仍然返回。
  fastify.get('/api/v1/calls', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const employeeId = request.employee.id
    try {
      const calls = await prisma.call.findMany({
        where: { employeeId },
        orderBy: { startedAt: 'desc' }
      })
      // 一次拉当前员工所有订单的"任意可匹配电话 + 基础字段"，内存里 join 给每条 call
      const orders = await prisma.$queryRaw<
        Array<{
          id: number
          source_order_no: string
          customer_name: string
          status: string
          updated_at: Date
          application_no: string | null
          phone_list: string[] | null
        }>
      >`
        SELECT
          id,
          source_order_no,
          customer_name,
          status,
          updated_at,
          raw_json->>'crmApplyNo' AS application_no,
          ARRAY_REMOVE(ARRAY[
            customer_phone,
            detail_json->'recommendations'->>'paMobile',
            detail_json->'recommendations'->>'ecpPhone'
          ], NULL) AS phone_list
        FROM orders
        WHERE assigned_employee_id = ${employeeId}
      `
      // 反查表：phone（去尾号清洗）→ 匹配的订单
      const norm = (s: string | null | undefined): string => (s ?? '').replace(/\D/g, '')
      const phoneIndex = new Map<string, typeof orders>()
      for (const o of orders) {
        for (const p of o.phone_list ?? []) {
          const k = norm(p)
          if (!k) continue
          const arr = phoneIndex.get(k) ?? []
          arr.push(o)
          phoneIndex.set(k, arr)
        }
      }
      const toOrderBrief = (o: (typeof orders)[number]): {
        id: number
        sourceOrderNo: string
        customerName: string
        status: string
        applicationNo: string | null
      } => ({
        id: o.id,
        sourceOrderNo: o.source_order_no,
        customerName: o.customer_name,
        status: o.status,
        applicationNo: o.application_no
      })

      const data = calls.map((c) => {
        const matched = (phoneIndex.get(norm(c.phone)) ?? []).sort(
          (a, b) => b.updated_at.getTime() - a.updated_at.getTime()
        )
        const related = matched.map(toOrderBrief)
        // 兜底单 order：取 updated_at 最新的那个（最近被泰康改动过的）
        const primary = related[0] ?? null
        return {
          id: c.id,
          phone: c.phone,
          contactName: c.contactName,
          direction: c.direction,
          callStatus: c.callStatus,
          durationSec: c.durationSec,
          startedAt: c.startedAt.toISOString(),
          asrStatus: c.asrStatus,
          asrFinishedAt: c.asrFinishedAt?.toISOString() ?? null,
          hasRecording: !!c.recordingOssKey,
          applicationNo: c.applicationNo,
          order: primary, // 兼容旧字段（单 order）
          relatedOrders: related // 新：按手机号匹配到的全部订单
        }
      })
      return reply.send({ data })
    } catch (err: any) {
      fastify.log.error('查询通话列表失败:', err)
      return reply.status(500).send({ error: '查询通话列表失败: ' + err.message })
    }
  })

  // 8.6 录音 presigned GET URL  GET /api/v1/calls/:id/recording-url
  fastify.get<{ Params: { id: string } }>('/api/v1/calls/:id/recording-url', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const callId = parseInt(request.params.id, 10)
    try {
      const call = await prisma.call.findUnique({ where: { id: callId } })
      if (!call) return reply.status(404).send({ error: '通话记录不存在' })
      if (call.employeeId !== request.employee.id) {
        return reply.status(403).send({ error: '不能查看他人的通话录音' })
      }
      if (!call.recordingOssKey) {
        return reply.status(404).send({ error: '该通话尚未上传录音' })
      }
      const playback = await getRecordingPlaybackInfo(
        minioClient,
        minioPublicClient,
        env.minioBucketRecordings,
        call.id,
        call.recordingOssKey
      )
      return reply.send({ data: playback })
    } catch (err: any) {
      fastify.log.error('获取录音 URL 失败:', err)
      return reply.status(500).send({ error: '获取录音 URL 失败: ' + err.message })
    }
  })

  // 8.7 通话的 AI 分析 GET /api/v1/calls/:id/ai-summary
  // 返回该通话最新一条 AiSummary（type='call'）。LLM 模块由用户另行实现，
  // 只要把分析结果 INSERT 进 ai_summaries 表，本接口即可读出来展示。
  fastify.get<{ Params: { id: string } }>('/api/v1/calls/:id/ai-summary', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const callId = parseInt(request.params.id, 10)
    try {
      const call = await prisma.call.findUnique({ where: { id: callId } })
      if (!call) return reply.status(404).send({ error: '通话记录不存在' })
      const summary = await prisma.aiSummary.findFirst({
        where: { callId, type: 'call' },
        orderBy: { createdAt: 'desc' }
      })
      return reply.send({
        data: summary
          ? {
              id: summary.id,
              content: summary.content,
              model: summary.model,
              inferredOrderId: summary.orderId,
              createdAt: summary.createdAt.toISOString()
            }
          : null
      })
    } catch (err: any) {
      fastify.log.error('查询通话 AI 分析失败:', err)
      return reply.status(500).send({ error: '查询通话 AI 分析失败: ' + err.message })
    }
  })

  // 8.8 移动端通话号码预匹配 POST /api/v1/calls/match
  // 隐私规则：移动端先只提交号码；只有命中任一订单联系人电话时，才允许继续上传完整通话记录。
  fastify.post<{ Body: { phone?: string } }>('/api/v1/calls/match', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const phone = request.body?.phone ?? ''
    try {
      markMobileSeen(request.employee.id, 'phone_match')
      const matched = await matchOrderByPhone(phone)
      if (!matched) {
        return reply.send({ data: { matched: false } })
      }
      return reply.send({
        data: {
          matched: true,
          order: {
            id: matched.id,
            sourceOrderNo: matched.source_order_no,
            customerName: matched.customer_name,
            status: matched.status
          }
        }
      })
    } catch (err: any) {
      fastify.log.error('通话号码匹配失败:', err)
      return reply.status(500).send({ error: '通话号码匹配失败: ' + err.message })
    }
  })

  // 8.9 移动端录音反查通话 POST /api/v1/calls/lookup
  // App 长时间未运行或本地通话缓存被裁剪后，仍可按当前员工 + 号码 + 时间找回 callId。
  fastify.post<{ Body: { phone?: string; startedAtMillis?: number } }>(
    '/api/v1/calls/lookup',
    async (request, reply) => {
      if (!request.employee) return reply.status(401).send({ error: '未登录' })
      const phone = (request.body?.phone ?? '').replace(/\D/g, '')
      const startedAtMillis = Number(request.body?.startedAtMillis)
      if (!phone || !Number.isFinite(startedAtMillis) || startedAtMillis <= 0) {
        return reply.status(400).send({ error: 'phone 和 startedAtMillis 必填且有效' })
      }

      const windowMs = 10 * 60_000
      const candidates = await prisma.call.findMany({
        where: {
          employeeId: request.employee.id,
          startedAt: {
            gte: new Date(startedAtMillis - windowMs),
            lte: new Date(startedAtMillis + windowMs)
          }
        }
      })
      const matched = candidates
        .filter((call) => call.phone.replace(/\D/g, '') === phone)
        .sort(
          (a, b) =>
            Math.abs(a.startedAt.getTime() - startedAtMillis) -
            Math.abs(b.startedAt.getTime() - startedAtMillis)
        )[0]

      return reply.send({ data: matched ?? null })
    }
  )

  // 9. 上报通话记录 POST /api/v1/calls
  fastify.post<{ Body: CreateCallPayload }>('/api/v1/calls', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const employeeId = request.employee.id
      const { phone, contactName, direction, callStatus, durationSec, startedAt, orderId } = request.body

      try {
        markMobileSeen(employeeId, 'call_upload')
        let finalOrderId = orderId ?? null

      // 隐私规则：通话必须命中任一订单联系人电话才入库。
      // 未命中时拒绝保存，避免员工私人电话进入后端。
      const matched = await matchOrderByPhone(phone)
      if (!matched) {
        return reply.status(422).send({ error: '通话号码未命中任何订单联系人，已拒绝入库' })
      }
      if (finalOrderId && finalOrderId !== matched.id) {
        return reply.status(422).send({ error: '通话号码与指定订单不匹配，已拒绝入库' })
      }
      const finalApplicationNo = matched.application_no ?? null
      if (finalApplicationNo) {
        const applicationOrderCount = await prisma.order.count({
          where: { rawJson: { path: ['crmApplyNo'], equals: finalApplicationNo } }
        })
        finalOrderId = applicationOrderCount === 1 ? matched.id : null
      } else {
        finalOrderId = matched.id
      }
      fastify.log.info(
        `自动关联通话至申请号: ${finalApplicationNo ?? '-'} (orderId=${finalOrderId ?? 'multi-or-none'})`
      )

      const startedAtDate = new Date(startedAt)
      const existingCall = await prisma.call.findFirst({
        where: {
          employeeId,
          phone,
          direction,
          startedAt: startedAtDate
        }
      })
      if (existingCall) {
        const needsUpdate =
          (existingCall.orderId == null && finalOrderId != null) ||
          (existingCall.applicationNo == null && finalApplicationNo != null) ||
          (existingCall.contactName == null && contactName != null)
        const idempotentCall = needsUpdate
          ? await prisma.call.update({
              where: { id: existingCall.id },
              data: {
                orderId: existingCall.orderId ?? finalOrderId,
                applicationNo: existingCall.applicationNo ?? finalApplicationNo,
                contactName: existingCall.contactName ?? contactName ?? null
              }
            })
          : existingCall
        return reply.send({ data: idempotentCall })
      }

      const call = await prisma.call.create({
        data: {
          orderId: finalOrderId,
          applicationNo: finalApplicationNo,
          employeeId,
          phone,
          contactName: contactName ?? null,
          direction,
          callStatus,
          durationSec,
          startedAt: startedAtDate,
          asrStatus: 'no_recording'
        }
      })

      // 推送给在线管理后台
      broadcastAdmin({
        type: 'call_created',
        payload: { employeeId, orderId: finalOrderId ?? null, applicationNo: finalApplicationNo }
      })
      return reply.send({ data: call })
    } catch (err: any) {
      fastify.log.error('通话记录上报失败:', err)
      return reply.status(500).send({ error: '通话记录上报失败: ' + err.message })
    }
  })

  // 10. 上传录音与 STS 签名 POST /api/v1/recordings
  // 本接口接收录音关联信息，并为客户端直传 MinIO 提供 Presigned URL。
  // ASR 必须等客户端确认 PUT 完成后再触发，避免 MinIO 对象未就绪导致误失败。
  fastify.post<{ Body: CreateRecordingPayload }>('/api/v1/recordings', async (request, reply) => {
    const { callId, ossKey, durationSec } = request.body

    try {
      const call = await prisma.call.findUnique({
        where: { id: callId }
      })

      if (!call) {
        return reply.status(404).send({ error: '通话记录不存在' })
      }

      if (call.recordingOssKey) {
        let objectExists = false
        try {
          await minioClient.statObject(env.minioBucketRecordings, call.recordingOssKey)
          objectExists = true
        } catch {
          objectExists = false
        }
        if (objectExists) {
          if (
            call.asrStatus === 'uploading' ||
            call.asrStatus === 'pending' ||
            (call.asrStatus === 'failed' && call.asrText?.includes('MinIO 对象'))
          ) {
            await prisma.call.update({
              where: { id: callId },
              data: { asrStatus: 'pending', asrText: null, dashscopeTaskId: null, asrFinishedAt: null }
            })
            void scheduleTranscription(call.id)
          }
          return reply.send({
            data: {
              call,
              uploadUrl: null,
              alreadyUploaded: true
            }
          })
        }

        const uploadUrl = await minioPublicClient.presignedPutObject(
          env.minioBucketRecordings,
          call.recordingOssKey,
          5 * 60
        )
        await prisma.call.update({
          where: { id: callId },
          data: { durationSec, asrStatus: 'uploading', asrText: null, dashscopeTaskId: null, asrFinishedAt: null }
        })
        return reply.send({
          data: {
            call,
            uploadUrl,
            alreadyUploaded: false
          }
        })
      }

      // 更新通话记录，绑定录音 OssKey，时长等
      const updatedCall = await prisma.call.update({
        where: { id: callId },
        data: {
          recordingOssKey: ossKey,
          durationSec,
          asrStatus: 'uploading', // 等待客户端 PUT MinIO 完成后确认
          asrText: null,
          dashscopeTaskId: null,
          asrFinishedAt: null
        }
      })

      // 生成客户端直接 PUT 音频文件至 MinIO 的预签名 URL (有效期 5 分钟)
      const uploadUrl = await minioPublicClient.presignedPutObject(
        env.minioBucketRecordings,
        ossKey,
        5 * 60
      )

      return reply.send({
        data: {
          call: updatedCall,
          uploadUrl, // 客户端通过 PUT 请求此 URL 上传文件，完全不需要后端中转大流量
          alreadyUploaded: false
        }
      })
    } catch (err: any) {
      fastify.log.error('关联录音及生成直传凭证失败:', err)
      return reply.status(500).send({ error: '关联录音及生成直传凭证失败: ' + err.message })
    }
  })

  // 10.1 确认录音已直传完成 POST /api/v1/recordings/:callId/complete
  // 客户端 PUT MinIO 成功后调用；后端确认对象存在后再触发 ASR。
  fastify.post<{ Params: { callId: string } }>('/api/v1/recordings/:callId/complete', async (request, reply) => {
    const callId = parseInt(request.params.callId, 10)
    try {
      const call = await prisma.call.findUnique({ where: { id: callId } })
      if (!call) return reply.status(404).send({ error: '通话记录不存在' })
      if (!call.recordingOssKey) return reply.status(400).send({ error: '该通话尚未登记录音' })

      try {
        await minioClient.statObject(env.minioBucketRecordings, call.recordingOssKey)
      } catch {
        return reply.status(409).send({ error: '录音对象尚未在 MinIO 就绪，请稍后重试' })
      }

      const updatedCall = await prisma.call.update({
        where: { id: callId },
        data: {
          asrStatus: call.asrStatus === 'done' ? 'done' : 'pending',
          asrText: call.asrStatus === 'done' ? call.asrText : null,
          dashscopeTaskId: call.asrStatus === 'done' ? call.dashscopeTaskId : null,
          asrFinishedAt: call.asrStatus === 'done' ? call.asrFinishedAt : null
        }
      })

      if (updatedCall.asrStatus !== 'done') void scheduleTranscription(callId)
      return reply.send({ data: { callId, confirmed: true, asrStatus: updatedCall.asrStatus } })
    } catch (err: any) {
      fastify.log.error('确认录音上传完成失败:', err)
      return reply.status(500).send({ error: '确认录音上传完成失败: ' + err.message })
    }
  })

  // 10.2 查询通话转写 GET /api/v1/calls/:id/transcript
  fastify.get<{ Params: { id: string } }>('/api/v1/calls/:id/transcript', async (request, reply) => {
    const callId = parseInt(request.params.id, 10)
    try {
      const call = await prisma.call.findUnique({ where: { id: callId } })
      if (!call) return reply.status(404).send({ error: '通话记录不存在' })
      return reply.send({
        data: {
          id: call.id,
          asrStatus: call.asrStatus,
          asrText: call.asrText,
          asrFinishedAt: call.asrFinishedAt?.toISOString() ?? null,
          dashscopeTaskId: call.dashscopeTaskId,
          asrResultJson: call.asrResultJson
        }
      })
    } catch (err: any) {
      fastify.log.error('查询转写失败:', err)
      return reply.status(500).send({ error: '查询转写失败: ' + err.message })
    }
  })

  // 10.3 手动重新转写 POST /api/v1/calls/:id/retranscribe
  fastify.post<{ Params: { id: string } }>('/api/v1/calls/:id/retranscribe', async (request, reply) => {
    const callId = parseInt(request.params.id, 10)
    try {
      const call = await prisma.call.findUnique({ where: { id: callId } })
      if (!call) return reply.status(404).send({ error: '通话记录不存在' })
      if (!call.recordingOssKey) {
        return reply.status(400).send({ error: '该通话尚未上传录音' })
      }
      // 重置状态，让 scheduler 视为新任务
      await prisma.call.update({
        where: { id: callId },
        data: { asrStatus: 'pending', dashscopeTaskId: null, asrFinishedAt: null }
      })
      void scheduleTranscription(callId)
      return reply.send({ data: { callId, triggered: true } })
    } catch (err: any) {
      fastify.log.error('重新转写失败:', err)
      return reply.status(500).send({ error: '重新转写失败: ' + err.message })
    }
  })

  // 11. 获取详情聚合 GET /api/v1/orders/:id/aggregate
  fastify.get<{ Params: { id: string } }>('/api/v1/orders/:id/aggregate', async (request, reply) => {
    const orderId = parseInt(request.params.id, 10)
    if (!Number.isFinite(orderId) || orderId <= 0) {
      return reply.status(404).send({ error: '订单不存在' })
    }

    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId }
      })

      if (!order) {
        return reply.status(404).send({ error: '订单不存在' })
      }

      const applicationNo = applicationNosForConversationMatch(order.rawJson)[0] ?? null
      const applicationOrderIds = applicationNo
        ? (await prisma.order.findMany({
            where: { rawJson: { path: ['crmApplyNo'], equals: applicationNo } },
            select: { id: true }
          })).map((o) => o.id)
        : [orderId]
      if (!applicationOrderIds.includes(orderId)) applicationOrderIds.push(orderId)
      const sharedCaptureWhere = applicationNo
        ? {
            OR: [
              { orderId: { in: applicationOrderIds } },
              { applicationNo }
            ]
          }
        : { orderId }

      // 聚合查询关联的 messages, calls, aiSummaries。微信/企微消息与通话按申请号共享到同申请号下所有订单。
      const messages = await prisma.message.findMany({
        where: sharedCaptureWhere,
        orderBy: [{ sortTime: { sort: 'asc', nulls: 'last' } }, { capturedAt: 'asc' }]
      })

      const calls = await prisma.call.findMany({
        where: sharedCaptureWhere,
        orderBy: { startedAt: 'asc' }
      })

      const aiSummaries = await prisma.aiSummary.findMany({
        where: { orderId },
        orderBy: { createdAt: 'desc' }
      })

      const enrichedOrder = await enrichOrderWithHuanyuFact(order)

      // 组装聚合响应
      const data: OrderAggregate = {
        ...enrichedOrder,
        source: enrichedOrder.source as any,
        status: enrichedOrder.status as any,
        rawJson: enrichedOrder.rawJson as any,
        createdAt: enrichedOrder.createdAt.toISOString(),
        updatedAt: enrichedOrder.updatedAt.toISOString(),
        messages: messages.map(m => ({
          ...m,
          channel: m.channel as any,
          chatTime: m.chatTime?.toISOString() ?? null,
          sortTime: m.sortTime?.toISOString() ?? null,
          capturedAt: m.capturedAt.toISOString()
        })),
        calls: calls.map(c => ({
          ...c,
          direction: c.direction as any,
          callStatus: c.callStatus as any,
          asrStatus: c.asrStatus as any,
          startedAt: c.startedAt.toISOString(),
          asrFinishedAt: c.asrFinishedAt?.toISOString() ?? null
        })),
        aiSummaries: aiSummaries.map(s => ({
          ...s,
          type: s.type as any,
          createdAt: s.createdAt.toISOString()
        }))
      }

      return reply.send({ data })
    } catch (err: any) {
      fastify.log.error('查询订单聚合详情失败:', err)
      return reply.status(500).send({ error: '查询订单聚合详情失败: ' + err.message })
    }
  })

  // 9. 订单详情（caseInfo + 附件 presigned URLs）GET /api/v1/orders/:id/detail
  fastify.get<{ Params: { id: string } }>('/api/v1/orders/:id/detail', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const orderId = parseInt(request.params.id, 10)
    if (!Number.isFinite(orderId) || orderId <= 0) return reply.status(404).send({ error: '订单不存在' })
    try {
      const order = await prisma.order.findUnique({ where: { id: orderId } })
      if (!order) return reply.status(404).send({ error: '订单不存在' })

      const enrichedOrder = await enrichOrderWithHuanyuFact(order)

      const attachments = await prisma.orderAttachment.findMany({
        where: { orderId },
        orderBy: { id: 'asc' }
      })

      const proto = String(request.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim()
      const host = request.headers.host
      if (!host) throw new Error('缺少 Host 请求头，无法生成附件访问地址')
      const attachmentBase = `${proto}://${host}`
      const employeeCode = encodeURIComponent(request.employee.token)
      const attachmentsOut = attachments.map((a) => ({
        id: a.id,
        fileType: a.fileType,
        fileName: a.fileName,
        mimeType: a.mimeType,
        byteSize: a.byteSize,
        url: `${attachmentBase}/api/v1/order-attachments/${a.id}/content?employeeCode=${employeeCode}`
      }))

      return reply.send({
        data: {
          order: {
            ...enrichedOrder,
            createdAt: enrichedOrder.createdAt.toISOString(),
            updatedAt: enrichedOrder.updatedAt.toISOString(),
            detailFetchedAt: enrichedOrder.detailFetchedAt?.toISOString() ?? null
          },
          detail: enrichedOrder.detailJson ?? null,
          attachments: attachmentsOut
        }
      })
    } catch (err: any) {
      fastify.log.error('查询订单详情失败:', err)
      return reply.status(500).send({ error: '查询订单详情失败: ' + err.message })
    }
  })

  // 9.1 附件内容代理。img 标签无法携带 X-Employee-Code，所以详情接口把 employeeCode 放到查询参数里。
  fastify.get<{ Params: { id: string }; Querystring: { employeeCode?: string } }>(
    '/api/v1/order-attachments/:id/content',
    async (request, reply) => {
      const attachmentId = parseInt(request.params.id, 10)
      const employeeCode = normalizeEmployeeCode(request.query.employeeCode)
      if (!employeeCode) return reply.status(401).send({ error: '缺少 employeeCode' })

      try {
        const employee = await ensureEmployeeByCode(prisma, employeeCode)
        const attachment = await prisma.orderAttachment.findUnique({
          where: { id: attachmentId },
          include: { order: { select: { assignedEmployeeId: true, rawJson: true } } }
        })
        if (!attachment) return reply.status(404).send({ error: '附件不存在' })

        const pool = (attachment.order.rawJson as any)?.pool
        if (attachment.order.assignedEmployeeId && attachment.order.assignedEmployeeId !== employee.id && pool !== 'public') {
          return reply.status(403).send({ error: '无权访问该附件' })
        }

        const stream = await minioClient.getObject(attachment.minioBucket, attachment.minioKey)
        reply.header('Content-Type', attachment.mimeType)
        reply.header('Content-Length', String(attachment.byteSize))
        reply.header('Cache-Control', 'private, max-age=3600')
        return reply.send(stream)
      } catch (err: any) {
        fastify.log.error('读取订单附件失败:', err)
        return reply.status(500).send({ error: '读取订单附件失败: ' + err.message })
      }
    }
  )

  // 10. 手动重抓详情 POST /api/v1/orders/:id/refresh-detail
  // 给当前申领该订单的员工的插件下发一条 fetch-only 的指令
  fastify.post<{ Params: { id: string } }>('/api/v1/orders/:id/refresh-detail', async (request, reply) => {
    const orderId = parseInt(request.params.id, 10)
    if (!request.employee) return reply.status(401).send({ error: '未登录' })

    try {
      const order = await prisma.order.findUnique({ where: { id: orderId } })
      if (!order) return reply.status(404).send({ error: '订单不存在' })

      const targetEmployeeId = order.assignedEmployeeId ?? request.employee.id

      const command = await prisma.command.create({
        data: {
          target: 'ext',
          action: 'fetch_detail',
          payloadJson: {
            orderId: order.id,
            sourceOrderNo: order.sourceOrderNo
          },
          status: 'pending'
        }
      })

      const conn = activeConnections.get(targetEmployeeId)
      if (conn?.ext && conn.ext.readyState === 1) {
        conn.ext.send(JSON.stringify({
          type: 'command',
          commandId: command.id,
          action: command.action,
          payload: command.payloadJson
        }))
        fastify.log.info(`已向员工 ${targetEmployeeId} 推送 fetch_detail 指令 ${command.id}`)
      } else {
        fastify.log.warn(`员工 ${targetEmployeeId} 的插件未连接，fetch_detail 指令 ${command.id} 待轮询`)
      }

      return reply.send({ data: { commandId: command.id } })
    } catch (err: any) {
      fastify.log.error('触发重抓详情失败:', err)
      return reply.status(500).send({ error: '触发重抓详情失败: ' + err.message })
    }
  })

  // ── AI 摘要路由 ────────────────────────────────────────────────────────────

  // 11b. 通话摘要 POST /api/v1/calls/:id/summarize
  // 对单条通话的 ASR 文字做摘要，结果存入 ai_summaries 表
  fastify.post<{ Params: { id: string } }>('/api/v1/calls/:id/summarize', async (request, reply) => {
    const callId = parseInt(request.params.id, 10)
    if (!request.employee) return reply.status(401).send({ error: '未登录' })

    try {
      const call = await prisma.call.findUnique({ where: { id: callId } })
      if (!call) return reply.status(404).send({ error: '通话记录不存在' })
      if (!call.asrText) return reply.status(400).send({ error: '该通话尚无 ASR 文字，无法摘要' })

      const { content, model } = await summarizeCall({
        transcript: call.asrText,
        direction: call.direction as 'inbound' | 'outbound',
        durationSec: call.durationSec ?? undefined,
      })

      const summary = await prisma.aiSummary.create({
        data: {
          orderId: call.orderId!,
          type: 'call',
          content,
          model,
        },
      })

      fastify.log.info(`通话 ${callId} 摘要已生成，summaryId=${summary.id}`)
      return reply.send({ data: summary })
    } catch (err: any) {
      fastify.log.error('通话摘要生成失败:', err)
      return reply.status(500).send({ error: '通话摘要生成失败: ' + err.message })
    }
  })

  // 11c. 微信消息摘要 POST /api/v1/orders/:id/messages/summarize
  // 对订单下的全部微信消息做摘要
  fastify.post<{ Params: { id: string } }>('/api/v1/orders/:id/messages/summarize', async (request, reply) => {
    const orderId = parseInt(request.params.id, 10)
    if (!request.employee) return reply.status(401).send({ error: '未登录' })

    try {
      const order = await prisma.order.findUnique({ where: { id: orderId } })
      if (!order) return reply.status(404).send({ error: '订单不存在' })

      const messages = await prisma.message.findMany({
        where: { orderId },
        orderBy: [{ sortTime: { sort: 'asc', nulls: 'last' } }, { capturedAt: 'asc' }],
      })
      if (!messages.length) return reply.status(400).send({ error: '该订单暂无微信消息' })

      const { content, model } = await summarizeMessages({
        conversationName: order.customerName,
        messages: messages.map(m => ({
          senderName: m.senderName,
          contentText: m.contentText,
          capturedAt: m.capturedAt.toISOString(),
        })),
      })

      const summary = await prisma.aiSummary.create({
        data: { orderId, type: 'message', content, model },
      })

      fastify.log.info(`订单 ${orderId} 消息摘要已生成，summaryId=${summary.id}`)
      return reply.send({ data: summary })
    } catch (err: any) {
      fastify.log.error('消息摘要生成失败:', err)
      return reply.status(500).send({ error: '消息摘要生成失败: ' + err.message })
    }
  })

  // 11d. 全单摘要 POST /api/v1/orders/:id/summarize
  // 综合通话、消息、订单详情，生成整体跟进摘要
  fastify.post<{ Params: { id: string } }>('/api/v1/orders/:id/summarize', async (request, reply) => {
    const orderId = parseInt(request.params.id, 10)
    if (!request.employee) return reply.status(401).send({ error: '未登录' })

    try {
      const order = await prisma.order.findUnique({ where: { id: orderId } })
      if (!order) return reply.status(404).send({ error: '订单不存在' })

      const [calls, messages] = await Promise.all([
        prisma.call.findMany({ where: { orderId }, orderBy: { startedAt: 'asc' } }),
        prisma.message.findMany({ where: { orderId }, orderBy: [{ sortTime: { sort: 'asc', nulls: 'last' } }, { capturedAt: 'asc' }] }),
      ])

      const { content, model } = await summarizeFull({
        order: {
          customerName: order.customerName,
          hospital: order.hospital,
          dept: order.dept,
          doctor: order.doctor,
          status: order.status,
          sourceOrderNo: order.sourceOrderNo,
        },
        callTranscripts: calls
          .filter(c => !!c.asrText)
          .map(c => c.asrText!),
        messageTexts: messages.map(
          m => `[${m.capturedAt.toISOString().substring(0, 16)}] ${m.senderName ?? ''}: ${m.contentText}`
        ),
        detailJson: order.detailJson as Record<string, unknown> | null,
      })

      const summary = await prisma.aiSummary.create({
        data: { orderId, type: 'full', content, model },
      })

      fastify.log.info(`订单 ${orderId} 全单摘要已生成，summaryId=${summary.id}`)
      return reply.send({ data: summary })
    } catch (err: any) {
      fastify.log.error('全单摘要生成失败:', err)
      return reply.status(500).send({ error: '全单摘要生成失败: ' + err.message })
    }
  })

  // ════════════════════════════════════════════════════════════
  // 12. 现场采集素材（剪贴板粘贴）
  //
  //   POST /api/v1/orders/:id/materials   员工粘贴一条文字或图片
  //   GET  /api/v1/materials?orderId=     拉某订单的素材列表（图片附 presigned URL）
  //   DEL  /api/v1/materials/:id          删除一条素材
  //
  //   幂等：clientUuid 由 tray-app 本地生成，(orderId, clientUuid) 唯一。
  //   离线补传时同一 UUID 重发会被 upsert 收敛，不会产生重复行。
  // ════════════════════════════════════════════════════════════

  const MATERIAL_BUCKET = 'materials'

  fastify.post<{
    Params: { id: string }
    Body: {
      type: 'text' | 'image'
      clientUuid: string
      textContent?: string
      mimeType?: string
      base64?: string // image 时必填，无 data URL 前缀
    }
  }>('/api/v1/orders/:id/materials', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const orderId = parseInt(request.params.id, 10)
    const { type, clientUuid, textContent, mimeType, base64 } = request.body || ({} as any)
    if (!Number.isFinite(orderId)) return reply.status(400).send({ error: 'orderId 非法' })
    if (!clientUuid) return reply.status(400).send({ error: 'clientUuid 必填' })
    if (type !== 'text' && type !== 'image')
      return reply.status(400).send({ error: 'type 必须是 text 或 image' })
    if (type === 'text' && !textContent) return reply.status(400).send({ error: '文本不能为空' })
    if (type === 'image' && (!base64 || !mimeType))
      return reply.status(400).send({ error: '图片需要 base64 + mimeType' })

    const order = await prisma.order.findUnique({ where: { id: orderId } })
    if (!order) return reply.status(404).send({ error: '订单不存在' })

    let minioBucket: string | null = null
    let minioKey: string | null = null
    let byteSize: number | null = null

    if (type === 'image') {
      // base64 → buffer → MinIO
      const buf = Buffer.from(base64!, 'base64')
      byteSize = buf.length
      const ext = (mimeType!.split('/')[1] || 'bin').toLowerCase()
      // 路径：materials/<orderId>/<clientUuid>.<ext>
      minioKey = `materials/${orderId}/${clientUuid}.${ext}`
      minioBucket = MATERIAL_BUCKET
      try {
        await minioClient.putObject(MATERIAL_BUCKET, minioKey, buf, buf.length, {
          'Content-Type': mimeType!
        })
      } catch (e: any) {
        fastify.log.error('MinIO 上传材料图失败: ' + e.message)
        return reply.status(500).send({ error: 'MinIO 上传失败: ' + e.message })
      }
    }

    try {
      const created = await prisma.material.upsert({
        where: {
          orderId_clientUuid: { orderId, clientUuid }
        },
        update: {
          // 幂等：同 UUID 重发不更新内容（避免覆盖删除痕迹），只确保存在
        },
        create: {
          orderId,
          employeeId: request.employee.id,
          type,
          textContent: type === 'text' ? textContent! : null,
          mimeType: type === 'image' ? mimeType! : null,
          minioBucket,
          minioKey,
          byteSize,
          clientUuid
        }
      })
      // 推送给在线管理后台，让仪表盘/素材流水实时刷新
      broadcastAdmin({
        type: 'material_created',
        payload: { employeeId: request.employee.id, orderId, materialType: type }
      })
      return reply.send({ data: { id: created.id, createdAt: created.createdAt } })
    } catch (e: any) {
      fastify.log.error('保存素材失败: ' + e.message)
      return reply.status(500).send({ error: '保存素材失败: ' + e.message })
    }
  })

  fastify.get<{ Querystring: { orderId?: string } }>(
    '/api/v1/materials',
    async (request, reply) => {
      const orderId = parseInt(request.query.orderId || '', 10)
      if (!Number.isFinite(orderId))
        return reply.status(400).send({ error: 'orderId 必填' })

      const list = await prisma.material.findMany({
        where: { orderId },
        orderBy: { createdAt: 'desc' }
      })
      const data = await Promise.all(
        list.map(async (m) => {
          let url: string | null = null
          if (m.type === 'image' && m.minioBucket && m.minioKey) {
            try {
              url = await minioPublicClient.presignedGetObject(
                m.minioBucket,
                m.minioKey,
                60 * 60
              )
            } catch (e: any) {
              fastify.log.warn(`presigned URL 生成失败 material=${m.id}: ${e.message}`)
            }
          }
          return {
            id: m.id,
            orderId: m.orderId,
            type: m.type,
            textContent: m.textContent,
            mimeType: m.mimeType,
            byteSize: m.byteSize,
            url,
            clientUuid: m.clientUuid,
            createdAt: m.createdAt.toISOString()
          }
        })
      )
      return reply.send({ data })
    }
  )

  fastify.delete<{ Params: { id: string } }>(
    '/api/v1/materials/:id',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10)
      if (!Number.isFinite(id)) return reply.status(400).send({ error: 'id 非法' })
      const m = await prisma.material.findUnique({ where: { id } })
      if (!m) return reply.status(404).send({ error: '素材不存在' })
      // 先删 MinIO 对象（失败也继续删 DB，避免孤儿记录卡住前端）
      if (m.type === 'image' && m.minioBucket && m.minioKey) {
        await minioClient
          .removeObject(m.minioBucket, m.minioKey)
          .catch((e) => fastify.log.warn(`MinIO 删除失败 ${m.minioKey}: ${e.message}`))
      }
      await prisma.material.delete({ where: { id } })
      return reply.send({ data: { id } })
    }
  )

  // 13. 字典配置管理 CRUD 路由 (科室、医院、医生、渠道、产品、支付渠道、陪诊人、地区)
  registerDictionaryManageRoutes(fastify, prisma)

  // 14. 陪诊人员出工短信反馈 H5 与 API 路由
  registerEscortFeedbackRoutes(fastify, prisma, minioClient, minioPublicClient)
}
