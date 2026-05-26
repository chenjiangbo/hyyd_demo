import fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { PrismaClient } from '@prisma/client'
import * as Minio from 'minio'
import * as dotenv from 'dotenv'
import { registerApiRoutes, activeConnections } from './routes/api.js'

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
      fastifyInstance.get('/ws', { websocket: true }, async (connection, request) => {
        const query = request.query as any
        const token = query?.token
        const client = query?.client // 'ext' | 'tray'

        if (!token || !client || (client !== 'ext' && client !== 'tray')) {
          server.log.warn('WS 连接请求缺少 token 或 client 参数，已拒绝连接')
          connection.socket.send(JSON.stringify({ error: '认证参数缺失或 client 格式错误' }))
          connection.destroy()
          return
        }

        // 校验员工 token
        const employee = await prisma.employee.findUnique({
          where: { token }
        })

        if (!employee) {
          server.log.warn(`WS 连接请求使用了无效的 token: ${token}`)
          connection.socket.send(JSON.stringify({ error: '无效的员工 Token' }))
          connection.destroy()
          return
        }

        const employeeId = employee.id
        server.log.info(`员工 ${employee.name} (${client}) 建立了 WebSocket 连接`)

        // 缓存连接
        const currentConn = activeConnections.get(employeeId) || {}
        if (client === 'ext') {
          currentConn.ext = connection.socket
        } else {
          currentConn.tray = connection.socket
        }
        activeConnections.set(employeeId, currentConn)

        // 发送确认连接成功的心跳消息
        connection.socket.send(JSON.stringify({
          type: 'connection_established',
          client,
          employee: { id: employee.id, name: employee.name }
        }))

        // 监听断开
        connection.socket.on('close', () => {
          server.log.info(`员工 ${employee.name} (${client}) 断开了 WebSocket 连接`)
          const conn = activeConnections.get(employeeId)
          if (conn) {
            if (client === 'ext') delete conn.ext
            if (client === 'tray') delete conn.tray
            if (!conn.ext && !conn.tray) {
              activeConnections.delete(employeeId)
            } else {
              activeConnections.set(employeeId, conn)
            }
          }
        })

        // 监听消息（例如心跳包）
        connection.socket.on('message', (messageBuffer) => {
          try {
            const messageStr = messageBuffer.toString()
            const message = JSON.parse(messageStr)
            
            if (message.type === 'ping') {
              connection.socket.send(JSON.stringify({ type: 'pong' }))
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
