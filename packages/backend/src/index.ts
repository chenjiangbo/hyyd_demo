import fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { PrismaClient } from '@prisma/client'
import * as Minio from 'minio'
import * as dotenv from 'dotenv'
import { registerApiRoutes, activeConnections, presenceMap, ensureEmployeeByCode, normalizeEmployeeCode } from './routes/api.js'
import { saveOrderDetailBundle } from './orderDetail.js'
import { initScheduler } from './asr/transcribeScheduler.js'

// 加载项目 .env。现场/本地切换时以仓库 .env 为准，避免继承旧 shell 环境。
dotenv.config({ override: true })

const server = fastify({
  logger: true
})

const prisma = new PrismaClient()

// 初始化 MinIO 客户端
// endPoint 是 backend → MinIO 内部访问（同机走 localhost 最稳）。
// presigned URL 给前端用，前端可能在 Windows VM 上，必须用 Mac LAN IP。
// 通过 MINIO_PUBLIC_HOST 区分：未配置时退化为 endPoint。
const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_HOST || 'localhost',
  port: parseInt(process.env.MINIO_PORT || '19000', 10),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'huanyu',
  secretKey: process.env.MINIO_SECRET_KEY || 'huanyu_dev_pwd'
})

// 给"对外可访问的 MinIO 客户端"做一个 presigned URL 专用实例
const minioPublicHost = process.env.MINIO_PUBLIC_HOST
const minioPublicPort = parseInt(process.env.MINIO_PUBLIC_PORT || process.env.MINIO_PORT || '19000', 10)
const minioPublicClient = minioPublicHost
  ? new Minio.Client({
      endPoint: minioPublicHost,
      port: minioPublicPort,
      useSSL: false,
      accessKey: process.env.MINIO_ACCESS_KEY || 'huanyu',
      secretKey: process.env.MINIO_SECRET_KEY || 'huanyu_dev_pwd'
    })
  : minioClient

// 确保 MinIO 桶存在（启动时调用）
async function ensureBuckets() {
  const buckets = ['order-attachments', 'recordings', 'screenshots']
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
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-Employee-Code']
    })

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

        // 重连后补推该员工"应得的 pending 指令"
        // 背景：Chrome MV3 service worker 会被浏览器休眠（约 30s 不活动），
        // 期间收到的 WS 推送都会丢失。重连时把 DB 里 pending 的指令翻出来重推一次。
        if (client === 'ext') {
          try {
            const pendingCmds = await prisma.command.findMany({
              where: {
                target: 'ext',
                status: 'pending'
              },
              orderBy: { createdAt: 'asc' }
            })
            // 仅推送：payload.orderId 对应订单的 assignedEmployeeId === 当前员工
            const matched: typeof pendingCmds = []
            for (const cmd of pendingCmds) {
              const payload = cmd.payloadJson as any
              if (!payload?.orderId) continue
              const order = await prisma.order.findUnique({ where: { id: Number(payload.orderId) } })
              if (order?.assignedEmployeeId === employeeId) matched.push(cmd)
            }
            if (matched.length > 0) {
              server.log.info(`补推 ${matched.length} 条 pending 指令给员工 ${employee.name} (ext)`)
              for (const cmd of matched) {
                socket.send(JSON.stringify({
                  type: 'command',
                  commandId: cmd.id,
                  action: cmd.action,
                  payload: cmd.payloadJson
                }))
              }
            }
          } catch (e) {
            server.log.error('补推 pending 指令失败:', e as any)
          }
        }

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
                mode: message.mode || 'worker',
                lastSeenAt: Date.now()
              })
            } else if (message.type === 'ORDERS_SYNCED') {
              server.log.info(`收到员工 ${employee.name} 同步的订单数据: ${message.payload.length} 条`)
              const orders = message.payload
              if (Array.isArray(orders)) {
                for (const orderData of orders) {
                  // 将抓取到的订单入库
                  await prisma.order.upsert({
                    where: {
                      source_sourceOrderNo: {
                        source: 'taikang',
                        sourceOrderNo: orderData.orderId
                      }
                    },
                    update: {
                      status: orderData.status === '待申领' ? '候选' : '已申领', // 根据实际抓取状态映射
                      rawJson: orderData
                    },
                    create: {
                      source: 'taikang',
                      sourceOrderNo: orderData.orderId,
                      customerName: orderData.patientName || '未知',
                      status: orderData.status === '待申领' ? '候选' : '已申领',
                      rawJson: orderData
                    }
                  })
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
                    attachments: payload.attachments || []
                  })
                  server.log.info(`订单详情入库成功: orderId=${result.orderId} 附件=${result.attachmentCount} 跳过=${result.skipped}`)
                  // 把该订单所有 pending 的抓详情指令 mark 为 done，
                  // 否则下次插件 SW 重连时会再补推一遍，造成重复抓取。
                  await prisma.command.updateMany({
                    where: {
                      target: 'ext',
                      status: 'pending',
                      action: { in: ['claim', 'fetch_detail'] },
                      payloadJson: { path: ['orderId'], equals: result.orderId }
                    },
                    data: { status: 'done', executedAt: new Date() }
                  }).catch(() => {/* JSON path 查询失败兜底，宽松处理 */})
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
            } else {
              server.log.info(`收到来自员工 ${employee.name} (${client}) 的消息:`, message)
            }
          } catch (err) {
            server.log.error('解析 WS 消息出错:', err as any)
          }
        })
      })
    })

    // 4. 注册 REST API 路由
    registerApiRoutes(server, prisma, minioClient, minioPublicClient)

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
    const port = parseInt(process.env.PORT || '3000', 10)
    const host = process.env.HOST || '0.0.0.0'
    
    await server.listen({ port, host })
    server.log.info(`寰宇医道后端服务启动成功，运行在: http://${host}:${port}`)
  } catch (err) {
    server.log.error({ err }, '服务启动失败')
    process.exit(1)
  }
}

start()
