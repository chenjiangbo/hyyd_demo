import fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import { PrismaClient } from '@prisma/client'
import * as Minio from 'minio'
import * as dotenv from 'dotenv'
import { registerApiRoutes, activeConnections, presenceMap, ensureEmployeeByCode, normalizeEmployeeCode } from './routes/api.js'
import { startOrderBriefScheduler } from './jobs/orderBriefScheduler.js'
import { registerAdminRoutes, ADMIN_COOKIE, verifyAdminToken } from './routes/admin.js'
import { addAdminSocket, removeAdminSocket } from './routes/adminBus.js'
import { saveOrderDetailBundle } from './orderDetail.js'
import { initScheduler } from './asr/transcribeScheduler.js'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getEnv } from './env.js'

if (process.env.NODE_ENV !== 'production') {
  // 开发期允许从 .env 启动；生产由 Docker/宿主机显式注入环境变量。
  dotenv.config({ override: true })
}

const appEnv = getEnv()

const server = fastify({
  logger: true
})

const prisma = new PrismaClient()

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
  const buckets = ['order-attachments', 'recordings', 'screenshots', 'materials']
  for (const name of buckets) {
    const exists = await minioClient.bucketExists(name).catch(() => false)
    if (!exists) {
      await minioClient.makeBucket(name).catch((e) => {
        // 已存在或并发创建时忽略
        if (!String(e?.message || '').includes('exists')) throw e
      })
      server.log.info(`MinIO bucket 已创建: ${name}`)
    }
  }
}

