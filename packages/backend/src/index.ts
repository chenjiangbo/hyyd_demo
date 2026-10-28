// 全局统一东八区（中国标准时间）
process.env.TZ = 'Asia/Shanghai'

import fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import * as Minio from 'minio'
import * as dotenv from 'dotenv'
import {
  registerApiRoutes,
  activeConnections,
  presenceMap,
  ensureEmployeeByCode,
  normalizeEmployeeCode,
  normalizeTaikangAccount,
  findEmployeeByTaikangAccount,
  setExtPresenceInstance,
  deleteExtPresenceInstance
} from './routes/api.js'
import { startOrderAiSchedule } from './jobs/orderAiSchedule.js'
import { startNativeChatImageAnalysisWorker } from './services/nativeChatImageAnalysis.js'
import { initializeNativeChatCollectionConfig } from './services/nativeChatCollectionConfig.js'
import { startOrderReminderSchedule } from './jobs/orderReminderSchedule.js'
import { loadChineseWorkdayCalendar, startChineseWorkdayCalendarSync } from './jobs/chineseWorkdayCalendarSync.js'
import { registerAdminRoutes, ADMIN_COOKIE, verifyAdminToken } from './routes/admin.js'
import { addAdminSocket, removeAdminSocket } from './routes/adminBus.js'
import { saveOrderAttachments, saveOrderDetailBundle } from './orderDetail.js'
import { saveTaikangFormEvent } from './taikangFormRecording.js'
import { ensureOrderIdCardOcrTable, scheduleOrderIdCardOcr } from './services/orderIdCardOcr.js'
import { initScheduler } from './asr/transcribeScheduler.js'
import fastifyStatic from '@fastify/static'
import fastifyMultipart from '@fastify/multipart'
import { existsSync, mkdirSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { getEnv } from './env.js'
import { ensureHuanyuTables } from './db/ensureHuanyuTables.js'
import { ensureBOrderFormTables } from './db/ensureBOrderFormTables.js'
import { ensureReminderTables } from './db/ensureReminderTables.js'
import { ensureSysSettingsTable } from './db/ensureSysSettingsTable.js'
import { ensureTaikangHuanyuChannelMappingTable } from './db/ensureTaikangHuanyuChannelMappingTable.js'
import { ensureOrderAttributionMismatchTable } from './db/ensureOrderAttributionMismatchTable.js'
import { assertShanghaiDatabaseTimezone, createShanghaiPrismaClient } from './db/shanghaiPrisma.js'
import { syncHuanyuOrderFromTaikang } from './huanyuOrderSync.js'
import { findHuanyuOrderNoOnMysqlByChannelOrderNo, findHuanyuOrderNosOnMysqlByChannelOrderNo } from './huanyuMysqlPush.js'
import { initializeOrderWorkflow } from './workflow/serviceWorkflow.js'
import { parseTaikangPoolEnteredAt } from './taikangPoolTime.js'

function isTaikangRegistrationAssistance(rawJson: unknown): boolean {
  if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) return false
  const raw = rawJson as Record<string, unknown>
  const original = raw.taikangRawJson ?? raw.rawJson
  const originalRecord = original && typeof original === 'object' && !Array.isArray(original)
    ? original as Record<string, unknown>
    : {}
  return raw.poolType === 'register' || originalRecord.poolType === 'register'
}

if (process.env.NODE_ENV !== 'production') {
  // pnpm --filter 会将子进程工作目录切到 packages/backend；开发期优先读取包目录，
  // 再读取仓库根 .env，保证约定的后端热启动方式能加载根配置。
  dotenv.config({ path: resolve(process.cwd(), '.env'), override: true })
  dotenv.config({ path: resolve(process.cwd(), '../../.env'), override: true })
}

const appEnv = getEnv()

const server = fastify({
  logger: true,
  bodyLimit: 25 * 1024 * 1024
})

const prisma = createShanghaiPrismaClient()

type GreenPassHuanyuSyncAction =
  | 'public_skipped'
  | 'missing_assignee'
  | 'remote_existing'
  | 'remote_created'
  | 'failed'

type GreenPassHuanyuSyncLog = {
  orderId: number
  sourceOrderNo: string
  pool: 'public' | 'personal'
  assignedEmployeeId?: number | null
  assignedEmployeeName?: string | null
  action: GreenPassHuanyuSyncAction
  huanyuOrderNo?: string | null
  errorMessage?: string | null
}

/**
 * 记录绿通“远程已存在 / 远程新建”的业务决策。日志写入失败不能影响订单同步主流程。
 */
async function writeGreenPassHuanyuSyncLog(input: GreenPassHuanyuSyncLog): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO order_huanyu_sync_logs (
        order_id, source_order_no, pool, assigned_employee_id, assigned_employee_name,
        action, huanyu_order_no, error_message
      ) VALUES (
        ${input.orderId}, ${input.sourceOrderNo}, ${input.pool}, ${input.assignedEmployeeId ?? null},
        ${input.assignedEmployeeName ?? null}, ${input.action}, ${input.huanyuOrderNo ?? null},
        ${input.errorMessage?.slice(0, 4000) ?? null}
      )
    `
  } catch (error) {
    server.log.warn({ err: error, orderId: input.orderId, action: input.action }, '绿通寰宇同步日志写入失败')
  }
}

async function recordOrderAttributionMismatch(input: {
  sourceOrderNo: string
  storedEmployeeId: number
  observedEmployeeId: number
  observedTaikangAccount: string
  observedTaikangUserId: number
  batchId: string
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO order_attribution_mismatches (
      source_order_no, stored_employee_id, observed_employee_id,
      observed_taikang_account, observed_taikang_user_id, batch_id
    ) VALUES (
      ${input.sourceOrderNo}, ${input.storedEmployeeId}, ${input.observedEmployeeId},
      ${input.observedTaikangAccount}, ${input.observedTaikangUserId}, ${input.batchId}
    )
    ON CONFLICT (batch_id, source_order_no) DO NOTHING
  `
}

/**
 * 以数据库唯一键作为跨实例互斥锁。进程异常留下的占位五分钟后可由下一次个人池同步接管，
 * 不依赖后台定时重试。
 */
