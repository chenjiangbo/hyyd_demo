import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import fastify from 'fastify'
import multipart from '@fastify/multipart'
import type { PrismaClient } from '@prisma/client'
import { isEmployeeAuthExemptPath } from './employeeRequestAuth.js'
import { registerPinganIngestRoutes } from './pinganCollection.js'

const runId = 'a1679cad-7d85-44e2-b50b-adf955a81ca3'
const collectorEmployeeId = 11

function createHarness(
  mappedEmployeeId: number | null,
  existingOrder: Record<string, any> | null = null,
  attachmentIds: string[] = [],
  runCollectorEmployeeId = collectorEmployeeId,
  collectorEnabled = 1,
  mysqlOrderJobsEnabled = false
) {
  let savedOrder: Record<string, any> | null = null
  let lookedUpHandlerId: string | null = null
  const queued: Array<unknown[]> = []
  const tx = {
    $executeRaw: async (_query: TemplateStringsArray, ...params: unknown[]) => { queued.push(params); return 1 },
    employee: {
      findUnique: async ({ where }: { where: { pinganId: string } }) => {
        lookedUpHandlerId = where.pinganId
        return where.pinganId === '88002' && mappedEmployeeId !== null ? { id: mappedEmployeeId } : null
      }
    },
    pinganOrder: {
      findUnique: async () => existingOrder,
      create: async ({ data }: { data: Record<string, any> }) => {
        savedOrder = data
        return data
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (!existingOrder) throw new Error('测试订单不存在')
        Object.assign(existingOrder, data)
        return existingOrder
      }
    },
    pinganOrderAttachment: {
      findMany: async () => attachmentIds.map((attachmentId) => ({ attachmentId }))
    },
  }
  const prisma = {
    employee: { findUnique: async ({ where }: { where: { pinganId: string } }) =>
      where.pinganId === '70001'
        ? { id: collectorEmployeeId, enabled: collectorEnabled, name: '寰宇员工' }
        : null
    },
    pinganCollectionRun: { findUnique: async () => ({
      id: runId, pinganUserId: '70001', collectorEmployeeId: runCollectorEmployeeId, collectorDisplayName: '采集账号'
    }) },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)
  } as unknown as PrismaClient
  const minio = {} as any
  const app = fastify()
  app.addHook('preHandler', async (request, reply) => {
    if (isEmployeeAuthExemptPath(request.url)) return
    return reply.status(401).send({ error: 'missing employee header' })
  })
  registerPinganIngestRoutes(app, prisma, minio, mysqlOrderJobsEnabled)
  return { app, getSavedOrder: () => savedOrder ?? existingOrder, getLookedUpHandlerId: () => lookedUpHandlerId, queued }
}

function orderBody(handlerUserId: string | null, handlerName: string | null): { pinganUserId: string; runId: string; order: Record<string, any> } {
  return {
    pinganUserId: '70001',
    runId,
    order: {
      orderId: 'order-1',
      orderType: 'ORDINARY_REGISTER',
      orderTypeStr: 'VIP挂号',
      status: 'WAIT_CONFIRM',
      statusStr: '待用户确认',
      handlerUserId,
      handlerName,
      listJson: { orderId: 'order-1', handlerUserId, handlerName },
      detailJson: { orderInfo: { orderId: 'order-1' } },
      decryptedFields: {},
      listFingerprint: 'list-hash',
      detailFingerprint: 'detail-hash',
      captureState: 'complete',
      attachmentState: 'complete',
      attachmentErrors: [],
      errors: [],
      firstSeenAt: '2026-11-19T00:00:00.000Z',
      lastSeenAt: '2026-11-19T00:00:00.000Z'
    }
  }
}

