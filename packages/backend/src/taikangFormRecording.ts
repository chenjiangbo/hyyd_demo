import { createHash } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import type * as Minio from 'minio'
import { parseShanghaiDateTime } from './time/shanghaiTime.js'

const ROUTE_KINDS = new Set(['green-order', 'register-order', 'expert-add', 'hospital-add'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PAGE_SIZE = 50
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024

type EventInput = {
  id: string
  sequence: number
  occurredAt: string
  kind: string
  payload: Record<string, unknown>
}

type SessionInput = {
  id: string
  routeKind: string
  startedAt: string
  sourceOrderNo?: string | null
  serviceName?: string | null
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const date = parseShanghaiDateTime(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseSession(raw: unknown): SessionInput | null {
  if (!isPlainObject(raw) || typeof raw.id !== 'string' || !UUID_PATTERN.test(raw.id) ||
      typeof raw.routeKind !== 'string' || !ROUTE_KINDS.has(raw.routeKind) || !parseDate(raw.startedAt)) return null
  const sourceOrderNo = raw.sourceOrderNo
  const serviceName = raw.serviceName
  if (sourceOrderNo != null && (typeof sourceOrderNo !== 'string' || sourceOrderNo.length > 200)) return null
  if (serviceName != null && (typeof serviceName !== 'string' || serviceName.length > 200)) return null
  return {
    id: raw.id,
    routeKind: raw.routeKind,
    startedAt: raw.startedAt as string,
    sourceOrderNo: sourceOrderNo as string | null | undefined,
    serviceName: serviceName as string | null | undefined
  }
}

function parseEvent(raw: unknown): EventInput | null {
  if (!isPlainObject(raw) || typeof raw.id !== 'string' || !UUID_PATTERN.test(raw.id) ||
      !Number.isSafeInteger(raw.sequence) || Number(raw.sequence) < 1 ||
      !parseDate(raw.occurredAt) || typeof raw.kind !== 'string' || !raw.kind || raw.kind.length > 80 ||
      !isPlainObject(raw.payload)) return null
  return raw as EventInput
}

export async function saveTaikangFormEvent(
  prisma: PrismaClient,
  minio: Minio.Client,
  screenshotBucket: string,
  employeeId: number,
  account: string,
  userId: number,
  rawSession: unknown,
  rawEvent: unknown,
  imageDataUrl?: unknown
): Promise<{ ok: true; duplicate: boolean } | { ok: false; error: string }> {
  const session = parseSession(rawSession)
  let event = parseEvent(rawEvent)
  if (!session || !event) return { ok: false, error: '表单操作记录格式无效' }

  if (event.kind === 'screenshot') {
    if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/jpeg;base64,')) {
      return { ok: false, error: '截图数据缺失或格式无效' }
    }
    const encoded = imageDataUrl.slice('data:image/jpeg;base64,'.length)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > Math.ceil(MAX_SCREENSHOT_BYTES * 4 / 3) + 4) {
      return { ok: false, error: '截图数据无效或超过容量上限' }
    }
    const image = Buffer.from(encoded, 'base64')
    if (image.length > MAX_SCREENSHOT_BYTES || image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8 ||
        image[image.length - 2] !== 0xff || image[image.length - 1] !== 0xd9) {
      return { ok: false, error: '截图不是有效的 JPEG 图像' }
    }
    const imageSha256 = createHash('sha256').update(image).digest('hex')
    const imageKey = `taikang-form-recordings/${employeeId}/${session.id}/${event.id}-${imageSha256}.jpg`
    try {
      await minio.putObject(screenshotBucket, imageKey, image, image.length, { 'Content-Type': 'image/jpeg' })
    } catch (error) {
      return { ok: false, error: `截图存储失败：${error instanceof Error ? error.message : String(error)}` }
    }
    event = { ...event, payload: { ...event.payload, imageKey, imageSha256, byteSize: image.length } }
  } else if (imageDataUrl !== undefined) {
    return { ok: false, error: '非截图事件不能携带图片' }
  }

  const hash = createHash('sha256').update(JSON.stringify({
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    kind: event.kind,
    payload: event.payload
  })).digest('hex')

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existingSession = await tx.taikangFormSession.findUnique({ where: { id: session.id } })
      if (existingSession && (existingSession.employeeId !== employeeId ||
          existingSession.taikangAccount !== account || existingSession.taikangUserId !== userId ||
          existingSession.routeKind !== session.routeKind ||
          existingSession.startedAt.getTime() !== parseDate(session.startedAt)!.getTime())) {
        throw new Error('录制会话的账号或页面信息不一致')
      }

      if (!existingSession) {
        await tx.taikangFormSession.create({
          data: {
            id: session.id,
            employeeId,
            taikangAccount: account,
            taikangUserId: userId,
            routeKind: session.routeKind,
            sourceOrderNo: session.sourceOrderNo ?? null,
            serviceName: session.serviceName ?? null,
            startedAt: parseDate(session.startedAt)!,
            lastEventAt: parseDate(event.occurredAt)!
          }
        })
      }

      const existingEvent = await tx.taikangFormEvent.findUnique({ where: { id: event.id } })
      if (existingEvent) {
        if (existingEvent.sessionId !== session.id || existingEvent.sequence !== event.sequence || existingEvent.payloadHash !== hash) {
          throw new Error('重复事件的内容不一致')
        }
        return { duplicate: true }
      }

      await tx.taikangFormEvent.create({
        data: {
          id: event.id,
          sessionId: session.id,
          sequence: event.sequence,
          occurredAt: parseDate(event.occurredAt)!,
          kind: event.kind,
          payload: event.payload as Prisma.InputJsonObject,
          payloadHash: hash
        }
      })
      await tx.taikangFormSession.update({
        where: { id: session.id },
        data: {
          eventCount: { increment: 1 },
          lastEventAt: existingSession && existingSession.lastEventAt > parseDate(event.occurredAt)!
            ? existingSession.lastEventAt : parseDate(event.occurredAt)!,
          ...(event.kind === 'session-end' ? { endedAt: parseDate(event.occurredAt)! } : {}),
          ...(session.sourceOrderNo ? { sourceOrderNo: session.sourceOrderNo } : {}),
          ...(session.serviceName ? { serviceName: session.serviceName } : {})
        }
      })
      return { duplicate: false }
    })
    return { ok: true, duplicate: result.duplicate }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  }
}

