import fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { PrismaClient } from '@prisma/client'
import * as Minio from 'minio'
import * as dotenv from 'dotenv'
import { registerApiRoutes, activeConnections, presenceMap } from './routes/api.js'

// 加载环境变量
dotenv.config()

const server = fastify({
  logger: true
})

const prisma = new PrismaClient()

// 初始化 MinIO 客户端
const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_HOST || 'localhost',
  port: parseInt(process.env.MINIO_PORT || '19000', 10),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'huanyu',
  secretKey: process.env.MINIO_SECRET_KEY || 'huanyu_dev_pwd'
})

async function start() {
  try {
    // 1. 注册 CORS 跨域插件
    await server.register(cors, {
      origin: true, // 允许所有来源，方便开发联调
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-Employee-Token']
    })

    // 2. 注册 WebSocket 插件
    await server.register(websocket)

    // 3. 注册 WebSocket 路由
    // 客户端使用 ws://localhost:3000/ws?token=huanyu_test_token_123&client=ext (浏览器插件)
    // 或 ws://localhost:3000/ws?token=huanyu_test_token_123&client=tray (托盘)
    server.register(async (fastifyInstance) => {
      // 注意: @fastify/websocket v10+ 的回调签名变了
      // 旧 v9: (connection, request) - connection.socket 是 WebSocket
      // 新 v10: (socket, request) - socket 直接就是 WebSocket
      fastifyInstance.get('/ws', { websocket: true }, async (socket, request) => {
        const query = request.query as any
        const token = query?.token
        const client = query?.client // 'ext' | 'tray'

        if (!token || !client || (client !== 'ext' && client !== 'tray')) {
          server.log.warn('WS 连接请求缺少 token 或 client 参数，已拒绝连接')
          try { socket.send(JSON.stringify({ error: '认证参数缺失或 client 格式错误' })) } catch {}
          socket.close()
          return
        }

        // 校验员工 token
        const employee = await prisma.employee.findUnique({
          where: { token }
        })

        if (!employee) {
          server.log.warn(`WS 连接请求使用了无效的 token: ${token}`)
          try { socket.send(JSON.stringify({ error: '无效的员工 Token' })) } catch {}
          socket.close()
          return
        }

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
        socket.on('message', async (messageBuffer) => {
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
            } else {
              server.log.info(`收到来自员工 ${employee.name} (${client}) 的消息:`, message)
            }
          } catch (err) {
            server.log.error('解析 WS 消息出错:', err)
          }
        })
      })
    })

    // 4. 注册 REST API 路由
    registerApiRoutes(server, prisma, minioClient)

    // 5. 启动服务
    const port = parseInt(process.env.PORT || '3000', 10)
    const host = process.env.HOST || '0.0.0.0'
    
    await server.listen({ port, host })
    server.log.info(`寰宇医道后端服务启动成功，运行在: http://${host}:${port}`)
  } catch (err) {
    server.log.error('服务启动失败:', err)
    process.exit(1)
  }
}

start()
