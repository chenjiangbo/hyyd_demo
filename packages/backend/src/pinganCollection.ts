import { createHash } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type * as Minio from 'minio'
import { ATTACHMENT_BUCKET } from './orderDetail.js'
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

function optionalPinganStaffId(value: unknown): string | null {
  if (value == null || value === '') return null
  return pinganStaffId(value)
}

function normalizedHandlerName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s*\(\s*\d+\s*\)\s*$/, '').trim()
}

async function matchHuanyuEmployeeId(tx: Prisma.TransactionClient, handlerName: string | null): Promise<number | null> {
  if (!handlerName) return null
  const name = normalizedHandlerName(handlerName)
  if (!name) return null
  const matches = await tx.employee.findMany({
    where: { name },
    select: { id: true }
  })
  return matches.length === 1 ? matches[0].id : null
}

async function setEmployeePinganId(tx: Prisma.TransactionClient, employeeId: number, pinganId: string): Promise<void> {
  const result = await tx.employee.updateMany({
    where: { id: employeeId, OR: [{ pinganId: null }, { pinganId }] },
    data: { pinganId }
  })
  if (result.count !== 1) throw new Error(`寰宇员工 ${employeeId} 已关联其他平安 ID，拒绝覆盖`)
}

function pinganStaffId(value: unknown): string {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof id !== 'string' || !/^\d{1,40}$/.test(id)) throw new Error('平安处理人 ID 无效')
  return id
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

function accountResponse(account: {
  pinganUserId: string
  displayName: string | null
  firstSeenAt: Date
  lastSeenAt: Date
}) {
  return {
    pinganUserId: account.pinganUserId,
    displayName: account.displayName,
    firstSeenAt: account.firstSeenAt.toISOString(),
    lastSeenAt: account.lastSeenAt.toISOString()
  }
}