function encodeCursor(startedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([startedAt.toISOString(), id])).toString('base64url')
}

function decodeCursor(raw: unknown): { startedAt: Date; id: string } | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString())
    if (!Array.isArray(parsed) || parsed.length !== 2 || !UUID_PATTERN.test(parsed[1])) return null
    const startedAt = parseDate(parsed[0])
    return startedAt ? { startedAt, id: parsed[1] } : null
  } catch {
    return null
  }
}

export function registerTaikangFormAdminRoutes(
  fastify: FastifyInstance, prisma: PrismaClient, minio: Minio.Client, screenshotBucket: string
): void {
  fastify.get<{ Querystring: { cursor?: string; account?: string; routeKind?: string; order?: string } }>(
    '/api/v1/admin/taikang-form-sessions', async (request, reply) => {
      const { cursor: rawCursor, account, routeKind, order } = request.query
      const cursor = rawCursor ? decodeCursor(rawCursor) : null
      if (rawCursor && !cursor) return reply.status(400).send({ error: '分页位置无效' })
      if (routeKind && !ROUTE_KINDS.has(routeKind)) return reply.status(400).send({ error: '页面类型无效' })
      const where: Prisma.TaikangFormSessionWhereInput = {
        ...(account ? { taikangAccount: { contains: account.trim() } } : {}),
        ...(routeKind ? { routeKind } : {}),
        ...(order ? { sourceOrderNo: { contains: order.trim() } } : {}),
        ...(cursor ? { OR: [
          { startedAt: { lt: cursor.startedAt } },
          { startedAt: cursor.startedAt, id: { lt: cursor.id } }
        ] } : {})
      }
      const rows = await prisma.taikangFormSession.findMany({
        where,
        include: { employee: { select: { id: true, name: true } } },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: PAGE_SIZE + 1
      })
      const page = rows.slice(0, PAGE_SIZE)
      const last = page[page.length - 1]
      return reply.send({ data: {
        items: page,
        nextCursor: rows.length > PAGE_SIZE && last ? encodeCursor(last.startedAt, last.id) : null
      } })
    }
  )

  fastify.get<{ Params: { id: string } }>('/api/v1/admin/taikang-form-sessions/:id', async (request, reply) => {
    if (!UUID_PATTERN.test(request.params.id)) return reply.status(400).send({ error: '录制编号无效' })
    const session = await prisma.taikangFormSession.findUnique({
      where: { id: request.params.id },
      include: { employee: { select: { id: true, name: true } } }
    })
    if (!session) return reply.status(404).send({ error: '录制记录不存在' })
    return reply.send({ data: session })
  })

  fastify.get<{ Params: { id: string }; Querystring: { afterSequence?: string } }>(
    '/api/v1/admin/taikang-form-sessions/:id/events', async (request, reply) => {
      if (!UUID_PATTERN.test(request.params.id)) return reply.status(400).send({ error: '录制编号无效' })
      const afterSequence = request.query.afterSequence ? Number(request.query.afterSequence) : 0
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) return reply.status(400).send({ error: '分页位置无效' })
      const session = await prisma.taikangFormSession.findUnique({ where: { id: request.params.id }, select: { id: true } })
      if (!session) return reply.status(404).send({ error: '录制记录不存在' })
      const rows = await prisma.taikangFormEvent.findMany({
        where: { sessionId: request.params.id, sequence: { gt: afterSequence } },
        orderBy: { sequence: 'asc' },
        take: PAGE_SIZE + 1
      })
      const page = rows.slice(0, PAGE_SIZE)
      return reply.send({ data: {
        items: page,
        nextAfterSequence: rows.length > PAGE_SIZE ? page[page.length - 1]!.sequence : null
      } })
    }
  )

  fastify.get<{ Params: { id: string; eventId: string } }>(
    '/api/v1/admin/taikang-form-sessions/:id/events/:eventId/image', async (request, reply) => {
      if (!UUID_PATTERN.test(request.params.id) || !UUID_PATTERN.test(request.params.eventId)) {
        return reply.status(400).send({ error: '截图编号无效' })
      }
      const event = await prisma.taikangFormEvent.findFirst({
        where: { id: request.params.eventId, sessionId: request.params.id },
        select: { kind: true, payload: true }
      })
      if (!event || event.kind !== 'screenshot') return reply.status(404).send({ error: '截图不存在' })
      const key = (event.payload as Record<string, unknown>).imageKey
      if (typeof key !== 'string' || !/^taikang-form-recordings\/\d+\/[0-9a-f-]{36}\/[0-9a-f-]{36}-[0-9a-f]{64}\.jpg$/.test(key)) {
        return reply.status(500).send({ error: '截图存储信息无效' })
      }
      try {
        const stream = await minio.getObject(screenshotBucket, key)
        return reply.header('Cache-Control', 'private, max-age=60').type('image/jpeg').send(stream)
      } catch (error) {
        request.log.error({ err: error, eventId: request.params.eventId }, '读取泰康填报截图失败')
        return reply.status(502).send({ error: '截图暂时无法读取' })
      }
    }
  )
}