async function start() {
  try {
    await ensureBuckets()

    // 1. 注册 CORS 跨域插件
    await server.register(cors, {
      origin: true, // 允许所有来源，方便开发联调
      credentials: true, // 允许携带 cookie（管理后台 admin JWT cookie 用）
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-Employee-Code']
    })

    // 1.5 注册 cookie 插件（管理后台鉴权用 httpOnly cookie）
    await server.register(cookie)

    // 2. 注册 WebSocket 插件
    await server.register(websocket)

    // 3. 注册 WebSocket 路由
    // 客户端使用 ws://localhost:3000/ws?employeeCode=zhangsan&client=ext (浏览器插件)
    // 或 ws://localhost:3000/ws?employeeCode=zhangsan&client=tray (托盘)
    server.register(async (fastifyInstance) => {
      // 注意: @fastify/websocket v10+ 的回调签名变了
      // 旧 v9: (connection, request) - connection.socket 是 WebSocket
      // 新 v10: (socket, request) - socket 直接就是 WebSocket
      fastifyInstance.get('/ws', { websocket: true }, async (socket, request) => {
        const query = request.query as any
        const employeeCode = normalizeEmployeeCode(query?.employeeCode)
        const client = query?.client // 'ext' | 'tray'

        if (!employeeCode || !client || (client !== 'ext' && client !== 'tray')) {
          server.log.warn('WS 连接请求缺少 employeeCode 或 client 参数，已拒绝连接')
          try { socket.send(JSON.stringify({ error: '认证参数缺失或 client 格式错误' })) } catch {}
          socket.close()
          return
        }

        const employee = await ensureEmployeeByCode(prisma, employeeCode)

        const employeeId = employee.id
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
          employee: { id: employee.id, name: employee.name }
        }))

        // 注：现行 chrome 插件已不再处理任何 command（claim / fetch_detail），
        // 改为定时只读个人池 + 主动上报。原本 ext 重连后补推 pending 指令的逻辑
        // 已无消费方，删除。Command 表 + REST 入口暂留作历史兼容。

        // 监听断开
        socket.on('close', () => {
          server.log.info(`员工 ${employee.name} (${client}) 断开了 WebSocket 连接`)
          const conn = activeConnections.get(employeeId)
          if (conn) {
            if (client === 'ext') delete conn.ext
            if (client === 'tray') delete conn.tray
            if (!conn.ext && !conn.tray) {
              activeConnections.delete(employeeId)
              // 完全离线，清理 presence
              presenceMap.delete(employeeId)
            } else {
              activeConnections.set(employeeId, conn)
            }
          }
        })

        // 监听消息（例如心跳包、同步订单）
        socket.on('message', async (messageBuffer: Buffer) => {
          try {
            const messageStr = messageBuffer.toString()
            const message = JSON.parse(messageStr)
            
            if (message.type === 'ping') {
              socket.send(JSON.stringify({ type: 'pong' }))
            } else if (message.type === 'PRESENCE') {
              // 插件上报的"在线/泰康标签"状态心跳
              presenceMap.set(employeeId, {
                taikangTabOpen: !!message.taikangTabOpen,
                trackingPoolPageActive: !!message.trackingPoolPageActive,
                lastSeenAt: Date.now()
              })
            } else if (message.type === 'ORDERS_SYNCED') {
              server.log.info(`收到员工 ${employee.name} 同步的订单数据: ${message.payload.length} 条`)
              const orders = message.payload
              if (Array.isArray(orders)) {
                for (const orderData of orders) {
                  // 个人池里的订单本就是"已申领到当前员工"的，
                  // 必须 assign 到 employeeId，否则 trayapp"我的工作台"
                  // 按 assignedEmployeeCode 过滤会查不到。
                  //
                  // status 直接存泰康原文 orderStateName（如"待处理 / 待就诊
                  // / 待支付 / 已完成"等），trayapp 单列列表当标签展示。
                  // 旧的"候选/已申领"四态枚举不再使用。
                  const taikangStatus = orderData.status ?? '未知'
                  const newState = orderData.orderState != null ? String(orderData.orderState) : null

                  // 先取旧状态码，用于判断是否需要记一条状态变更历史
                  const existing = await prisma.order.findUnique({
                    where: {
                      source_sourceOrderNo: { source: 'taikang', sourceOrderNo: orderData.orderId }
                    },
                    select: { orderState: true }
                  })

                  const saved = await prisma.order.upsert({
                    where: {
                      source_sourceOrderNo: {
                        source: 'taikang',
                        sourceOrderNo: orderData.orderId
                      }
                    },
                    update: {
                      status: taikangStatus,
                      assignedEmployeeId: employeeId,
                      orderState: newState,
                      rawJson: orderData
                    },
                    create: {
                      source: 'taikang',
                      sourceOrderNo: orderData.orderId,
                      customerName: orderData.patientName || '未知',
                      status: taikangStatus,
                      assignedEmployeeId: employeeId,
                      orderState: newState,
                      rawJson: orderData
                    }
                  })

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
                }
              }
            } else if (message.type === 'TAIKANG_TOKEN_STATUS') {
              // 插件保活探测结果：更新 presenceMap 给托盘读
              const cur = presenceMap.get(employeeId)
              if (cur) {
                cur.tokenOk = !!message.ok
                cur.tokenReason = message.reason ?? null
                cur.tokenLastCheckAt = message.at || Date.now()
                presenceMap.set(employeeId, cur)
              }
              server.log.info(
                `泰康 token 保活: ${message.ok ? 'OK' : 'FAIL: ' + (message.reason ?? '?')}  员工=${employee.name}`
              )
            } else if (message.type === 'ORDER_DETAIL_FETCHED') {
              // 插件抓完订单详情，把数据 + 附件回传
              const payload = message.payload || {}
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
                  const result = await saveOrderDetailBundle(prisma, minioClient, {
                    sourceOrderNo: payload.sourceOrderNo,
                    detail: payload.detail || {},
                    attachments: payload.attachments || [],
                    fingerprint: payload.fingerprint
                  })
                  server.log.info(`订单详情入库成功: orderId=${result.orderId} 附件=${result.attachmentCount} 跳过=${result.skipped}`)
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
                } catch (e) {
                  server.log.error('保存订单详情失败:', e as any)
                }
              }
            } else if (message.type === 'SYNC_FINGERPRINTS') {
              // 插件把本地全量指纹推来对账：补齐后端缺失的 detailFingerprint，
              // 使换机/清缓存的新插件能从后端拿到完整基线、避免重抓。
              const fps = (message.payload || {}) as Record<string, unknown>
              const entries = Object.entries(fps).filter(([, v]) => typeof v === 'string')
              let n = 0
              for (const [sourceOrderNo, fp] of entries) {
                const r = await prisma.order.updateMany({
                  where: { source: 'taikang', sourceOrderNo, assignedEmployeeId: employeeId },
                  data: { detailFingerprint: fp as string }
                })
                n += r.count
              }
              server.log.info(`指纹基线对账：更新 ${n}/${entries.length} 条 (员工 ${employee.name})`)
            } else if (message.type === 'GET_FINGERPRINTS') {
              // 插件启动时请求"已采订单的状态指纹基线"，用于跨刷新/换机的增量，
              // 避免本地无缓存时全量重抓泰康。只回该员工名下、已抓过详情的订单。
              const rows = await prisma.order.findMany({
                where: {
                  source: 'taikang',
                  assignedEmployeeId: employeeId,
                  detailFingerprint: { not: null }
                },
                select: { sourceOrderNo: true, detailFingerprint: true }
              })
              const map: Record<string, string> = {}
              for (const r of rows) {
                if (r.detailFingerprint) map[r.sourceOrderNo] = r.detailFingerprint
              }
              socket.send(JSON.stringify({ type: 'FINGERPRINTS_BASELINE', payload: map }))
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
    registerAdminRoutes(server, prisma, minioPublicClient)

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

    // 订单 AI 滚动简报：后台扫描器（静默5min/攒够10条 → 自动刷新简报）
    startOrderBriefScheduler(prisma, minioClient)
  } catch (err) {
    server.log.error({ err }, '服务启动失败')
    process.exit(1)
  }
}

start()
