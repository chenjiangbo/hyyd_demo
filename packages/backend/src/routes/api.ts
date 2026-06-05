import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { PrismaClient, Prisma } from '@prisma/client'
import * as Minio from 'minio'
import { scheduleTranscription } from '../asr/transcribeScheduler.js'
import { summarizeCall, summarizeMessages, summarizeFull } from '../llm/summaryService.js'
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
  // 泰康 token 保活状态（由插件 content script 定时探测后上报）
  tokenOk?: boolean | null
  tokenReason?: string | null
  tokenLastCheckAt?: number | null
}
export const presenceMap = new Map<number, PresenceInfo>()

export function normalizeEmployeeCode(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim()
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

export function registerApiRoutes(
  fastify: FastifyInstance,
  prisma: PrismaClient,
  minioClient: Minio.Client,
  minioPublicClient: Minio.Client = minioClient
) {
  
  // 1. 鉴权 Hook
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // 排除健康检查等不需要鉴权的接口
    if (request.url === '/health' || request.url.startsWith('/ws')) {
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
        lastSeenAt: new Date(info.lastSeenAt).toISOString(),
        tokenOk: info.tokenOk ?? null,
        tokenReason: info.tokenReason ?? null,
        tokenLastCheckAt: info.tokenLastCheckAt
          ? new Date(info.tokenLastCheckAt).toISOString()
          : null
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
  fastify.get<{ Querystring: { source?: string; status?: string; assignedEmployeeId?: string; assignedEmployeeCode?: string } }>(
    '/api/v1/orders',
    async (request, reply) => {
      const { source, status, assignedEmployeeId, assignedEmployeeCode } = request.query

      const where: any = {}
      if (source) where.source = source
      if (status) where.status = status
      if (assignedEmployeeId) {
        where.assignedEmployeeId = parseInt(assignedEmployeeId, 10)
      } else if (assignedEmployeeCode) {
        const employee = await ensureEmployeeByCode(prisma, assignedEmployeeCode)
        where.assignedEmployeeId = employee.id
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
          orderBy: { capturedAt: 'asc' }
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
        process.env.MINIO_BUCKET_SCREENSHOTS || 'screenshots',
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

  // 8.5 通话列表 GET /api/v1/calls （当前员工，按时间倒序，附带关联订单简要信息）
  fastify.get('/api/v1/calls', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const employeeId = request.employee.id
    try {
      const calls = await prisma.call.findMany({
        where: { employeeId },
        orderBy: { startedAt: 'desc' },
        include: {
          order: { select: { id: true, sourceOrderNo: true, customerName: true, status: true } }
        }
      })
      const data = calls.map((c) => ({
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
        order: c.order
          ? {
              id: c.order.id,
              sourceOrderNo: c.order.sourceOrderNo,
              customerName: c.order.customerName,
              status: c.order.status
            }
          : null
      }))
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
      const url = await minioPublicClient.presignedGetObject(
        process.env.MINIO_BUCKET_RECORDINGS || 'recordings',
        call.recordingOssKey,
        60 * 60
      )
      return reply.send({ data: { url, expiresIn: 3600 } })
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

  // 9. 上报通话记录 POST /api/v1/calls
  fastify.post<{ Body: CreateCallPayload }>('/api/v1/calls', async (request, reply) => {
    if (!request.employee) return reply.status(401).send({ error: '未登录' })
    const employeeId = request.employee.id
    const { phone, contactName, direction, callStatus, durationSec, startedAt, orderId } = request.body

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
          contactName: contactName ?? null,
          direction,
          callStatus,
          durationSec,
          startedAt: new Date(startedAt),
          asrStatus: 'no_recording'
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
      const uploadUrl = await minioPublicClient.presignedPutObject(
        process.env.MINIO_BUCKET_RECORDINGS || 'recordings',
        ossKey,
        5 * 60
      )

      // 异步触发 Fun-ASR 转写（不阻塞响应）。客户端 PUT 完成需要时间，
      // scheduler 内部会等 MinIO 对象就绪后再提交任务。
      void scheduleTranscription(call.id)

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

  // 10.1 查询通话转写 GET /api/v1/calls/:id/transcript
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

  // 10.2 手动重新转写 POST /api/v1/calls/:id/retranscribe
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
          callStatus: c.callStatus as any,
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

  // 9. 订单详情（caseInfo + 附件 presigned URLs）GET /api/v1/orders/:id/detail
  fastify.get<{ Params: { id: string } }>('/api/v1/orders/:id/detail', async (request, reply) => {
    const orderId = parseInt(request.params.id, 10)
    try {
      const order = await prisma.order.findUnique({ where: { id: orderId } })
      if (!order) return reply.status(404).send({ error: '订单不存在' })

      const attachments = await prisma.orderAttachment.findMany({
        where: { orderId },
        orderBy: { id: 'asc' }
      })

      const attachmentsOut = await Promise.all(attachments.map(async (a) => ({
        id: a.id,
        fileType: a.fileType,
        fileName: a.fileName,
        mimeType: a.mimeType,
        byteSize: a.byteSize,
        url: await minioPublicClient.presignedGetObject(a.minioBucket, a.minioKey, 60 * 60)
      })))

      return reply.send({
        data: {
          order: {
            ...order,
            createdAt: order.createdAt.toISOString(),
            updatedAt: order.updatedAt.toISOString(),
            detailFetchedAt: order.detailFetchedAt?.toISOString() ?? null
          },
          detail: order.detailJson ?? null,
          attachments: attachmentsOut
        }
      })
    } catch (err: any) {
      fastify.log.error('查询订单详情失败:', err)
      return reply.status(500).send({ error: '查询订单详情失败: ' + err.message })
    }
  })

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
        orderBy: { capturedAt: 'asc' },
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
        prisma.message.findMany({ where: { orderId }, orderBy: { capturedAt: 'asc' } }),
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

}
