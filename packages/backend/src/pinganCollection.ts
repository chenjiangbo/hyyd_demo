import { createHash } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import type * as Minio from 'minio'
import { ATTACHMENT_BUCKET } from './orderDetail.js'
import { enqueuePinganMysqlOrder } from './services/pinganMysqlOrderWorker.js'
import { pinganObject, pinganOrderInfo } from './services/pinganMysqlMainOrder.js'
import { parseShanghaiDateTime, shanghaiDateKey } from './time/shanghaiTime.js'

const ORDER_TYPES = new Map([
  ['ORDINARY_REGISTER', 'VIP 挂号'],
  ['HOSPITALIZE_DOMESTIC', '国内住院']
])
const MAX_ATTACHMENT_BYTES = 150 * 1024 * 1024

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`${label} 无效`)
  return value.trim()
}

function pinganUserId(value: unknown): string {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof id !== 'string' || !/^\d{1,40}$/.test(id)) throw new Error('平安登录用户 ID 无效')
  return id
}

function optionalHandlerUserId(value: unknown): string | null {
  if (value == null || value === '') return null
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof id !== 'string' || !/^\d{1,40}$/.test(id)) throw new Error('平安处理人 ID 无效')
  return id
}

function displayNameOf(value: unknown): string | null {
  return typeof value === 'string' ? value.trim().slice(0, 200) || null : null
}

function dateValue(value: unknown, label: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} 无效`)
  const parsed = parseShanghaiDateTime(value)
  if (Number.isNaN(parsed.getTime()) || shanghaiDateKey(parsed) !== value) throw new Error(`${label} 无效`)
  return parsed
}

function dateTimeValue(value: unknown, label: string): Date {
  if (typeof value !== 'string') throw new Error(`${label} 无效`)
  const parsed = parseShanghaiDateTime(value)
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} 无效`)
  return parsed
}

function jsonObject(value: unknown, label: string): Prisma.InputJsonObject {
  if (!isRecord(value)) throw new Error(`${label} 必须是 JSON 对象`)
  return value as Prisma.InputJsonObject
}