test('saves an order against the mapped current handler employee', async () => {
  const harness = createHarness(42)
  const response = await harness.app.inject({ method: 'POST', url: '/api/v1/pingan/orders', payload: orderBody('88002', '处理人(88002)') })

  assert.equal(response.statusCode, 200)
  assert.equal(harness.getLookedUpHandlerId(), '88002')
  assert.equal(harness.getSavedOrder()?.employeeId, 42)
  assert.equal(harness.getSavedOrder()?.handlerUserId, '88002')
  assert.equal(harness.getSavedOrder()?.firstSeenRunId, runId)
  assert.equal(harness.getSavedOrder()?.lastSeenRunId, runId)
  assert.equal(response.json().data.outcome, 'created')
  await harness.app.close()
})

test('keeps the raw handler when their PingAn ID is not maintained in employees', async () => {
  const harness = createHarness(null)
  const response = await harness.app.inject({ method: 'POST', url: '/api/v1/pingan/orders', payload: orderBody('88002', '同名员工(88002)') })

  assert.equal(response.statusCode, 200)
  assert.equal(response.json().data.employeeId, null)
  assert.equal(harness.getSavedOrder()?.handlerName, '同名员工(88002)')
  assert.equal(harness.getLookedUpHandlerId(), '88002')
  await harness.app.close()
})

test('an existing order updates status only and reports already stored attachments', async () => {
  const existing = {
    status: 'WAIT_APPOINTMENT',
    statusName: '待预约',
    employeeId: 73,
    handlerUserId: '88002',
    lastSeenRunId: null,
    detailJson: { protected: 'previous detail' },
    decryptedFields: { identityNo: 'clear-value' },
    listJson: { protected: 'previous list' },
    captureState: 'complete'
  }
  const harness = createHarness(null, existing, ['attachment-1'])
  const payload = orderBody('99999', '不应处理的新处理人')
  payload.order.status = 'DONE'
  payload.order.statusStr = '完成'
  payload.order.detailJson = { protected: 'must not replace' }
  payload.order.decryptedFields = { identityNo: 'masked' }
  payload.order.listJson = { protected: 'must not replace' }
  const response = await harness.app.inject({ method: 'POST', url: '/api/v1/pingan/orders', payload })

  assert.equal(response.statusCode, 200)
  assert.equal(response.json().data.outcome, 'status_updated')
  assert.deepEqual(response.json().data.storedAttachmentIds, ['attachment-1'])
  assert.equal(existing.status, 'DONE')
  assert.equal(existing.statusName, '完成')
  assert.deepEqual(existing.detailJson, { protected: 'previous detail' })
  assert.deepEqual(existing.decryptedFields, { identityNo: 'clear-value' })
  assert.deepEqual(existing.listJson, { protected: 'previous list' })
  assert.equal(existing.handlerUserId, '88002')
  assert.equal(existing.lastSeenRunId, runId)
  assert.equal(harness.getLookedUpHandlerId(), null)
  await harness.app.close()
})

test('an existing order with unchanged status is acknowledged without updating its row', async () => {
  const existing = { status: 'WAIT_CONFIRM', statusName: '待用户确认', lastSeenRunId: runId, detailJson: { preserved: true } }
  const harness = createHarness(null, existing, [])
  const payload = orderBody('88002', '处理人(88002)')
  payload.order.detailJson = { preserved: false }
  const response = await harness.app.inject({ method: 'POST', url: '/api/v1/pingan/orders', payload })

  assert.equal(response.statusCode, 200)
  assert.equal(response.json().data.outcome, 'unchanged')
  assert.deepEqual(existing.detailJson, { preserved: true })
  assert.equal(harness.getLookedUpHandlerId(), null)
  await harness.app.close()
})

test('PingAn routes resolve the employee by maintained account without the general employee-code header', () => {
  assert.equal(isEmployeeAuthExemptPath('/api/v1/pingan/identify'), true)
  assert.equal(isEmployeeAuthExemptPath('/api/v1/pingan/orders'), true)
  assert.equal(isEmployeeAuthExemptPath('/api/v1/admin/pingan/orders'), true)
  assert.equal(isEmployeeAuthExemptPath('/api/v1/orders'), false)
})

