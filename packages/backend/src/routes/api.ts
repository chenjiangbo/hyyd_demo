import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { PrismaClient, Prisma } from '@prisma/client'
import * as Minio from 'minio'
import { scheduleTranscription } from '../asr/transcribeScheduler.js'
import { broadcastAdmin } from './adminBus.js'
import { summarizeCall, summarizeMessages, summarizeFull } from '../llm/summaryService.js'
import { getEnv } from '../env.js'
import { extractOrderCandidate, resolveOrder, type OrderNoEntry } from '../lib/orderNoMatch.js'
import { extractKeyInfo, type KeyInfoMessage, type KeyInfoContext } from '../llm/keyInfoService.js'
import { structureMessages, type StructInput } from '../lib/messageStructure.js'
import { refreshOrderBrief } from '../jobs/orderBriefRunner.js'
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

// Tray 桌面端没有 WebSocket（纯 REST），靠它每 5s 轮询 /api/v1/me/presence 当心跳。
// 这里记录每个员工最近一次该轮询的时间戳，给管理后台判断"Tray 是否在线"。
// 员工ID -> 最近一次 /me/presence 命中的毫秒时间戳
export const trayRestSeenMap = new Map<number, number>()

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
  const env = getEnv()
  
  // 1. 鉴权 Hook
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // 排除健康检查等不需要鉴权的接口。
    // - /api/v1/admin/*：走独立管理员 JWT cookie 鉴权（见 routes/admin.ts）
    // - /admin/*：管理后台前端静态资源（@fastify/static），由前端自身登录态控制
    // 这些都不参与员工 X-Employee-Code 体系，直接放行。
    if (
      request.url === '/health' ||
      request.url.startsWith('/ws') ||
      request.url.startsWith('/api/v1/admin') ||
      request.url.startsWith('/admin') ||
      request.url.startsWith('/ext') // 插件分发文件（.crx / update.xml），公开资源
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
    // Tray 桌面端心跳：记录本次轮询时间，供管理后台判断 tray 在线
    trayRestSeenMap.set(request.employee.id, Date.now())

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
          orderBy: { createdAt: 'desc' },
          include: {
            // 录音条数 + 最新录音时间
            _count: { select: { calls: true, materials: true } },
            calls: {
              select: { startedAt: true },
              orderBy: { startedAt: 'desc' },
              take: 1
            },
            // 拉每单一条最近的素材 + 全量类型计数（一次查询，
            // 顺手在 map 里分桶；素材体量小不会爆查询）
            materials: {
              select: { type: true, createdAt: true },
              orderBy: { createdAt: 'desc' }
            }
          }
        })
        // 给每单补几个 trayapp 工作台要展示的派生字段：
        //   - claimedAt：申领时间。优先用泰康 rawJson 里的几种时间字段，
        //     最后兜底到我们自己的 createdAt。
        //   - audioCount：已采到的录音条数（calls 表实际行数）。
        //   - textCount / imageCount：粘贴的文字 / 图片素材数（materials 表）
        //   - materialCount：三类合计
        //   - lastMaterialAt：任何素材的最近一次入库时间（取 max(call, material)）
        const data = orders.map((o: any) => {
          const raw = (o.rawJson ?? {}) as Record<string, unknown>
          // chrome 插件抓的详情扁平挂在 detailJson.recommendations 下
          const rec = ((o.detailJson as any)?.recommendations ?? {}) as Record<string, unknown>
          const claimedAt =
            (raw.mmgrApplyDate as string | undefined) ??
            (raw.applicationDate as string | undefined) ??
            (raw.applyDate as string | undefined) ??
            (raw.applyTime as string | undefined) ??
            o.createdAt.toISOString()

          // 泰康个人池列表接口大多数业务字段都不返回（只有订单号 / 状态 / 业务名等几个）。
          // 真正的医院 / 科室 / 医生 / 手机号 / 就诊日期 都在 recommendations 里。
          // 这里统一按"列表 rawJson 优先 → 详情 recommendations 兜底"派生，
          // 让工作台一列一个字段读就行，不用再翻嵌套对象。
          const customerPhoneRow =
            (raw.paMobile as string | undefined) ??
            (rec.paMobile as string | undefined) ??
            (rec.ecpPhone as string | undefined) ??
            o.customerPhone ??
            null
          const hospitalRow =
            (raw.hospital as string | undefined) ??
            (rec.intendHos as string | undefined) ??
            (rec.visitingHospital as string | undefined) ??
            o.hospital ??
            null
          const deptRow =
            (raw.dept as string | undefined) ??
            (rec.intendDept as string | undefined) ??
            o.dept ??
            null
          const doctorRow =
            (raw.doctor as string | undefined) ??
            (rec.intendDoc as string | undefined) ??
            o.doctor ??
            null
          const intendDateRow =
            (raw.intendDate as string | undefined) ??
            (rec.intendDate as string | undefined) ??
            null
          const intendDateAmorpmRow =
            (raw.intendDateAmorpm as string | undefined) ??
            (rec.intendDateAmorpm as string | undefined) ??
            null

          const audioCount = o._count?.calls ?? 0
          const textCount = (o.materials ?? []).filter((m: any) => m.type === 'text').length
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

          // 删掉 include 出来的辅助字段，给前端返回扁平结构
          const { _count, calls, materials, ...rest } = o
          void _count
          void calls
          void materials
          return {
            ...rest,
            customerPhone: customerPhoneRow,
            hospital: hospitalRow,
            dept: deptRow,
            doctor: doctorRow,
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
        return reply.send({ data })
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
    const { channel, conversationName, senderName, contentText, screenshotOssKey, capturedAt, employeeId, orderId } = request.body

    try {
      let finalOrderId = orderId ?? null

      // 关联策略（优先级）：
      //  1) 标题里抽到订单号候选(COD/CCOD/OD/fwyy) → 在该员工订单里"归一+编辑距离≤2"模糊解析
      //     - 唯一最近 → 关联
      //     - 找不到(none)/多单并列(ambiguous) → 存 UnmatchedOrderRef 待客户/人工确认
      //  2) 没有订单号候选 → 退回按 conversationName(客户姓名) 模糊匹配
      if (!finalOrderId) {
        const cand = extractOrderCandidate(conversationName)
        if (cand) {
          // 取该员工所有订单的已知订单号（列 source_order_no + rawJson.applyNo / crmApplyNo）
          const orders = await prisma.order.findMany({
            where: { assignedEmployeeId: employeeId },
            select: { id: true, sourceOrderNo: true, rawJson: true }
          })
          const entries: OrderNoEntry[] = orders.map((o) => {
            const raw = (o.rawJson ?? {}) as Record<string, unknown>
            const nos = [o.sourceOrderNo, raw.applyNo, raw.crmApplyNo].filter(
              (x): x is string => typeof x === 'string' && x.length > 0
            )
            return { orderId: o.id, nos }
          })
          const r = resolveOrder(cand.raw, entries, 2)
          if (r.status === 'matched') {
            finalOrderId = r.orderId
            fastify.log.info(`订单号模糊解析命中: "${cand.raw}" → 订单 ${r.orderId}（距离 ${r.dist}）`)
          } else {
            // 有订单号但解析不到 → 存待确认（同一员工+候选去重，重复出现则计数+刷新截图/时间）
            await prisma.unmatchedOrderRef.upsert({
              where: { employee_candidate: { employeeId, candidate: cand.raw } },
              create: {
                employeeId,
                channel,
                conversationName,
                candidate: cand.raw,
                candidateKind: cand.kind,
                reason: r.status === 'ambiguous' ? 'ambiguous' : 'no_match',
                bestDist: r.status === 'ambiguous' ? r.bestDist : r.bestDist,
                candidateOrderIds: r.status === 'ambiguous' ? r.orderIds : undefined,
                screenshotOssKey: screenshotOssKey ?? null,
                capturedAt: new Date(capturedAt)
              },
              update: {
                seenCount: { increment: 1 },
                conversationName,
                reason: r.status === 'ambiguous' ? 'ambiguous' : 'no_match',
                bestDist: r.status === 'ambiguous' ? r.bestDist : r.bestDist,
                candidateOrderIds: r.status === 'ambiguous' ? r.orderIds : Prisma.JsonNull,
                screenshotOssKey: screenshotOssKey ?? null,
                capturedAt: new Date(capturedAt)
              }
            })
            fastify.log.info(`订单号待确认: "${cand.raw}" (${r.status})，已存 UnmatchedOrderRef`)
          }
        } else {
          // 没抽到订单号 → 退回按客户姓名模糊匹配“已申领/进行中”的最近订单
          const matchedOrder = await prisma.order.findFirst({
            where: {
              assignedEmployeeId: employeeId,
              status: { in: ['已申领', '进行中'] },
              customerName: { contains: conversationName }
            },
            orderBy: { updatedAt: 'desc' }
          })
          if (matchedOrder) {
            finalOrderId = matchedOrder.id
            fastify.log.info(`按姓名关联微信消息至订单: ${matchedOrder.sourceOrderNo} (ID: ${finalOrderId})`)
          }
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
    return reply.send({ data: rows })
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

      await prisma.unmatchedOrderRef.update({
        where: { id },
        data: { status: 'confirmed', resolvedOrderId: orderId }
      })
      // 回填：该员工、该会话名下、还没关联订单的消息，挂到确认的订单上
      const backfilled = await prisma.message.updateMany({
        where: { employeeId: ref.employeeId, conversationName: ref.conversationName, orderId: null },
        data: { orderId }
      })
      return reply.send({ data: { ok: true, backfilledMessages: backfilled.count } })
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
          phone_list: string[] | null
        }>
      >`
        SELECT
          id,
          source_order_no,
          customer_name,
          status,
          updated_at,
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
      } => ({
        id: o.id,
        sourceOrderNo: o.source_order_no,
        customerName: o.customer_name,
        status: o.status
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
      const url = await minioPublicClient.presignedGetObject(
        env.minioBucketRecordings,
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

      // 按手机号匹配订单：customer_phone (列) / recommendations.paMobile / recommendations.ecpPhone 三处任一命中。
      // 状态不做过滤，泰康原文 status 类型很多（"待处理 / 待分配医学陪诊 / 已完成"...），
      // 旧代码的 status IN ('已申领','进行中') 在新数据下永远 false。
      // 多条命中时取 updated_at 最新那条作 Call.orderId 兜底；GET /calls 会再列全部匹配。
      if (!finalOrderId) {
        const normPhone = (phone ?? '').replace(/\D/g, '')
        if (normPhone) {
          const matched = await prisma.$queryRaw<Array<{ id: number; source_order_no: string }>>`
            SELECT id, source_order_no
              FROM orders
             WHERE assigned_employee_id = ${employeeId}
               AND (
                 regexp_replace(COALESCE(customer_phone, ''), '\D', '', 'g') = ${normPhone}
                 OR regexp_replace(COALESCE(detail_json->'recommendations'->>'paMobile', ''), '\D', '', 'g') = ${normPhone}
                 OR regexp_replace(COALESCE(detail_json->'recommendations'->>'ecpPhone', ''), '\D', '', 'g') = ${normPhone}
               )
             ORDER BY updated_at DESC
             LIMIT 1
          `
          if (matched[0]) {
            finalOrderId = matched[0].id
            fastify.log.info(`自动关联通话至订单: ${matched[0].source_order_no} (id=${finalOrderId})`)
          }
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

      // 推送给在线管理后台
      broadcastAdmin({
        type: 'call_created',
        payload: { employeeId, orderId: finalOrderId ?? null }
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
        env.minioBucketRecordings,
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

}
