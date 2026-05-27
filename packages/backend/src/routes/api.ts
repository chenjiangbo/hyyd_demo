import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { PrismaClient } from '@prisma/client'
import * as Minio from 'minio'
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
// 员工ID -> { taikangTabOpen, mode, lastSeenAt }
export interface PresenceInfo {
  taikangTabOpen: boolean
  trackingPoolPageActive: boolean
  mode: 'pool_reader' | 'worker'
  lastSeenAt: number
}
export const presenceMap = new Map<number, PresenceInfo>()

export function registerApiRoutes(fastify: FastifyInstance, prisma: PrismaClient, minioClient: Minio.Client) {
  
  // 1. 鉴权 Hook
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // 排除健康检查等不需要鉴权的接口
    if (request.url === '/health' || request.url.startsWith('/ws')) {
      return
    }

    const token = request.headers['x-employee-token']
    if (!token || typeof token !== 'string') {
      reply.status(401).send({ error: '缺少 X-Employee-Token 请求头' })
      return
    }

    const employee = await prisma.employee.findUnique({
      where: { token }
    })

    if (!employee) {
      reply.status(401).send({ error: '无效的员工 Token' })
      return
    }

    request.employee = employee
  })

  // 2. 健康检查接口
  fastify.get('/health', async () => {
    return { status: 'OK', timestamp: new Date().toISOString() }
  })

  // 2.5 当前员工 presence 状态查询（给 Tray App 显示警告 banner 用）
  fastify.get('/api/v1/me/presence', async (request, reply) => {
    if (!request.employee) {
      return reply.status(401).send({ error: '未登录' })
    }
    const info = presenceMap.get(request.employee.id)
    const conn = activeConnections.get(request.employee.id)
    const HEARTBEAT_TIMEOUT_MS = 30_000

    if (!info) {
      // 插件从未上报过 presence
      return reply.send({
        data: {
          extConnected: !!conn?.ext,
          taikangTabOpen: false,
          trackingPoolPageActive: false,
          mode: 'worker',
          stale: true,
          lastSeenAt: null
        }
      })
    }

    const stale = Date.now() - info.lastSeenAt > HEARTBEAT_TIMEOUT_MS
    return reply.send({
      data: {
        extConnected: !!conn?.ext,
        taikangTabOpen: info.taikangTabOpen,
        trackingPoolPageActive: info.trackingPoolPageActive,
        mode: info.mode,
        stale,
        lastSeenAt: new Date(info.lastSeenAt).toISOString()
      }
    })
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

      return reply.send({ data: order })
    } catch (err: any) {
      fastify.log.error('创建/更新订单失败:', err)
      return reply.status(500).send({ error: '创建/更新订单失败: ' + err.message })
    }
  })

  // 4. 查询订单 GET /api/v1/orders
  fastify.get<{ Querystring: { source?: string; status?: string; assignedEmployeeId?: string } }>(
    '/api/v1/orders',
    async (request, reply) => {
      const { source, status, assignedEmployeeId } = request.query

      const where: any = {}
      if (source) where.source = source
      if (status) where.status = status
      if (assignedEmployeeId) {
        where.assignedEmployeeId = parseInt(assignedEmployeeId, 10)
      }

      try {
        const orders = await prisma.order.findMany({
          where,
          orderBy: { createdAt: 'desc' }
        })
        return reply.send({ data: orders })
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

  // 8. 上报微信消息 POST /api/v1/messages
  fastify.post<{ Body: CreateMessagePayload }>('/api/v1/messages', async (request, reply) => {
    const { channel, conversationName, senderName, contentText, screenshotOssKey, capturedAt, employeeId, orderId } = request.body

    try {
      let finalOrderId = orderId ?? null

      // 如果未明确提供订单ID，根据 conversationName (客户姓名) 及 employeeId 模糊匹配当前员工“已申领”或“进行中”的最近订单
      if (!finalOrderId) {
        const matchedOrder = await prisma.order.findFirst({
          where: {
            assignedEmployeeId: employeeId,
            status: { in: ['已申领', '进行中'] },
            customerName: {
              contains: conversationName // 微信会话名称匹配客户姓名
            }
          },
          orderBy: { updatedAt: 'desc' }
        })
        if (matchedOrder) {
          finalOrderId = matchedOrder.id
          fastify.log.info(`自动关联微信消息至订单: ${matchedOrder.sourceOrderNo} (ID: ${finalOrderId})`)
        }
      }

      const message = await prisma.message.create({
        data: {
          orderId: finalOrderId,
          channel,
          conversationName,
          senderName: senderName ?? null,
          contentText,
          screenshotOssKey: screenshotOssKey ?? null,
          capturedAt: new Date(capturedAt),
          employeeId
        }
      })

      return reply.send({ data: message })
    } catch (err: any) {
      fastify.log.error('微信消息上报失败:', err)
      return reply.status(500).send({ error: '微信消息上报失败: ' + err.message })
    }
  })

  // 9. 上报通话记录 POST /api/v1/calls
  fastify.post<{ Body: CreateCallPayload }>('/api/v1/calls', async (request, reply) => {
    const { employeeId, phone, direction, durationSec, startedAt, orderId } = request.body

    try {
      let finalOrderId = orderId ?? null

      // 模糊匹配号码对应订单
      if (!finalOrderId) {
        const matchedOrder = await prisma.order.findFirst({
          where: {
            assignedEmployeeId: employeeId,
            status: { in: ['已申领', '进行中'] },
            customerPhone: {
              contains: phone // 电话号码模糊包含
            }
          },
          orderBy: { updatedAt: 'desc' }
        })
        if (matchedOrder) {
          finalOrderId = matchedOrder.id
          fastify.log.info(`自动关联通话记录至订单: ${matchedOrder.sourceOrderNo} (ID: ${finalOrderId})`)
        }
      }

      const call = await prisma.call.create({
        data: {
          orderId: finalOrderId,
          employeeId,
          phone,
          direction,
          durationSec,
          startedAt: new Date(startedAt),
          asrStatus: 'pending'
        }
      })

      return reply.send({ data: call })
    } catch (err: any) {
      fastify.log.error('通话记录上报失败:', err)
      return reply.status(500).send({ error: '通话记录上报失败: ' + err.message })
    }
  })

  // 10. 上传录音与 STS 签名 POST /api/v1/recordings
  // 本接口不仅接收录音关联信息，还负责为客户端直传 MinIO 提供 STS / Presigned URL 直传凭证
  fastify.post<{ Body: CreateRecordingPayload }>('/api/v1/recordings', async (request, reply) => {
    const { callId, ossKey, durationSec } = request.body

    try {
      const call = await prisma.call.findUnique({
        where: { id: callId }
      })

      if (!call) {
        return reply.status(404).send({ error: '通话记录不存在' })
      }

      // 更新通话记录，绑定录音 OssKey，时长等
      const updatedCall = await prisma.call.update({
        where: { id: callId },
        data: {
          recordingOssKey: ossKey,
          durationSec,
          asrStatus: 'pending' // 标记待 ASR 转写
        }
      })

      // 生成客户端直接 PUT 音频文件至 MinIO 的预签名 URL (有效期 5 分钟)
      const uploadUrl = await minioClient.presignedPutObject(
        process.env.MINIO_BUCKET_RECORDINGS || 'recordings',
        ossKey,
        5 * 60
      )

      return reply.send({
        data: {
          call: updatedCall,
          uploadUrl // 客户端通过 PUT 请求此 URL 上传文件，完全不需要后端中转大流量
        }
      })
    } catch (err: any) {
      fastify.log.error('关联录音及生成直传凭证失败:', err)
      return reply.status(500).send({ error: '关联录音及生成直传凭证失败: ' + err.message })
    }
  })

  // 11. 获取详情聚合 GET /api/v1/orders/:id/aggregate
  fastify.get<{ Params: { id: string } }>('/api/v1/orders/:id/aggregate', async (request, reply) => {
    const orderId = parseInt(request.params.id, 10)

    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId }
      })

      if (!order) {
        return reply.status(404).send({ error: '订单不存在' })
      }

      // 聚合查询关联的 messages, calls, aiSummaries
      const messages = await prisma.message.findMany({
        where: { orderId },
        orderBy: { capturedAt: 'asc' }
      })

      const calls = await prisma.call.findMany({
        where: { orderId },
        orderBy: { startedAt: 'asc' }
      })

      const aiSummaries = await prisma.aiSummary.findMany({
        where: { orderId },
        orderBy: { createdAt: 'desc' }
      })

      // 组装聚合响应
      const data: OrderAggregate = {
        ...order,
        source: order.source as any,
        status: order.status as any,
        rawJson: order.rawJson as any,
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString(),
        messages: messages.map(m => ({
          ...m,
          channel: m.channel as any,
          capturedAt: m.capturedAt.toISOString()
        })),
        calls: calls.map(c => ({
          ...c,
          direction: c.direction as any,
          asrStatus: c.asrStatus as any,
          startedAt: c.startedAt.toISOString()
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
}