export function registerPinganIngestRoutes(
  fastify: FastifyInstance,
  prisma: PrismaClient,
  minio: Minio.Client
): void {
  fastify.post('/api/v1/pingan/identify', async (request, reply) => {
    try {
      const body = request.body as JsonRecord
      const id = pinganUserId(body?.pinganUserId)
      const displayName = typeof body?.displayName === 'string' ? body.displayName.trim().slice(0, 200) || null : null
      const now = new Date()
      const account = await prisma.pinganAccount.upsert({
        where: { pinganUserId: id },
        create: { pinganUserId: id, displayName, firstSeenAt: now, lastSeenAt: now },
        update: { displayName, lastSeenAt: now }
      })
      return reply.send({ data: accountResponse(account) })
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  fastify.post('/api/v1/pingan/runs', async (request, reply) => {
    try {
      const body = request.body as JsonRecord
      const userId = pinganUserId(body?.pinganUserId)
      const run = isRecord(body?.run) ? body.run : null
      if (!run) throw new Error('采集批次缺失')
      const id = requiredString(run.id, '采集批次 ID', 80)
      const startedAt = dateTimeValue(run.startedAt, '采集开始时间')
      const state = requiredString(run.state, '采集状态', 32)
      if (!['running', 'completed', 'partial_failure', 'error'].includes(state)) throw new Error('采集状态无效')
      const account = await prisma.pinganAccount.findUnique({ where: { pinganUserId: userId } })
      if (!account) return reply.status(409).send({ error: '平安账号尚未登记，请重新打开已登录的平安好医生页面' })
      const data = {
        pinganUserId: userId,
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
        where: { id },
        create: { id, ...data },
        update: data
      })
      return reply.send({ data: { id: saved.id, state: saved.state } })
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  fastify.post('/api/v1/pingan/pages', async (request, reply) => {
    try {
      const body = request.body as JsonRecord
      const userId = pinganUserId(body?.pinganUserId)
      const page = isRecord(body?.page) ? body.page : null
      if (!page) throw new Error('列表分页记录缺失')
      const runId = requiredString(page.runId, '采集批次 ID', 80)
      const run = await prisma.pinganCollectionRun.findUnique({ where: { id: runId } })
      if (!run || run.pinganUserId !== userId) return reply.status(404).send({ error: '采集批次不存在或账号不匹配' })
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
      return reply.status(400).send({ error: error instanceof Error ? error.message : String(error) })
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
      const write = async (tx: Prisma.TransactionClient) => {
        const account = await tx.pinganAccount.findUnique({ where: { pinganUserId: userId } })
        if (!account) return { status: 'unknown' as const }
        const now = new Date()
        const existingOrder = await tx.pinganOrder.findUnique({
          where: { pinganUserId_orderId: { pinganUserId: userId, orderId } },
          select: { status: true, statusName: true, employeeId: true }
        })
        if (existingOrder) {
          const statusChanged = existingOrder.status !== status || existingOrder.statusName !== statusName
          if (statusChanged) {
            await tx.pinganOrder.update({
              where: { pinganUserId_orderId: { pinganUserId: userId, orderId } },
              data: { status, statusName, updatedAt: now }
            })
          }
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
        const assignedHandlerUserId = optionalPinganStaffId(order.handlerUserId)
        if (!assignedHandlerUserId) throw new Error(`订单 ${orderId} 当前处理人 ID 缺失，不能入库`)
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
        const handlerUserId = assignedHandlerUserId
        const handlerName = typeof order.handlerName === 'string' && order.handlerName.trim()
          ? order.handlerName.trim().slice(0, 200)
          : null
        const staffUpdate = handlerName ? { displayName: handlerName, lastSeenAt: now } : { lastSeenAt: now }
        const existingHandlerStaff = handlerUserId
          ? await tx.pinganStaff.findUnique({ where: { pinganStaffId: handlerUserId }, select: { employeeId: true } })
          : null
        const matchedEmployeeId = existingHandlerStaff?.employeeId == null
          ? await matchHuanyuEmployeeId(tx, handlerName)
          : null
        const mappedEmployeeId = existingHandlerStaff?.employeeId ?? matchedEmployeeId
        if (handlerUserId && mappedEmployeeId !== null && mappedEmployeeId !== undefined) {
          await setEmployeePinganId(tx, mappedEmployeeId, handlerUserId)
        }
        const handlerStaff = handlerUserId
          ? await tx.pinganStaff.upsert({
            where: { pinganStaffId: handlerUserId },
            create: { pinganStaffId: handlerUserId, displayName: handlerName, employeeId: matchedEmployeeId, firstSeenAt: now, lastSeenAt: now },
            update: { ...staffUpdate, ...(matchedEmployeeId === null ? {} : { employeeId: matchedEmployeeId }) }
          })
          : null
        const data = {
          handlerUserId,
          handlerName,
          employeeId: handlerStaff?.employeeId ?? null,
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
        await tx.pinganOrder.create({ data: { pinganUserId: userId, orderId, ...data } })
        return { status: 'created' as const, employeeId: handlerStaff?.employeeId ?? null, storedAttachmentIds: [] }
      }
      const result = await prisma.$transaction(write)
      if (result.status === 'unknown') return reply.status(409).send({ error: '平安账号未登记，请刷新平安页面后重试' })
      if (result.status === 'existing') {
        return reply.send({ data: { saved: true, outcome: result.outcome, employeeId: result.employeeId, storedAttachmentIds: result.storedAttachmentIds } })
      }
      return reply.send({ data: { saved: true, outcome: 'created', employeeId: result.employeeId, storedAttachmentIds: result.storedAttachmentIds } })
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  fastify.post('/api/v1/pingan/attachments', { bodyLimit: MAX_ATTACHMENT_BYTES + 1024 * 1024 }, async (request, reply) => {
    let uploadedKey: string | null = null
    try {
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
      const userId = pinganUserId(fields.pinganUserId)
      const orderId = requiredString(fields.orderId, '平安订单号', 120)
      const attachmentId = requiredString(fields.attachmentId, '附件 ID', 240)
      const fileName = requiredString(fields.fileName, '附件文件名', 500)
      const fileType = fields.fileType?.trim() ? requiredString(fields.fileType, '附件类型', 120) : null
      const sha256 = requiredString(fields.sha256, '附件校验值', 64).toLowerCase()
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('附件校验值格式无效')
      if (createHash('sha256').update(file).digest('hex') !== sha256) throw new Error('附件校验不一致')
      const capturedAt = dateTimeValue(fields.capturedAt, '附件采集时间')
      const account = await prisma.pinganAccount.findUnique({ where: { pinganUserId: userId } })
      if (!account) return reply.status(409).send({ error: '平安登录账号尚未登记' })
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
          byteSize: BigInt(file.length), sha256, minioBucket: ATTACHMENT_BUCKET, minioKey, capturedAt
        },
        update: {
          fileName, fileType, mimeType, byteSize: BigInt(file.length), sha256,
          minioBucket: ATTACHMENT_BUCKET, minioKey, capturedAt
        }
      })
      return reply.send({ data: { saved: true, byteSize: file.length, sha256 } })
    } catch (error) {
      if (uploadedKey) await minio.removeObject(ATTACHMENT_BUCKET, uploadedKey).catch(() => undefined)
      const status = error instanceof Error && /File too large/i.test(error.message) ? 413 : 400
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
    const accounts = await prisma.pinganAccount.findMany({
      include: { _count: { select: { orders: true, runs: true } } },
      orderBy: [{ lastSeenAt: 'desc' }]
    })
    return reply.send({ data: accounts.map((account) => ({ ...accountResponse(account), orderCount: account._count.orders, runCount: account._count.runs })) })
  })

  fastify.get('/api/v1/admin/pingan/staff', async (_request, reply) => {
    const staff = await prisma.pinganStaff.findMany({
      include: { employee: { select: { id: true, name: true } }, _count: { select: { orders: true } } },
      orderBy: [{ employeeId: 'asc' }, { lastSeenAt: 'desc' }, { pinganStaffId: 'asc' }]
    })
    return reply.send({ data: staff.map((person) => ({
      pinganStaffId: person.pinganStaffId,
      displayName: person.displayName,
      employeeId: person.employeeId,
      employee: person.employee,
      firstSeenAt: person.firstSeenAt.toISOString(),
      lastSeenAt: person.lastSeenAt.toISOString(),
      orderCount: person._count.orders,
      mapped: person.employeeId !== null
    })) })
  })

  fastify.get('/api/v1/admin/pingan/employees', async (_request, reply) => {
    const employees = await prisma.employee.findMany({ select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
    return reply.send({ data: employees })
  })

  fastify.patch<{ Params: { pinganStaffId: string } }>('/api/v1/admin/pingan/staff/:pinganStaffId', async (request, reply) => {
    try {
      const staffId = pinganStaffId(request.params.pinganStaffId)
      const body = request.body as JsonRecord
      if (!Object.prototype.hasOwnProperty.call(body ?? {}, 'employeeId')) throw new Error('寰宇员工 ID 字段缺失')
      const employeeId = body?.employeeId === null ? null : countValue(body?.employeeId, '寰宇员工 ID')
      if (employeeId !== null) {
        const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true } })
        if (!employee) return reply.status(404).send({ error: '寰宇员工不存在' })
      }
      const exists = await prisma.pinganStaff.findUnique({ where: { pinganStaffId: staffId } })
      if (!exists) return reply.status(404).send({ error: '平安处理人尚未采集到' })
      const staff = await prisma.$transaction(async (tx) => {
        if (employeeId !== null) await setEmployeePinganId(tx, employeeId, staffId)
        if (exists.employeeId !== null && exists.employeeId !== employeeId) {
          await tx.employee.updateMany({ where: { id: exists.employeeId, pinganId: staffId }, data: { pinganId: null } })
        }
        const updated = await tx.pinganStaff.update({
          where: { pinganStaffId: staffId }, data: { employeeId }, include: { employee: { select: { id: true, name: true } } }
        })
        await tx.pinganOrder.updateMany({ where: { handlerUserId: staffId }, data: { employeeId } })
        return updated
      })
      const orderCount = await prisma.pinganOrder.count({ where: { handlerUserId: staffId } })
      return reply.send({ data: {
        pinganStaffId: staff.pinganStaffId,
        displayName: staff.displayName,
        employeeId: staff.employeeId,
        employee: staff.employee,
        firstSeenAt: staff.firstSeenAt.toISOString(),
        lastSeenAt: staff.lastSeenAt.toISOString(),
        orderCount,
        mapped: staff.employeeId !== null
      } })
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
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
        { account: { displayName: { contains: search, mode: 'insensitive' } } },
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
          account: { select: { displayName: true } }, _count: { select: { attachments: true } }
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
        handlerStaff: { select: { pinganStaffId: true, displayName: true, employeeId: true } },
        account: { select: { displayName: true } },
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
      include: { account: { select: { displayName: true } }, _count: { select: { pages: true } } }
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