async function claimGreenPassHuanyuSync(orderId: number): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ order_id: number }>>`
    INSERT INTO order_huanyu_sync_claims (order_id, claimed_at)
    VALUES (${orderId}, NOW())
    ON CONFLICT (order_id) DO UPDATE
      SET claimed_at = NOW()
      WHERE order_huanyu_sync_claims.claimed_at < NOW() - INTERVAL '5 minutes'
    RETURNING order_id
  `
  return rows.length === 1
}

async function releaseGreenPassHuanyuSyncClaim(orderId: number): Promise<void> {
  try {
    await prisma.$executeRaw`DELETE FROM order_huanyu_sync_claims WHERE order_id = ${orderId}`
  } catch (error) {
    server.log.warn({ err: error, orderId }, '绿通寰宇同步占位释放失败')
  }
}

/**
 * 仅个人池绿通详情已保存后调用：远程已有时只关联订单号，查无时才直接在远端创建。
 *
 * 客户经理由已落库订单的 assigned_employee_id 关联 employees.name 得到；
 * 公共池和挂号订单不得调用本方法，以免公共池采集人影响 KHJL。
 */
async function syncGreenPassHuanyuOrderAfterPersonalPool(orderId: number): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { assignedEmployee: { select: { id: true, name: true } } }
  })
  if (!order) return

  const managerName = order.assignedEmployee?.name.trim() || null
  if (!order.assignedEmployeeId || !managerName) {
    await writeGreenPassHuanyuSyncLog({
      orderId: order.id,
      sourceOrderNo: order.sourceOrderNo,
      pool: 'personal',
      assignedEmployeeId: order.assignedEmployeeId,
      assignedEmployeeName: managerName,
      action: 'missing_assignee',
      errorMessage: '个人池订单缺少 assigned_employee_id 对应的员工姓名，未执行寰宇同步'
    })
    throw new Error(`个人池订单 ${order.sourceOrderNo} 缺少归属员工，不能创建寰宇订单`)
  }

  if (!await claimGreenPassHuanyuSync(order.id)) {
    server.log.info(`泰康个人池订单 ${order.sourceOrderNo} 正由其他同步请求处理，跳过本次重复建单`)
    return
  }

  try {
    // 每次都按泰康订单号查远端，避免历史本地生成的 huanyuOrderNo 阻止远端补建。
    // 查询失败会进入 catch，绝不把“查询失败”当作“远端无订单”。
    const remoteDdbhs = await findHuanyuOrderNosOnMysqlByChannelOrderNo(order.sourceOrderNo)
    if (remoteDdbhs.length > 0) {
      const primaryDdbh = order.huanyuOrderNo || remoteDdbhs[0]!
      for (const remoteDdbh of remoteDdbhs) {
        await prisma.$executeRaw`
          INSERT INTO b_order_huanyu_services (order_id, huanyu_order_no, source, workflow_enabled)
          VALUES (${order.id}, ${remoteDdbh}, ${remoteDdbh === primaryDdbh ? 'remote_primary' : 'remote_copied'}, ${remoteDdbh === primaryDdbh})
          ON CONFLICT (huanyu_order_no) DO UPDATE
            SET workflow_enabled = b_order_huanyu_services.workflow_enabled OR EXCLUDED.workflow_enabled
        `
      }
      if (!order.huanyuOrderNo) {
        await prisma.order.update({ where: { id: order.id }, data: { huanyuOrderNo: primaryDdbh } })
      }
      await initializeOrderWorkflow(prisma, order.id, primaryDdbh)
      await writeGreenPassHuanyuSyncLog({
        orderId: order.id,
        sourceOrderNo: order.sourceOrderNo,
        pool: 'personal',
        assignedEmployeeId: order.assignedEmployeeId,
        assignedEmployeeName: managerName,
        action: 'remote_existing',
        huanyuOrderNo: primaryDdbh
      })
      server.log.info(`泰康订单 ${order.sourceOrderNo} 已关联 ${remoteDdbhs.length} 个远程寰宇服务单`)
      return
    }

    // 查无时直接创建远程订单；本地只保存 orders.huanyuOrderNo，不写寰宇镜像表。
    const result = await syncHuanyuOrderFromTaikang(prisma, order, managerName, { writeDirectlyToRemote: true })
    if (result.created) {
      await prisma.$executeRaw`
        INSERT INTO b_order_huanyu_services (order_id, huanyu_order_no, source, workflow_enabled)
        VALUES (${order.id}, ${result.ddbh}, 'created_by_assistant', true)
        ON CONFLICT (huanyu_order_no) DO UPDATE SET workflow_enabled = true
      `
      await initializeOrderWorkflow(prisma, order.id, result.ddbh)
      await writeGreenPassHuanyuSyncLog({
        orderId: order.id,
        sourceOrderNo: order.sourceOrderNo,
        pool: 'personal',
        assignedEmployeeId: order.assignedEmployeeId,
        assignedEmployeeName: managerName,
        action: 'remote_created',
        huanyuOrderNo: result.ddbh
      })
      server.log.info(`已创建远程寰宇订单 ${result.ddbh}（泰康订单 ${order.sourceOrderNo}，客户经理=${managerName}）`)
    }
    if (!result.channelFound || !result.productFound) {
      server.log.warn(`寰宇订单 ${result.ddbh} 字典映射不完整：渠道=${result.channelFound}，服务项目=${result.productFound}`)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    await writeGreenPassHuanyuSyncLog({
      orderId: order.id,
      sourceOrderNo: order.sourceOrderNo,
      pool: 'personal',
      assignedEmployeeId: order.assignedEmployeeId,
      assignedEmployeeName: managerName,
      action: 'failed',
      errorMessage
    })
    throw error
  } finally {
    await releaseGreenPassHuanyuSyncClaim(order.id)
  }
}

// 初始化 MinIO 客户端
// endPoint 是 backend → MinIO 内部访问（同机走 localhost 最稳）。
// presigned URL 给前端用，前端可能在 Windows VM 上，必须用 Mac LAN IP。
// 通过 MINIO_PUBLIC_HOST 区分：未配置时退化为 endPoint。
const minioClient = new Minio.Client({
  endPoint: appEnv.minioHost,
  port: appEnv.minioPort,
  useSSL: false,
  accessKey: appEnv.minioAccessKey,
  secretKey: appEnv.minioSecretKey
})