function countValue(value: unknown, label: string): number | null {
  if (value == null) return null
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} 无效`)
  return Number(value)
}

class PinganCollectionError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
  }
}

function collectionErrorStatus(error: unknown): number {
  if (error instanceof PinganCollectionError) return error.statusCode
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return 409
  return 400
}

function runIdValue(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('采集批次 ID 无效')
  }
  return value
}

async function requireCollector(prisma: PrismaClient, userId: string) {
  const employee = await prisma.employee.findUnique({
    where: { pinganId: userId },
    select: { id: true, enabled: true, name: true }
  })
  if (!employee) {
    throw new PinganCollectionError(403, '当前平安登录账号未配置到寰宇员工表的 pingan_id')
  }
  if (!employee.enabled) {
    throw new PinganCollectionError(403, '平安登录账号对应的寰宇员工已停用')
  }
  return employee
}

async function requireRun(prisma: PrismaClient, runId: unknown, userId: string, employeeId: number) {
  const run = await prisma.pinganCollectionRun.findUnique({
    where: { id: runIdValue(runId) },
    select: { id: true, pinganUserId: true, collectorEmployeeId: true, collectorDisplayName: true }
  })
  if (!run || run.pinganUserId !== userId || run.collectorEmployeeId !== employeeId) {
    throw new PinganCollectionError(404, '采集批次不存在或与平安账号、采集员工不匹配')
  }
  return run
}

export function registerPinganIngestRoutes(
  fastify: FastifyInstance,
  prisma: PrismaClient,
  minio: Minio.Client,
  mysqlOrderJobsEnabled = false
): void {
  fastify.post('/api/v1/pingan/identify', async (request, reply) => {
    try {
      const body = request.body as JsonRecord
      const id = pinganUserId(body?.pinganUserId)
      const employee = await requireCollector(prisma, id)
      const displayName = displayNameOf(body.displayName) ?? employee.name
      return reply.send({ data: { pinganUserId: id, collectorEmployeeId: employee.id, displayName } })
    } catch (error) {
      return reply.status(collectionErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  fastify.post('/api/v1/pingan/runs', async (request, reply) => {
    try {
      const body = request.body as JsonRecord
      const userId = pinganUserId(body?.pinganUserId)
      const run = isRecord(body?.run) ? body.run : null
      if (!run) throw new Error('采集批次缺失')
      const id = runIdValue(run.id)
      const startedAt = dateTimeValue(run.startedAt, '采集开始时间')
      const state = requiredString(run.state, '采集状态', 32)
      if (!['running', 'completed', 'partial_failure', 'error'].includes(state)) throw new Error('采集状态无效')
      const employee = await requireCollector(prisma, userId)
      const data = {
        installDate: dateValue(run.installDate, '插件安装日期'),
        scanStartDate: dateValue(run.scanStartDate, '查询起始日期'),
        scanEndDate: dateValue(run.scanEndDate, '查询结束日期'),
        startedAt,
        completedAt: run.completedAt == null ? null : dateTimeValue(run.completedAt, '采集结束时间'),
        state,
        uniqueOrderCount: countValue(run.uniqueOrderCount, '订单数'),
        listRows: countValue(run.listRows, '列表行数'),
        detailCount: countValue(run.detailCount, '详情数'),
        decryptedFieldCount: countValue(run.decryptedFieldCount, '解密字段数'),
        attachmentCount: countValue(run.attachmentCount, '附件数'),
        errorCount: countValue(run.errorCount, '失败数'),
        error: typeof run.error === 'string' ? run.error.slice(0, 4000) : null
      }
      const saved = await prisma.pinganCollectionRun.upsert({
        where: { id, pinganUserId: userId, collectorEmployeeId: employee.id },
        create: {
          id, pinganUserId: userId, collectorEmployeeId: employee.id,
          collectorDisplayName: displayNameOf(run.collectorDisplayName) ?? employee.name, ...data
        },
        update: data
      })
      return reply.send({ data: { id: saved.id, state: saved.state } })
    } catch (error) {
      return reply.status(collectionErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  fastify.post('/api/v1/pingan/pages', async (request, reply) => {
    try {
      const body = request.body as JsonRecord
      const userId = pinganUserId(body?.pinganUserId)
      const page = isRecord(body?.page) ? body.page : null
      if (!page) throw new Error('列表分页记录缺失')
      const collector = await requireCollector(prisma, userId)
      const { id: runId } = await requireRun(prisma, page.runId, userId, collector.id)
      const orderType = requiredString(page.orderType, '订单类型', 80)
      if (!ORDER_TYPES.has(orderType)) throw new Error('订单类型不在采集范围内')
      const pageNum = countValue(page.pageNum, '页码')
      const pageCount = countValue(page.pageCount, '总页数')
      const pageSize = countValue(page.pageSize, '每页数量')
      const total = countValue(page.total, '接口总数')
      const rowCount = countValue(page.rowCount, '当前页记录数')
      if (!pageNum || pageNum < 1 || pageCount == null || !pageSize || pageSize < 1 || total == null || rowCount == null) {
        throw new Error('分页统计数据不完整')
      }
      const data = {
        pageCount, pageSize, total, rowCount,
        state: requiredString(page.state, '分页状态', 32),
        capturedAt: dateTimeValue(page.capturedAt, '分页采集时间'),
        completedAt: page.completedAt == null ? null : dateTimeValue(page.completedAt, '分页完成时间'),
        query: jsonObject(page.query, '列表查询参数')
      }
      await prisma.pinganCollectionPage.upsert({
        where: { runId_orderType_pageNum: { runId, orderType, pageNum } },
        create: { runId, orderType, pageNum, ...data },
        update: data
      })
      return reply.send({ data: { saved: true } })
    } catch (error) {
      return reply.status(collectionErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  fastify.post('/api/v1/pingan/orders', async (request, reply) => {
    try {
      const body = request.body as JsonRecord
      const userId = pinganUserId(body?.pinganUserId)
      const order = isRecord(body?.order) ? body.order : null
      if (!order) throw new Error('订单数据缺失')
      const orderId = requiredString(order.orderId, '平安订单号', 120)
      const orderType = requiredString(order.orderType, '订单类型', 80)
      const orderTypeName = requiredString(order.orderTypeStr, '订单类型名称', 120)
      if (!ORDER_TYPES.has(orderType)) throw new Error('订单类型不在采集范围内')
      const status = requiredString(order.status, '订单状态', 120)
      const statusName = requiredString(order.statusStr, '订单状态名称', 160)
      const collector = await requireCollector(prisma, userId)
      const run = await requireRun(prisma, body.runId, userId, collector.id)
      const write = async (tx: Prisma.TransactionClient) => {
        const now = new Date()
        const existingOrder = await tx.pinganOrder.findUnique({
          where: { pinganUserId_orderId: { pinganUserId: userId, orderId } },
          select: {
            status: true, statusName: true, employeeId: true, lastSeenRunId: true,
            detailJson: true, decryptedFields: true
          }
        })
        if (existingOrder) {
          const statusChanged = existingOrder.status !== status || existingOrder.statusName !== statusName
          const supplement: Pick<Prisma.PinganOrderUpdateInput,
            'decryptedFields' | 'detailJson' | 'detailFingerprint' | 'captureState'> = {}
          let newBuildCandidate = false
          if (mysqlOrderJobsEnabled && pinganOrderInfo(order.detailJson, orderId)) {
            const storedFields = pinganObject(existingOrder.decryptedFields)
            const missingFields = Object.fromEntries(Object.entries(pinganObject(order.decryptedFields)).filter(([key, value]) =>
              typeof value === 'string' && value.trim() && !(typeof storedFields[key] === 'string' && storedFields[key].trim())
            ))
            if (Object.keys(missingFields).length) {
              supplement.decryptedFields = jsonObject({ ...storedFields, ...missingFields }, '已解密字段')
            }
            if (!pinganOrderInfo(existingOrder.detailJson, orderId)) {
              supplement.detailJson = jsonObject(order.detailJson, '订单详情原文')
              supplement.detailFingerprint = typeof order.detailFingerprint === 'string' ? order.detailFingerprint : null
              supplement.captureState = order.captureState === 'complete' ? 'complete' : 'detail'
              newBuildCandidate = true
            }
            if (missingFields.patientName) newBuildCandidate = true
          }
          if (statusChanged || existingOrder.lastSeenRunId !== run.id || Object.keys(supplement).length) {
            await tx.pinganOrder.update({
              where: { pinganUserId_orderId: { pinganUserId: userId, orderId } },
              data: { status, statusName, lastSeenRunId: run.id, collectorDisplayName: run.collectorDisplayName, updatedAt: now, ...supplement }
            })
          }
          if (newBuildCandidate) await enqueuePinganMysqlOrder(tx, userId, orderId)
          const attachments = await tx.pinganOrderAttachment.findMany({
            where: { pinganUserId: userId, orderId },
            select: { attachmentId: true }
          })
          return {
            status: 'existing' as const,
            outcome: statusChanged ? 'status_updated' as const : 'unchanged' as const,
            employeeId: existingOrder.employeeId,
            storedAttachmentIds: attachments.map((attachment) => attachment.attachmentId)
          }
        }
        const handlerUserId = optionalHandlerUserId(order.handlerUserId)
        if (!handlerUserId) throw new Error(`订单 ${orderId} 当前处理人 ID 缺失，不能入库`)
        const captureState = requiredString(order.captureState, '订单采集状态', 32)
        if (!['list', 'detail', 'complete', 'partial_failure'].includes(captureState)) throw new Error('订单采集状态无效')
        const legacyAttachmentState = captureState === 'complete' ? 'complete' : 'not_captured'
        const attachmentState = requiredString(order.attachmentState ?? legacyAttachmentState, '附件采集状态', 32)
        if (!['not_captured', 'complete', 'partial_failure'].includes(attachmentState)) throw new Error('附件采集状态无效')
        const attachmentErrors = order.attachmentErrors == null
          ? []
          : Array.isArray(order.attachmentErrors) && order.attachmentErrors.every((item) => typeof item === 'string')
            ? order.attachmentErrors.map((item) => item.slice(0, 500))
            : (() => { throw new Error('附件错误列表格式无效') })()
        if (typeof order.errors !== 'undefined' && (!Array.isArray(order.errors) || order.errors.some((item) => typeof item !== 'string'))) {
          throw new Error('订单错误列表格式无效')
        }
        const handlerName = displayNameOf(order.handlerName)
        const handlerEmployee = await tx.employee.findUnique({
          where: { pinganId: handlerUserId }, select: { id: true }
        })
        const employeeId = handlerEmployee?.id ?? null
        const data = {
          handlerUserId,
          handlerName,
          employeeId,
          orderType,
          orderTypeName,
          status,
          statusName,
          listJson: jsonObject(order.listJson, '订单列表原文'),
          detailJson: order.detailJson == null ? Prisma.DbNull : jsonObject(order.detailJson, '订单详情原文'),
          decryptedFields: jsonObject(order.decryptedFields, '已解密字段'),
          captureState,
          attachmentState,
          attachmentErrors,
          errors: (order.errors as string[] | undefined) ?? [],
          listFingerprint: requiredString(order.listFingerprint, '列表指纹', 200),
          detailFingerprint: typeof order.detailFingerprint === 'string' ? order.detailFingerprint : null,
          firstSeenAt: dateTimeValue(order.firstSeenAt, '首次发现时间'),
          lastSeenAt: dateTimeValue(order.lastSeenAt, '最近发现时间'),
          updatedAt: now
        }
        await tx.pinganOrder.create({
          data: {
            pinganUserId: userId, orderId, firstSeenRunId: run.id, lastSeenRunId: run.id,
            collectorDisplayName: run.collectorDisplayName, ...data
          }
        })
        if (mysqlOrderJobsEnabled && pinganOrderInfo(order.detailJson, orderId)) {
          await enqueuePinganMysqlOrder(tx, userId, orderId)
        }
        return { status: 'created' as const, employeeId, storedAttachmentIds: [] }
      }
      const result = await prisma.$transaction(write)
      if (result.status === 'existing') {
        return reply.send({ data: { saved: true, outcome: result.outcome, employeeId: result.employeeId, storedAttachmentIds: result.storedAttachmentIds } })
      }
      return reply.send({ data: { saved: true, outcome: 'created', employeeId: result.employeeId, storedAttachmentIds: result.storedAttachmentIds } })
    } catch (error) {
      return reply.status(collectionErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  fastify.post('/api/v1/pingan/attachments', { bodyLimit: MAX_ATTACHMENT_BYTES + 1024 * 1024 }, async (request, reply) => {
    let uploadedKey: string | null = null
    try {
      const userId = pinganUserId(request.headers['x-pingan-user-id'])
      const collector = await requireCollector(prisma, userId)
      const fields: Record<string, string> = {}
      let file: Buffer | null = null
      let partMimeType = ''
      for await (const part of request.parts({ limits: { files: 1, fields: 8, fileSize: MAX_ATTACHMENT_BYTES } })) {
        if (part.type === 'file') {
          if (file) throw new Error('一次只允许上传一个附件')
          file = await part.toBuffer()
          partMimeType = part.mimetype
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value
        }
      }
      if (!file || file.length === 0) throw new Error('附件内容为空')
      const orderId = requiredString(fields.orderId, '平安订单号', 120)
      const attachmentId = requiredString(fields.attachmentId, '附件 ID', 240)
      const fileName = requiredString(fields.fileName, '附件文件名', 500)
      const fileType = fields.fileType?.trim() ? requiredString(fields.fileType, '附件类型', 120) : null
      const sha256 = requiredString(fields.sha256, '附件校验值', 64).toLowerCase()
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('附件校验值格式无效')
      if (createHash('sha256').update(file).digest('hex') !== sha256) throw new Error('附件校验不一致')
      const capturedAt = dateTimeValue(fields.capturedAt, '附件采集时间')
      const run = await requireRun(prisma, fields.runId, userId, collector.id)
      const order = await prisma.pinganOrder.findUnique({ where: { pinganUserId_orderId: { pinganUserId: userId, orderId } } })
      if (!order) return reply.status(409).send({ error: '附件对应订单尚未入库' })
      const mimeType = requiredString(fields.mimeType || partMimeType, '附件 MIME 类型', 160)
      const minioKey = `pingan/${userId}/${createHash('sha256').update(orderId).digest('hex')}/${sha256}`
      const old = await prisma.pinganOrderAttachment.findUnique({
        where: { pinganUserId_orderId_attachmentId: { pinganUserId: userId, orderId, attachmentId } }
      })
      if (!old || old.sha256 !== sha256 || Number(old.byteSize) !== file.length) {
        await minio.putObject(ATTACHMENT_BUCKET, minioKey, file, file.length, { 'Content-Type': mimeType })
        uploadedKey = minioKey
      }
      await prisma.pinganOrderAttachment.upsert({
        where: { pinganUserId_orderId_attachmentId: { pinganUserId: userId, orderId, attachmentId } },
        create: {
          pinganUserId: userId, orderId, attachmentId, fileName, fileType, mimeType,
          byteSize: BigInt(file.length), sha256, minioBucket: ATTACHMENT_BUCKET, minioKey, capturedAt, uploadRunId: run.id
        },
        update: {
          fileName, fileType, mimeType, byteSize: BigInt(file.length), sha256,
          minioBucket: ATTACHMENT_BUCKET, minioKey, capturedAt, uploadRunId: run.id
        }
      })
      return reply.send({ data: { saved: true, byteSize: file.length, sha256 } })
    } catch (error) {
      if (uploadedKey) await minio.removeObject(ATTACHMENT_BUCKET, uploadedKey).catch(() => undefined)
      const status = error instanceof Error && /File too large/i.test(error.message) ? 413 : collectionErrorStatus(error)
      return reply.status(status).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}

export function registerPinganAdminRoutes(
  fastify: FastifyInstance,
  prisma: PrismaClient,
  minioPublic: Minio.Client
): void {
  fastify.get('/api/v1/admin/pingan/accounts', async (_request, reply) => {
    const accounts = await prisma.$queryRaw<Array<{
      pinganUserId: string; displayName: string | null; employeeId: number | null; employeeName: string | null
      orderCount: number; runCount: number; lastCollectedAt: Date | null
    }>>`
      WITH orders AS (
        SELECT pingan_user_id, count(*)::int AS order_count, (array_agg(collector_display_name ORDER BY last_seen_at DESC, order_id DESC)
          FILTER (WHERE collector_display_name IS NOT NULL))[1] AS display_name
        FROM pingan_orders GROUP BY pingan_user_id
      ), runs AS (
        SELECT pingan_user_id, count(*)::int AS run_count, max(started_at) AS last_collected_at,
          (array_agg(collector_display_name ORDER BY started_at DESC, id DESC)
          FILTER (WHERE collector_display_name IS NOT NULL))[1] AS display_name
        FROM pingan_collection_runs GROUP BY pingan_user_id
      ), accounts AS (
        SELECT pingan_id AS id FROM employees WHERE pingan_id IS NOT NULL
        UNION SELECT pingan_user_id FROM orders
        UNION SELECT pingan_user_id FROM runs
      )
      SELECT a.id AS "pinganUserId",
        COALESCE(r.display_name, o.display_name, e.name) AS "displayName",
        e.id AS "employeeId", e.name AS "employeeName",
        COALESCE(o.order_count, 0) AS "orderCount", COALESCE(r.run_count, 0) AS "runCount",
        r.last_collected_at AS "lastCollectedAt"
      FROM accounts a LEFT JOIN employees e ON e.pingan_id = a.id
        LEFT JOIN orders o ON o.pingan_user_id = a.id LEFT JOIN runs r ON r.pingan_user_id = a.id
      ORDER BY r.last_collected_at DESC NULLS LAST, a.id
    `
    return reply.send({ data: accounts })
  })

  fastify.get('/api/v1/admin/pingan/staff', async (_request, reply) => {
    const handlers = await prisma.$queryRaw<Array<{
      pinganStaffId: string; displayName: string | null; employeeId: number | null; employeeName: string | null
      firstSeenAt: Date; lastSeenAt: Date; orderCount: number
    }>>`
      WITH handlers AS (
        SELECT handler_user_id, count(*)::int AS order_count,
          min(first_seen_at) AS first_seen_at, max(last_seen_at) AS last_seen_at,
          (array_agg(handler_name ORDER BY last_seen_at DESC, order_id DESC)
            FILTER (WHERE handler_name IS NOT NULL))[1] AS display_name
        FROM pingan_orders WHERE handler_user_id IS NOT NULL GROUP BY handler_user_id
      )
      SELECT h.handler_user_id AS "pinganStaffId", h.display_name AS "displayName",
        e.id AS "employeeId", e.name AS "employeeName",
        h.first_seen_at AS "firstSeenAt", h.last_seen_at AS "lastSeenAt", h.order_count AS "orderCount"
      FROM handlers h LEFT JOIN employees e ON e.pingan_id = h.handler_user_id
      ORDER BY e.id NULLS LAST, h.last_seen_at DESC, h.handler_user_id
    `
    return reply.send({ data: handlers.map(({ employeeName, ...handler }) => ({
      ...handler,
      employee: handler.employeeId === null ? null : { id: handler.employeeId, name: employeeName },
      mapped: handler.employeeId !== null
    })) })
  })

  fastify.get('/api/v1/admin/pingan/employees', async (_request, reply) => {
    const employees = await prisma.employee.findMany({ select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
    return reply.send({ data: employees })
  })

  fastify.get<{ Querystring: { page?: string; pageSize?: string; search?: string; orderType?: string; employeeId?: string } }>('/api/v1/admin/pingan/orders', async (request, reply) => {
    const page = Number(request.query.page ?? 1)
    const pageSize = Number(request.query.pageSize ?? 50)
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return reply.status(400).send({ error: '分页参数无效' })
    }
    const search = request.query.search?.trim()
    const employeeId = request.query.employeeId ? Number(request.query.employeeId) : undefined
    if (employeeId !== undefined && (!Number.isInteger(employeeId) || employeeId <= 0)) return reply.status(400).send({ error: '员工筛选参数无效' })
    const where: Prisma.PinganOrderWhereInput = {
      ...(request.query.orderType ? { orderType: request.query.orderType } : {}),
      ...(employeeId ? { employeeId } : {}),
      ...(search ? { OR: [
        { orderId: { contains: search, mode: 'insensitive' } },
        { handlerName: { contains: search, mode: 'insensitive' } },
        { collectorDisplayName: { contains: search, mode: 'insensitive' } },
        { employee: { name: { contains: search, mode: 'insensitive' } } }
      ] } : {})
    }
    const [total, orders] = await Promise.all([
      prisma.pinganOrder.count({ where }),
      prisma.pinganOrder.findMany({
        where,
        orderBy: [{ lastSeenAt: 'desc' }, { orderId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          pinganUserId: true, orderId: true, handlerUserId: true, handlerName: true,
          orderType: true, orderTypeName: true, status: true, statusName: true,
          captureState: true, attachmentState: true, attachmentErrors: true, lastSeenAt: true, employee: { select: { id: true, name: true } },
          collectorDisplayName: true,
          lastSeenRun: { select: { collectorEmployee: { select: { id: true, name: true } } } },
          _count: { select: { attachments: true } }
        }
      })
    ])
    return reply.send({ data: { items: orders.map((order) => ({
      ...order, lastSeenAt: order.lastSeenAt.toISOString(), attachmentCount: order._count.attachments,
      _count: undefined
    })), page, pageSize, total, pageCount: Math.ceil(total / pageSize) } })
  })

  fastify.get<{ Params: { pinganUserId: string; orderId: string } }>('/api/v1/admin/pingan/orders/:pinganUserId/:orderId', async (request, reply) => {
    const userId = pinganUserId(request.params.pinganUserId)
    const orderId = requiredString(request.params.orderId, '平安订单号', 120)
    const order = await prisma.pinganOrder.findUnique({
      where: { pinganUserId_orderId: { pinganUserId: userId, orderId } },
      include: {
        employee: { select: { id: true, name: true } },
        firstSeenRun: { select: { collectorEmployee: { select: { id: true, name: true } } } },
        lastSeenRun: { select: { collectorEmployee: { select: { id: true, name: true } } } },
        attachments: { orderBy: [{ capturedAt: 'asc' }, { attachmentId: 'asc' }] }
      }
    })
    if (!order) return reply.status(404).send({ error: '平安订单不存在' })
    const attachments = await Promise.all(order.attachments.map(async (attachment) => ({
      attachmentId: attachment.attachmentId,
      fileName: attachment.fileName,
      fileType: attachment.fileType,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize.toString(),
      sha256: attachment.sha256,
      capturedAt: attachment.capturedAt.toISOString(),
      url: await minioPublic.presignedGetObject(attachment.minioBucket, attachment.minioKey, 60 * 60)
    })))
    return reply.send({ data: {
      ...order,
      firstSeenAt: order.firstSeenAt.toISOString(), lastSeenAt: order.lastSeenAt.toISOString(),
      createdAt: order.createdAt.toISOString(), updatedAt: order.updatedAt.toISOString(),
      attachments
    } })
  })

  fastify.get('/api/v1/admin/pingan/runs', async (_request, reply) => {
    const runs = await prisma.pinganCollectionRun.findMany({
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 100,
      include: { collectorEmployee: { select: { id: true, name: true } }, _count: { select: { pages: true } } }
    })
    return reply.send({ data: runs.map((run) => ({
      ...run,
      installDate: shanghaiDateKey(run.installDate),
      scanStartDate: shanghaiDateKey(run.scanStartDate),
      scanEndDate: shanghaiDateKey(run.scanEndDate),
      startedAt: run.startedAt.toISOString(), completedAt: run.completedAt?.toISOString() ?? null,
      pageCount: run._count.pages, _count: undefined
    })) })
  })
}