test('saves an unmapped current handler without attributing it to the login account', async () => {
  const unmapped = createHarness(null)
  const response = await unmapped.app.inject({ method: 'POST', url: '/api/v1/pingan/orders', payload: orderBody('88003', '另一位处理人(88003)') })
  assert.equal(response.statusCode, 200)
  assert.equal(unmapped.getSavedOrder()?.employeeId, null)
  assert.equal(unmapped.getSavedOrder()?.handlerUserId, '88003')
  await unmapped.app.close()

  const unassigned = createHarness(null)
  const unassignedResponse = await unassigned.app.inject({ method: 'POST', url: '/api/v1/pingan/orders', payload: orderBody(null, null) })
  assert.equal(unassignedResponse.statusCode, 400)
  assert.match(unassignedResponse.json().error, /当前处理人 ID 缺失/)
  assert.equal(unassigned.getLookedUpHandlerId(), null)
  assert.equal(unassigned.getSavedOrder(), null)
  await unassigned.app.close()
})


test('rejects ingest for an unconfigured PingAn login account', async () => {
  const harness = createHarness(null)
  const payload = { ...orderBody('88002', '处理人'), pinganUserId: '70002' }
  const response = await harness.app.inject({ method: 'POST', url: '/api/v1/pingan/orders', payload })
  assert.equal(response.statusCode, 403)
  assert.match(response.json().error, /未配置到寰宇员工表/)
  assert.equal(harness.getSavedOrder(), null)
  await harness.app.close()
})

test('rejects ingest for a disabled employee with a configured PingAn login account', async () => {
  const harness = createHarness(null, null, [], collectorEmployeeId, 0)
  const response = await harness.app.inject({
    method: 'POST', url: '/api/v1/pingan/orders', payload: orderBody('88002', '处理人')
  })
  assert.equal(response.statusCode, 403)
  assert.match(response.json().error, /已停用/)
  assert.equal(harness.getSavedOrder(), null)
  await harness.app.close()
})

test('rejects attaching an order to another employee’s collection batch', async () => {
  const harness = createHarness(null, null, [], 22)
  const response = await harness.app.inject({
    method: 'POST', url: '/api/v1/pingan/orders',
    payload: orderBody('88002', '处理人')
  })
  assert.equal(response.statusCode, 404)
  assert.equal(harness.getSavedOrder(), null)
  await harness.app.close()
})