// 给"对外可访问的 MinIO 客户端"做一个 presigned URL 专用实例
const minioPublicClient = new Minio.Client({
  endPoint: appEnv.minioPublicHost,
  port: appEnv.minioPublicPort,
  useSSL: false,
  accessKey: appEnv.minioAccessKey,
  secretKey: appEnv.minioSecretKey
})

// 确保 MinIO 桶存在（启动时调用）
async function ensureBuckets() {
  const buckets = ['order-attachments', 'recordings', appEnv.minioBucketScreenshots, 'materials', 'capture-diagnostics']
  await Promise.all(
    buckets.map(async (name) => {
      try {
        const checkPromise = minioClient.bucketExists(name).catch(() => false)
        const timeoutPromise = new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error('MinIO 检查超时')), 1000))
        const exists = await Promise.race([checkPromise, timeoutPromise])
        if (!exists) {
          await minioClient.makeBucket(name).catch((e) => {
            if (!String(e?.message || '').includes('exists')) throw e
          })
          server.log.info(`MinIO bucket 已创建: ${name}`)
        }
      } catch (e: any) {
        server.log.warn(`MinIO bucket 检查/创建跳过 (${name}): ${e?.message || e}`)
      }
    })
  )
}

async function start() {
  try {
    await assertShanghaiDatabaseTimezone(prisma)
    // 先确保寰宇订单与 B 端运营表单相关业务表存在，再注册路由和启动服务。
    // 该检查幂等，已有表不会被修改。
    await ensureHuanyuTables(prisma)
    await ensureOrderIdCardOcrTable(prisma)
    await ensureBOrderFormTables(prisma)
    await ensureReminderTables(prisma, server.log)
    await ensureSysSettingsTable(prisma, server.log)
    await initializeNativeChatCollectionConfig(prisma)
    await loadChineseWorkdayCalendar(prisma)
    await ensureTaikangHuanyuChannelMappingTable(prisma)
    await ensureOrderAttributionMismatchTable(prisma)
    await ensureBuckets()

    // 1. 注册 CORS 跨域插件
    await server.register(cors, {
      origin: true, // 允许所有来源，方便开发联调
      credentials: true, // 允许携带 cookie（管理后台 admin JWT cookie 用）
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-Employee-Code']
    })

    // 1.5 注册 cookie 插件（管理后台鉴权用 httpOnly cookie）
    await server.register(cookie)

    // 1.6 注册 multipart 插件（支持 App 安装包等文件上传）
    await server.register(fastifyMultipart, {
      limits: {
        fileSize: 150 * 1024 * 1024
      }
    })

    // 2. 注册 WebSocket 插件
    await server.register(websocket)

    // 3. 注册 WebSocket 路由
    // 浏览器插件以当前泰康账号连接；托盘继续以员工 ID 连接。
    server.register(async (fastifyInstance) => {
      // 注意: @fastify/websocket v10+ 的回调签名变了
      // 旧 v9: (connection, request) - connection.socket 是 WebSocket
      // 新 v10: (socket, request) - socket 直接就是 WebSocket
      fastifyInstance.get('/ws', { websocket: true }, async (socket, request) => {
        const query = request.query as any
        const client = query?.client // 'ext' | 'tray'
        const employeeCode = normalizeEmployeeCode(query?.employeeCode)
        const taikangAccount = normalizeTaikangAccount(query?.taikangAccount)
        const taikangUserId = Number(query?.taikangUserId)

        if (!client || (client !== 'ext' && client !== 'tray')) {
          server.log.warn('WS 连接请求缺少或包含无效 client 参数，已拒绝连接')
          try { socket.send(JSON.stringify({ error: '认证参数缺失或 client 格式错误' })) } catch {}
          socket.close()
          return
        }

        let employee
        if (client === 'tray') {
          if (!employeeCode) {
            try { socket.send(JSON.stringify({ error: '缺少员工 ID' })) } catch {}
            socket.close()
            return
          }
          employee = await ensureEmployeeByCode(prisma, employeeCode)
        } else {
          const binding = await findEmployeeByTaikangAccount(prisma, taikangAccount)
          if (binding.status !== 'ok') {
            const type = binding.status === 'ambiguous' ? 'EMPLOYEE_BINDING_AMBIGUOUS' : 'EMPLOYEE_BINDING_NOT_FOUND'
            const error = binding.status === 'ambiguous'
              ? `泰康账号 ${taikangAccount} 绑定了多个寰宇员工，请联系管理员处理`
              : `未找到泰康账号 ${taikangAccount || '（空）'} 对应的寰宇员工，请先在 Trayapp 完成员工绑定`
            server.log.warn({ taikangAccount, bindingStatus: binding.status }, '浏览器插件员工绑定失败')
            try { socket.send(JSON.stringify({ type, error })) } catch {}
            socket.close(1008, 'employee binding failed')
            return
          }
          employee = binding.employee
        }

        const employeeId = employee.id
        const bindingStillMatches = async (): Promise<boolean> => {
          if (client !== 'ext') return false
          const currentBinding = await findEmployeeByTaikangAccount(prisma, taikangAccount)
          return currentBinding.status === 'ok' && currentBinding.employee.id === employeeId
        }
        const extInstanceId = client === 'ext'
          ? `${Date.now()}-${Math.random().toString(36).slice(2)}`
          : null
        server.log.info(`员工 ${employee.name} (${client}) 建立了 WebSocket 连接`)

        // 缓存连接
        const currentConn = activeConnections.get(employeeId) || {}
        if (client === 'ext') {
          currentConn.ext = socket
        } else {
          currentConn.tray = socket
        }
        activeConnections.set(employeeId, currentConn)

        // 发送确认连接成功的心跳消息
        socket.send(JSON.stringify({
          type: 'connection_established',
          client,
          employee: { id: employee.id, name: employee.name },
          taikangAccount: employee.taikangAccount
        }))

        // 注：现行 chrome 插件已不再处理任何 command（claim / fetch_detail），
        // 改为定时只读个人池 + 主动上报。原本 ext 重连后补推 pending 指令的逻辑
        // 已无消费方，删除。Command 表 + REST 入口暂留作历史兼容。

        // 监听断开
        socket.on('close', () => {
          server.log.info(`员工 ${employee.name} (${client}) 断开了 WebSocket 连接`)
          const conn = activeConnections.get(employeeId)
          if (conn) {
            if (client === 'ext' && conn.ext === socket) delete conn.ext
            if (client === 'tray' && conn.tray === socket) delete conn.tray
            if (!conn.ext && !conn.tray) {
              activeConnections.delete(employeeId)
            } else {
              activeConnections.set(employeeId, conn)
            }
          }
          if (client === 'ext' && extInstanceId) deleteExtPresenceInstance(employeeId, extInstanceId)
        })

        // 监听消息（例如心跳包、同步订单）
        socket.on('message', async (messageBuffer: Buffer) => {
          try {
            const messageStr = messageBuffer.toString()
            const message = JSON.parse(messageStr)
            
            if (message.type === 'ping') {
              socket.send(JSON.stringify({ type: 'pong' }))
            } else if (message.type === 'TAIKANG_FORM_EVENT') {
              const requestId = typeof message.requestId === 'string' ? message.requestId : ''
              const acknowledge = (ok: boolean, error?: string, duplicate?: boolean) => {
                socket.send(JSON.stringify({ type: 'TAIKANG_FORM_EVENT_ACK', requestId, ok, error, duplicate }))
              }
              if (client !== 'ext' || message.taikangAccount !== taikangAccount ||
                  Number(message.taikangUserId) !== taikangUserId || !requestId) {
                acknowledge(false, '泰康账号或录制请求无效')
                return
              }
              if (!await bindingStillMatches()) {
                acknowledge(false, '泰康账号的员工绑定已变化，请重新连接')
                socket.close(1008, 'employee binding changed')
                return
              }
              const saved = await saveTaikangFormEvent(
                prisma, minioClient, appEnv.minioBucketScreenshots,
                employeeId, taikangAccount, taikangUserId, message.session, message.event, message.imageDataUrl
              )
              acknowledge(saved.ok, saved.ok ? undefined : saved.error, saved.ok ? saved.duplicate : undefined)
            } else if (message.type === 'PRESENCE') {
              // 插件上报的"在线/泰康标签"状态心跳
              if (client === 'ext' && extInstanceId) {
                setExtPresenceInstance(employeeId, extInstanceId, {
                  taikangTabOpen: !!message.taikangTabOpen,
                  trackingPoolPageActive: !!message.trackingPoolPageActive,
                  lastSeenAt: Date.now()
                })
              } else {
                presenceMap.set(employeeId, {
                taikangTabOpen: !!message.taikangTabOpen,
                trackingPoolPageActive: !!message.trackingPoolPageActive,
                lastSeenAt: Date.now()
                })
              }
            } else if (message.type === 'ORDERS_SYNCED') {
              const requestId = typeof message.requestId === 'string' ? message.requestId : ''
              const batchId = typeof message.batchId === 'string' ? message.batchId : ''
              const accountMatches = client === 'ext' && message.protocolVersion === 2 &&
                message.taikangAccount === taikangAccount && Number.isInteger(taikangUserId) && taikangUserId > 0 &&
                Number(message.taikangUserId) === taikangUserId &&
                !!requestId && !!batchId
              if (!accountMatches || !Array.isArray(message.payload) || message.payload.length > 5000) {
                socket.send(JSON.stringify({ type: 'ORDERS_SYNCED_ACK', requestId, ok: false, error: '采集账号或批次无效' }))
                return
              }
              if (!await bindingStillMatches()) {
                socket.send(JSON.stringify({ type: 'ORDERS_SYNCED_ACK', requestId, ok: false, error: '泰康账号的员工绑定已变化，请重新连接' }))
                socket.close(1008, 'employee binding changed')
                return
              }
              server.log.info(`收到员工 ${employee.name} 同步的订单数据: ${message.payload.length} 条`)
              const orders = message.payload
              if (Array.isArray(orders)) {
                const acceptedPersonalOrderNos: string[] = []
                let mismatchCount = 0
                let mismatchRecordFailureCount = 0
                const seenOrderNos = new Set<string>()
                for (const orderData of orders) {
                  const sourceOrderNo = typeof orderData?.orderId === 'string' ? orderData.orderId.trim() : ''
                  if (!sourceOrderNo || seenOrderNos.has(sourceOrderNo) || (orderData.pool !== 'personal' && orderData.pool !== 'public')) {
                    socket.send(JSON.stringify({ type: 'ORDERS_SYNCED_ACK', requestId, ok: false, error: '订单编号、池类型或去重校验失败' }))
                    return
                  }
                  seenOrderNos.add(sourceOrderNo)
                }
                const recordMismatch = async (sourceOrderNo: string, storedEmployeeId: number): Promise<void> => {
                  mismatchCount++
                  try {
                    await recordOrderAttributionMismatch({
                      sourceOrderNo,
                      storedEmployeeId,
                      observedEmployeeId: employeeId,
                      observedTaikangAccount: taikangAccount,
                      observedTaikangUserId: taikangUserId,
                      batchId
                    })
                    server.log.error({ sourceOrderNo, storedEmployeeId, observedEmployeeId: employeeId, taikangAccount, batchId }, '个人池订单归属不一致，仅跳过本单并已记录')
                  } catch (error) {
                    mismatchRecordFailureCount++
                    server.log.error({ err: error, sourceOrderNo, batchId }, '归属不一致记录保存失败；本单仍拒绝改写，其他订单继续')
                  }
                }
                for (const orderData of orders) {
                  const sourceOrderNo = orderData.orderId.trim() as string
                  // 归属规则：
                  // - 个人池(pool=personal)：订单已申领到当前员工，assign 到 employeeId，
                  //   否则 trayapp"我的工作台"按 assignedEmployeeCode 过滤会查不到。
                  // - 公共池(pool=public)：待申领订单，所有账号都看得到、还没人申领，
                  //   不归属任何员工。create 时 assignedEmployeeId=null；update 时
                  //   【不动】assignedEmployeeId，避免把已被别人申领的订单归属抢回 null。
                  //
                  const pool = orderData.pool === 'public' ? 'public' : 'personal'
                  const taikangStatus = orderData.taikangOrderStateName ?? orderData.status ?? '未知'
                  const newState = orderData.taikangOrderState ?? (orderData.orderState != null ? String(orderData.orderState) : null)
                  const rawJson = {
                    ...orderData,
                    taikangOrderState: newState,
                    taikangOrderStateName: taikangStatus,
                    taikangCaseStatus: orderData.taikangCaseStatus ?? orderData.caseStatus ?? null,
                    taikangWaitType: orderData.taikangWaitType ?? null,
                    taikangServState: orderData.taikangServState ?? null,
                    // 为历史回填保留抓单账号；用于 dim_bdyh.userid_ → CAPTION_ 的客户经理映射。
                    taikangAccount,
                    taikangUserId,
                    collectionBatchId: pool === 'personal' ? batchId : null
                  }
                  const poolEnteredAt = parseTaikangPoolEnteredAt(orderData)
                  const sourceCategory = orderData.poolType === 'register' ? 'taikang_register' : 'taikang_green'

                  // 先取旧状态码，用于判断是否需要记一条状态变更历史
                  const existing = await prisma.order.findUnique({
                    where: {
                      source_sourceOrderNo: { source: 'taikang', sourceOrderNo }
                    },
                    select: { orderState: true, assignedEmployeeId: true }
                  })

                  if (pool === 'personal' && existing?.assignedEmployeeId && existing.assignedEmployeeId !== employeeId) {
                    await recordMismatch(sourceOrderNo, existing.assignedEmployeeId)
                    continue
                  }
                  if (pool === 'public' && existing?.assignedEmployeeId) continue

                  let saved
                  if (existing) {
                    const updated = await prisma.order.updateMany({
                      where: {
                        source: 'taikang', sourceOrderNo,
                        ...(pool === 'personal'
                          ? { OR: [{ assignedEmployeeId: null }, { assignedEmployeeId: employeeId }] }
                          : { assignedEmployeeId: null })
                      },
                      data: {
                        status: taikangStatus,
                        orderState: newState,
                        rawJson,
                        sourceCategory,
                        poolEnteredAt,
                        assignedEmployeeId: pool === 'personal' ? employeeId : undefined
                      }
                    })
                    if (updated.count !== 1) {
                      if (pool === 'public') continue
                      const current = await prisma.order.findUnique({
                        where: { source_sourceOrderNo: { source: 'taikang', sourceOrderNo } },
                        select: { assignedEmployeeId: true }
                      })
                      if (current?.assignedEmployeeId && current.assignedEmployeeId !== employeeId) {
                        await recordMismatch(sourceOrderNo, current.assignedEmployeeId)
                        continue
                      }
                      server.log.warn({ sourceOrderNo, employeeId }, '订单写入期间发生并发变化，本单留待下一轮重试')
                      continue
                    }
                    saved = await prisma.order.findUniqueOrThrow({ where: { source_sourceOrderNo: { source: 'taikang', sourceOrderNo } } })
                  } else {
                    try {
                      saved = await prisma.order.create({ data: {
                        source: 'taikang',
                        sourceCategory,
                        sourceOrderNo,
                        customerName: orderData.patientName || '未知',
                        status: taikangStatus,
                        assignedEmployeeId: pool === 'personal' ? employeeId : null,
                        orderState: newState,
                        poolEnteredAt,
                        rawJson
                      } })
                    } catch (error) {
                      if ((error as { code?: string }).code !== 'P2002') throw error
                      const concurrent = await prisma.order.findUnique({
                        where: { source_sourceOrderNo: { source: 'taikang', sourceOrderNo } },
                        select: { assignedEmployeeId: true }
                      })
                      if (pool === 'personal' && concurrent?.assignedEmployeeId && concurrent.assignedEmployeeId !== employeeId) {
                        await recordMismatch(sourceOrderNo, concurrent.assignedEmployeeId)
                        continue
                      }
                      server.log.warn({ sourceOrderNo, employeeId }, '订单已由并发请求写入，本单留待下一轮重试')
                      continue
                    }
                  }
                  if (pool === 'personal') acceptedPersonalOrderNos.push(sourceOrderNo)

                  // 寰宇服务流程只在 H1 已创建并完成关联后初始化；列表采集阶段不能预设流程。
                  if (saved.huanyuOrderNo) await initializeOrderWorkflow(prisma, saved.id, saved.huanyuOrderNo)

                  // 首次出现（existing 为空）或状态码变化 → 记一条历史
                  const oldState = existing?.orderState ?? null
                  if (oldState !== newState) {
                    await prisma.orderStatusHistory.create({
                      data: {
                        orderId: saved.id,
                        orderState: newState,
                        orderStateName: taikangStatus
                      }
                    })
                    if (existing) {
                      server.log.info(`订单 ${orderData.orderId} 状态变化: ${oldState} → ${newState} (${taikangStatus})`)
                    }
                  }

                  // 挂号协助保持“打开详情时仅回拉远程单”的路径；不在泰康采集时本地新建。
                  if (isTaikangRegistrationAssistance(saved.rawJson)) {
                    server.log.info(`泰康挂号协助订单 ${orderData.orderId} 已入库，跳过自动创建寰宇订单`)
                  } else if (pool === 'public') {
                    // 绿通公共池只保存 B 端订单。公共池采集人不得触发远程查询、建单或写入 KHJL。
                    if (!existing) {
                      await writeGreenPassHuanyuSyncLog({
                        orderId: saved.id,
                        sourceOrderNo: saved.sourceOrderNo,
                        pool: 'public',
                        assignedEmployeeId: saved.assignedEmployeeId,
                        action: 'public_skipped'
                      })
                    }
                  } else if (saved.detailFetchedAt && saved.detailJson) {
                    try {
                      // 已有详情的订单在列表同步时补偿触发，防止历史指纹使插件不再重抓。
                      await syncGreenPassHuanyuOrderAfterPersonalPool(saved.id)
                    } catch (error) {
                      server.log.error(error, `泰康个人池订单 ${orderData.orderId} 同步寰宇订单失败，等待下一次个人池同步或详情重试`)
                    }
                  } else {
                    server.log.info(`泰康个人池订单 ${orderData.orderId} 尚无已保存详情，暂不创建远程寰宇订单`)
                  }
                }
                socket.send(JSON.stringify({ type: 'ORDERS_SYNCED_ACK', requestId, ok: true, acceptedPersonalOrderNos, mismatchCount, mismatchRecordFailureCount }))
              }
            } else if (message.type === 'TAIKANG_ORDER_OPEN_RESULT') {
              // 只接收插件对“定位并打开泰康订单”指令的结果；不涉及任何表单写入。
              if (client !== 'ext') {
                server.log.warn({ employeeId }, '忽略非插件上报的泰康订单定位结果')
                return
              }
              const commandId = Number(message.commandId)
              if (!Number.isInteger(commandId) || commandId <= 0) {
                server.log.warn({ employeeId, commandId: message.commandId }, '泰康订单定位结果缺少有效 commandId')
                return
              }
              const command = await prisma.command.findUnique({ where: { id: commandId } })
              if (!command || command.target !== 'ext' || command.action !== 'open_taikang_order') {
                server.log.warn({ employeeId, commandId }, '泰康订单定位结果未找到匹配指令')
                return
              }
              const commandPayload = command.payloadJson && typeof command.payloadJson === 'object' && !Array.isArray(command.payloadJson)
                ? command.payloadJson as Record<string, unknown>
                : {}
              const result = message.result && typeof message.result === 'object' && !Array.isArray(message.result)
                ? message.result as Record<string, unknown>
                : {}
              const ok = message.ok === true
              const error = typeof message.error === 'string' ? message.error.slice(0, 500) : null
              await prisma.command.update({
                where: { id: commandId },
                data: {
                  status: ok ? 'done' : 'failed',
                  executedAt: new Date(),
                  payloadJson: {
                    ...commandPayload,
                    executionResult: ok ? result : { error }
                  } as any
                }
              })
              server.log.info({ employeeId, commandId, ok, error }, '泰康订单定位指令已返回结果')
            } else if (message.type === 'TAIKANG_TOKEN_STATUS') {
              // 插件保活探测结果：更新 presenceMap 给托盘读
              if (client === 'ext' && extInstanceId) {
                setExtPresenceInstance(employeeId, extInstanceId, {
                  lastSeenAt: Date.now(),
                  tokenOk: !!message.ok,
                  tokenReason: message.reason ?? null,
                  tokenLastCheckAt: message.at || Date.now()
                })
              } else {
                const cur = presenceMap.get(employeeId)
                if (cur) {
                  cur.tokenOk = !!message.ok
                  cur.tokenReason = message.reason ?? null
                  cur.tokenLastCheckAt = message.at || Date.now()
                  presenceMap.set(employeeId, cur)
                }
              }
              server.log.info(
                `泰康 token 保活: ${message.ok ? 'OK' : 'FAIL: ' + (message.reason ?? '?')}  员工=${employee.name}`
              )
            } else if (message.type === 'ORDER_DETAIL_FETCHED') {
              // 先单独保存 recommendations 正文并处理远程建单，不等待附件。
              const requestId = typeof message.requestId === 'string' ? message.requestId : ''
              const batchId = typeof message.batchId === 'string' ? message.batchId : ''
              const validIdentity = client === 'ext' && message.protocolVersion === 2 && !!requestId && !!batchId &&
                message.taikangAccount === taikangAccount && Number(message.taikangUserId) === taikangUserId
              const detailAck = (ok: boolean, error?: string, attachmentsComplete?: boolean) => socket.send(JSON.stringify({
                type: 'ORDER_DETAIL_ACK', requestId, ok, error, attachmentsComplete
              }))
              if (!validIdentity) {
                detailAck(false, '采集账号或批次无效')
                return
              }
              if (!await bindingStillMatches()) {
                detailAck(false, '泰康账号的员工绑定已变化，请重新连接')
                socket.close(1008, 'employee binding changed')
                return
              }
              const payload = message.payload || {}
              if (typeof payload.sourceOrderNo !== 'string' || !payload.sourceOrderNo.trim() ||
                  !payload.detail?.recommendations || typeof payload.fingerprint !== 'string') {
                detailAck(false, '详情订单号、正文或指纹无效')
                return
              }
              if (payload.error) {
                server.log.warn(`员工 ${employee.name} 详情抓取失败: ${payload.error} (订单 ${payload.sourceOrderNo})`)
                // 通知托盘
                const conn = activeConnections.get(employeeId)
                if (conn?.tray && conn.tray.readyState === 1) {
                  conn.tray.send(JSON.stringify({
                    type: 'ORDER_DETAIL_ERROR',
                    payload: { sourceOrderNo: payload.sourceOrderNo, error: payload.error }
                  }))
                }
              } else {
                try {
                  const orderForAttribution = await prisma.order.findUnique({
                    where: { source_sourceOrderNo: { source: 'taikang', sourceOrderNo: String(payload.sourceOrderNo || '') } },
                    select: { assignedEmployeeId: true, rawJson: true }
                  })
                  const rawAttribution = orderForAttribution?.rawJson && typeof orderForAttribution.rawJson === 'object' && !Array.isArray(orderForAttribution.rawJson)
                    ? orderForAttribution.rawJson as Record<string, unknown> : {}
                  if (orderForAttribution?.assignedEmployeeId !== employeeId || rawAttribution.taikangAccount !== taikangAccount || rawAttribution.collectionBatchId !== batchId) {
                    detailAck(false, '订单未由当前泰康账号的本批个人池确认')
                    return
                  }
                  const result = await saveOrderDetailBundle(prisma, {
                    sourceOrderNo: payload.sourceOrderNo,
                    detail: payload.detail || {},
                    expectedEmployeeId: employeeId,
                    expectedBatchId: batchId
                  })
                  const detailedOrder = await prisma.order.findUnique({
                    where: { id: result.orderId },
                    select: { rawJson: true }
                  })
                  if (detailedOrder && !isTaikangRegistrationAssistance(detailedOrder.rawJson)) {
                    try {
                      await syncGreenPassHuanyuOrderAfterPersonalPool(result.orderId)
                    } catch (error) {
                      // 详情已成功保存；后续个人池列表同步会基于已保存详情重试远程建单。
                      server.log.error(error, `泰康个人池订单 ${payload.sourceOrderNo} 远程寰宇同步失败，等待下一轮列表同步重试`)
                    }
                  }
                  void scheduleOrderIdCardOcr(prisma, minioClient, result.orderId).catch(() => {
                    server.log.warn({ orderId: result.orderId }, '身份证附件自动识别未完成')
                  })
                  server.log.info(`订单详情正文入库成功: orderId=${result.orderId}`)
                  // 注：原本要把对应的 pending command mark done，但插件
                  // 已不再消费 command，没有指令补推回路，无需 mark。
                  // 通知托盘可以刷新弹窗
                  const conn = activeConnections.get(employeeId)
                  if (conn?.tray && conn.tray.readyState === 1) {
                    conn.tray.send(JSON.stringify({
                      type: 'ORDER_DETAIL_READY',
                      payload: { orderId: result.orderId, sourceOrderNo: payload.sourceOrderNo }
                    }))
                  }
                  detailAck(true)
                } catch (e) {
                  server.log.error('保存订单详情失败:', e as any)
                  detailAck(false, e instanceof Error ? e.message : '保存详情失败')
                }
              }
            } else if (message.type === 'ORDER_ATTACHMENTS_FETCHED') {
              const requestId = typeof message.requestId === 'string' ? message.requestId : ''
              const batchId = typeof message.batchId === 'string' ? message.batchId : ''
              const validIdentity = client === 'ext' && message.protocolVersion === 2 && !!requestId && !!batchId &&
                message.taikangAccount === taikangAccount && Number(message.taikangUserId) === taikangUserId
              const attachmentsAck = (ok: boolean, error?: string, attachmentsComplete?: boolean) => socket.send(JSON.stringify({
                type: 'ORDER_ATTACHMENTS_ACK', requestId, ok, error, attachmentsComplete
              }))
              if (!validIdentity) {
                attachmentsAck(false, '采集账号或批次无效')
                return
              }
              if (!await bindingStillMatches()) {
                attachmentsAck(false, '泰康账号的员工绑定已变化，请重新连接')
                socket.close(1008, 'employee binding changed')
                return
              }
              const payload = message.payload || {}
              if (typeof payload.sourceOrderNo !== 'string' || !payload.sourceOrderNo.trim() ||
                  !Array.isArray(payload.attachments) || typeof payload.attachmentsComplete !== 'boolean' ||
                  typeof payload.fingerprint !== 'string') {
                attachmentsAck(false, '附件订单号、附件列表或指纹无效')
                return
              }
              try {
                const orderForAttribution = await prisma.order.findUnique({
                  where: { source_sourceOrderNo: { source: 'taikang', sourceOrderNo: payload.sourceOrderNo } },
                  select: { assignedEmployeeId: true, rawJson: true }
                })
                const rawAttribution = orderForAttribution?.rawJson && typeof orderForAttribution.rawJson === 'object' && !Array.isArray(orderForAttribution.rawJson)
                  ? orderForAttribution.rawJson as Record<string, unknown> : {}
                if (orderForAttribution?.assignedEmployeeId !== employeeId || rawAttribution.taikangAccount !== taikangAccount || rawAttribution.collectionBatchId !== batchId) {
                  attachmentsAck(false, '附件订单归属与当前采集账号或批次不一致')
                  return
                }
                const result = await saveOrderAttachments(prisma, minioClient, {
                  sourceOrderNo: payload.sourceOrderNo,
                  attachments: payload.attachments,
                  attachmentsComplete: payload.attachmentsComplete,
                  fingerprint: payload.fingerprint,
                  expectedEmployeeId: employeeId,
                  expectedBatchId: batchId
                })
                if (!result.attachmentsComplete) {
                  server.log.warn(`订单 ${payload.sourceOrderNo} 附件未完整保存；未推进采集指纹，将由插件重试`)
                }
                attachmentsAck(true, undefined, result.attachmentsComplete)
              } catch (error) {
                server.log.error(error, `订单 ${payload.sourceOrderNo} 附件保存失败`)
                attachmentsAck(false, error instanceof Error ? error.message : '附件保存失败', false)
              }
            } else if (message.type === 'SYNC_FINGERPRINTS') {
              if (client === 'ext') return // 新版指纹只在详情完整保存时写入，旧版对账不再可信。
              // 插件把本地全量指纹推来对账：补齐后端缺失的 detailFingerprint，
              // 使换机/清缓存的新插件能从后端拿到完整基线、避免重抓。
              // 只有已成功入库详情的订单才允许补指纹；否则会形成"有指纹、没详情"，
              // 后续插件拿到基线后会误以为详情已抓过，导致手机号/详情长期缺失。
              const fps = (message.payload || {}) as Record<string, unknown>
              const entries = Object.entries(fps).filter(([, v]) => typeof v === 'string')
              let n = 0
              for (const [sourceOrderNo, fp] of entries) {
                const r = await prisma.order.updateMany({
                  where: {
                    source: 'taikang',
                    sourceOrderNo,
                    assignedEmployeeId: employeeId,
                    detailFetchedAt: { not: null }
                  },
                  data: { detailFingerprint: fp as string }
                })
                n += r.count
              }
              server.log.info(`指纹基线对账：更新 ${n}/${entries.length} 条，跳过无详情 ${entries.length - n} 条 (员工 ${employee.name})`)
            } else if (message.type === 'GET_FINGERPRINTS') {
              // 插件启动时请求"已采订单的状态指纹基线"，用于跨刷新/换机的增量，
              // 避免本地无缓存时全量重抓泰康。只回该员工名下、已抓过详情的订单。
              const rows = await prisma.order.findMany({
                where: {
                  source: 'taikang',
                  assignedEmployeeId: employeeId,
                  detailFingerprint: { not: null },
                  detailFetchedAt: { not: null },
                  // 旧版先写指纹再存附件；只有新版完整保存标记可作为可信基线。
                  detailJson: { path: ['captureVersion'], equals: 2 }
                },
                select: { sourceOrderNo: true, detailFingerprint: true }
              })
              const map: Record<string, string> = {}
              for (const r of rows) {
                if (r.detailFingerprint) map[r.sourceOrderNo] = r.detailFingerprint
              }
              socket.send(JSON.stringify({ type: 'FINGERPRINTS_BASELINE', requestId: message.requestId, payload: map }))
              server.log.info(`下发指纹基线 ${rows.length} 条给员工 ${employee.name} (${client})`)
            } else {
              server.log.info(`收到来自员工 ${employee.name} (${client}) 的消息:`, message)
            }
          } catch (err) {
            server.log.error('解析 WS 消息出错:', err as any)
          }
        })
      })

      // 管理后台实时推送通道：/ws/admin
      // 握手时校验 admin JWT cookie，通过才加入广播集合。
      fastifyInstance.get('/ws/admin', { websocket: true }, async (socket, request) => {
        // 优先用 cookie 插件解析的，兜底手动从 header 解析
        let token = (request.cookies as Record<string, string> | undefined)?.[ADMIN_COOKIE]
        if (!token) {
          const raw = request.headers.cookie || ''
          const m = raw.match(new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=([^;]+)`))
          token = m?.[1]
        }
        if (!verifyAdminToken(token)) {
          server.log.warn('未授权的 /ws/admin 连接，已拒绝')
          try { socket.send(JSON.stringify({ error: '未授权' })) } catch {}
          socket.close()
          return
        }

        addAdminSocket(socket)
        server.log.info('管理后台 WebSocket 已连接')
        try { socket.send(JSON.stringify({ type: 'connected' })) } catch {}

        socket.on('close', () => {
          removeAdminSocket(socket)
          server.log.info('管理后台 WebSocket 已断开')
        })
        socket.on('message', (buf: Buffer) => {
          try {
            if (JSON.parse(buf.toString())?.type === 'ping') {
              socket.send(JSON.stringify({ type: 'pong' }))
            }
          } catch {
            /* 忽略 */
          }
        })
      })
    })

    // 4. 注册 REST API 路由
    registerApiRoutes(server, prisma, minioClient, minioPublicClient)

    // 4.1 注册管理后台 admin 路由（独立 JWT cookie 鉴权，挂 /api/v1/admin/*）
    registerAdminRoutes(server, prisma, minioClient, minioPublicClient)

    // 4.2 生产环境：用 @fastify/static 托管 admin-web 构建产物到 /admin/*。
    // dist 不存在（如纯后端开发）就跳过，不影响启动。
    // 注：后端编译为 CommonJS，__dirname 直接可用（dist/index.js 或 tsx 下的 src/index.ts）
    const adminDist = appEnv.adminWebDist || join(__dirname, '../../admin-web/dist')
    if (existsSync(join(adminDist, 'index.html'))) {
      await server.register(fastifyStatic, {
        root: adminDist,
        prefix: '/admin/'
      })
      // SPA 回退：/admin 下的非文件路径（如 /admin/orders）一律返回 index.html，
      // 交给前端 React Router 处理。其余 404 保持 JSON 错误。
      server.setNotFoundHandler((request, reply) => {
        if (request.raw.url && request.raw.url.startsWith('/admin')) {
          return reply.sendFile('index.html')
        }
        return reply.status(404).send({ error: 'Not Found' })
      })
      server.log.info(`管理后台静态资源已挂载: /admin/  ← ${adminDist}`)
    } else {
      server.log.info('未发现 admin-web/dist，跳过静态托管（开发期由 vite dev server 提供）')
    }

    // 4.3 托管 Chrome 插件分发文件到 /ext/*（自托管强制安装：.crx + update.xml）
    // Chrome 企业策略 ExtensionInstallForcelist 会定期拉 /ext/update.xml 检查更新，
    // 并从其中 codebase 指向的 /ext/huanyu-extension.crx 下载安装。
    const extDir = join(__dirname, '../public/ext')
    if (existsSync(extDir)) {
      await server.register(fastifyStatic, {
        root: extDir,
        prefix: '/ext/',
        decorateReply: false // admin 那个 static 已 decorate 过 reply.sendFile
      })
      server.log.info(`插件分发资源已挂载: /ext/  ← ${extDir}`)
    } else {
      server.log.info('未发现 public/ext，跳过插件分发托管')
    }

    // 4.4 托管移动端 App 安装包（APK）直连下载到 /download/*
    const downloadsDir = join(__dirname, '../public/downloads')
    if (!existsSync(downloadsDir)) {
      mkdirSync(downloadsDir, { recursive: true })
    }
    await server.register(fastifyStatic, {
      root: downloadsDir,
      prefix: '/download/',
      decorateReply: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.apk')) {
          const name = basename(filePath)
          const encoded = encodeURIComponent(name)
          res.setHeader('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`)
          res.setHeader('Content-Type', 'application/vnd.android.package-archive')
        }
      }
    })
    server.log.info(`App 下载目录资源已挂载: /download/  ← ${downloadsDir}`)

    // 4.5 初始化 ASR 调度器（启动后会自动恢复 processing 状态任务）
    initScheduler({
      prisma,
      minioClient,
      minioPublicClient,
      logger: {
        info: (m) => server.log.info(m),
        warn: (m) => server.log.warn(m),
        error: (m) => server.log.error(m)
      }
    })

    // 5. 启动服务
    const port = appEnv.port
    const host = appEnv.host
    
    await server.listen({ port, host })
    server.log.info(`寰宇医道后端服务启动成功，运行在: http://${host}:${port}`)

    // 电话 ASR 完成后即时触发；微信/企微按申领号静默后台配置的时长后触发。
    startOrderAiSchedule(prisma, minioClient)
    startNativeChatImageAnalysisWorker(prisma, minioClient)

    // 每年 12 月 1 日至 31 日检查下一年节假日安排，发布后同步并停止当年检查。
    await startChineseWorkdayCalendarSync(prisma, {
      info: (m) => server.log.info(m),
      warn: (m) => server.log.warn(m),
      error: (m, err) => server.log.error({ err }, m)
    })

    // 订单业务自动提醒后台定时扫描（约住院排队、陪诊超时/防迟到、护工时间与出院前）
    startOrderReminderSchedule(prisma, {
      info: (m) => server.log.info(m),
      warn: (m) => server.log.warn(m),
      error: (m, err) => server.log.error({ err }, m)
    })
  } catch (err) {
    server.log.error({ err }, '服务启动失败')
    process.exit(1)
  }
}

start()