test('associates the run, page and uploaded attachment using only the maintained PingAn login account', async () => {
  const employee = {
    id: collectorEmployeeId, enabled: 1, pinganId: '70001', name: '寰宇员工'
  }
  let storedRun: Record<string, unknown> = {}
  let pageRunId: unknown
  let attachmentRunId: unknown
  const prisma = {
    employee: {
      findUnique: async () => employee
    },
    pinganCollectionRun: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => (storedRun = create),
      findUnique: async () => storedRun
    },
    pinganCollectionPage: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => { pageRunId = create.runId }
    },
    pinganOrder: { findUnique: async () => ({ orderId: 'order-1' }) },
    pinganOrderAttachment: {
      findUnique: async () => null,
      upsert: async ({ create }: { create: Record<string, unknown> }) => { attachmentRunId = create.uploadRunId }
    }
  } as unknown as PrismaClient
  const minio = { putObject: async () => undefined } as any
  const app = fastify()
  await app.register(multipart)
  registerPinganIngestRoutes(app, prisma, minio)
  const identify = await app.inject({
    method: 'POST', url: '/api/v1/pingan/identify', payload: { pinganUserId: '70001', displayName: '采集账号' }
  })
  assert.equal(identify.statusCode, 200)
  assert.equal(identify.json().data.collectorEmployeeId, collectorEmployeeId)

  const date = '2026-11-20'
  const time = `${date}T00:00:00.000Z`
  const run = await app.inject({
    method: 'POST', url: '/api/v1/pingan/runs', payload: {
      pinganUserId: '70001', run: { id: runId, startedAt: time, state: 'running', installDate: date, scanStartDate: date, scanEndDate: date, collectorDisplayName: '采集账号' }
    }
  })
  assert.equal(run.statusCode, 200)
  assert.equal(storedRun.collectorEmployeeId, collectorEmployeeId)
  assert.equal(storedRun.collectorDisplayName, '采集账号')
  const page = await app.inject({
    method: 'POST', url: '/api/v1/pingan/pages', payload: {
      pinganUserId: '70001', page: {
        runId, orderType: 'ORDINARY_REGISTER', pageNum: 1, pageCount: 1, pageSize: 10, total: 1, rowCount: 1,
        state: 'completed', capturedAt: time, query: {}
      }
    }
  })
  assert.equal(page.statusCode, 200)
  assert.equal(pageRunId, runId)

  const file = 'test attachment'
  const form = new FormData()
  for (const [key, value] of Object.entries({
    runId, orderId: 'order-1', attachmentId: 'file-1', fileName: 'sample.txt', fileType: '', mimeType: 'text/plain',
    sha256: createHash('sha256').update(file).digest('hex'), capturedAt: time
  })) form.append(key, value)
  form.append('file', new Blob([file], { type: 'text/plain' }), 'sample.txt')
  const request = new Request('http://localhost', { method: 'POST', body: form })
  const upload = await app.inject({
    method: 'POST', url: '/api/v1/pingan/attachments',
    headers: { 'x-pingan-user-id': '70001', 'content-type': request.headers.get('content-type')! },
    payload: Buffer.from(await request.arrayBuffer())
  })
  assert.equal(upload.statusCode, 200, upload.body)
  assert.equal(attachmentRunId, runId)
  await app.close()
})

test('queues a PingAn MySQL order only when a valid first detail is saved', async () => {
  const harness = createHarness(42, null, [], collectorEmployeeId, 1, true)
  const response = await harness.app.inject({
    method: 'POST', url: '/api/v1/pingan/orders', payload: orderBody('88002', '处理人')
  })
  assert.equal(response.statusCode, 200)
  assert.equal(harness.queued.length, 1)
  assert.deepEqual(harness.queued[0].slice(0, 2), ['70001', 'order-1'])
  assert.match(String(harness.queued[0][2]), /^HYYD\d{16}$/)
  await harness.app.close()

  const listOnly = createHarness(42, null, [], collectorEmployeeId, 1, true)
  const payload = orderBody('88002', '处理人')
  payload.order.statusStr = '完成'
  payload.order.detailJson = null
  payload.order.captureState = 'list'
  const saved = await listOnly.app.inject({ method: 'POST', url: '/api/v1/pingan/orders', payload })
  assert.equal(saved.statusCode, 200)
  assert.equal(listOnly.queued.length, 0)
  await listOnly.app.close()
})

test('supplies a previously missing detail and queues it without replacing existing decrypted fields', async () => {
  const existing = {
    status: 'WAIT_CONFIRM', statusName: '待用户确认', lastSeenRunId: runId,
    detailJson: null, decryptedFields: { contactName: '已保存' }
  }
  const harness = createHarness(42, existing, [], collectorEmployeeId, 1, true)
  const payload = orderBody('88002', '处理人')
  payload.order.decryptedFields = { contactName: '不覆盖', patientName: '测试就诊人' }
  const response = await harness.app.inject({ method: 'POST', url: '/api/v1/pingan/orders', payload })
  assert.equal(response.statusCode, 200)
  assert.equal(harness.queued.length, 1)
  assert.deepEqual(existing.detailJson, payload.order.detailJson)
  assert.deepEqual(existing.decryptedFields, { contactName: '已保存', patientName: '测试就诊人' })
  await harness.app.close()
})
