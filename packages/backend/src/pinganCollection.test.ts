import assert from 'node:assert/strict'
import { test } from 'node:test'
import fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { isEmployeeAuthExemptPath } from './employeeRequestAuth.js'
import { registerPinganIngestRoutes } from './pinganCollection.js'

function createHarness(
  mappedEmployeeId: number | null,
  employees: Array<{ id: number; name: string }> = [],
  existingOrder: Record<string, any> | null = null,
  attachmentIds: string[] = []
) {
  let savedOrder: Record<string, any> | null = null
  let savedStaffId: string | null = null
  const tx = {
    pinganAccount: { findUnique: async () => ({ pinganUserId: '70001', employeeId: null }) },
    employee: {
      findMany: async ({ where }: { where: { name: string } }) => employees.filter((employee) => employee.name === where.name),
      updateMany: async () => ({ count: 1 })
    },
    pinganStaff: {
      findUnique: async () => ({ employeeId: mappedEmployeeId }),
      upsert: async ({ where, create }: { where: { pinganStaffId: string }; create: Record<string, unknown> }) => {
        savedStaffId = where.pinganStaffId
        return { ...create, employeeId: mappedEmployeeId ?? create.employeeId ?? null }
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
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)
  } as unknown as PrismaClient
  const minio = {} as any
  const app = fastify()
  app.addHook('preHandler', async (request, reply) => {
    if (isEmployeeAuthExemptPath(request.url)) return
    return reply.status(401).send({ error: 'missing employee header' })
  })
  registerPinganIngestRoutes(app, prisma, minio)
  return { app, getSavedOrder: () => savedOrder ?? existingOrder, getSavedStaffId: () => savedStaffId }
}

function orderBody(handlerUserId: string | null, handlerName: string | null): { pinganUserId: string; order: Record<string, any> } {
  return {
    pinganUserId: '70001',
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
  assert.equal(harness.getSavedStaffId(), '88002')
  assert.equal(harness.getSavedOrder()?.employeeId, 42)
  assert.equal(harness.getSavedOrder()?.handlerUserId, '88002')
  assert.equal(response.json().data.outcome, 'created')
  await harness.app.close()
})

test('automatically maps a PingAn handler to the uniquely matching Huanyu employee name', async () => {
  const harness = createHarness(null, [{ id: 73, name: '郝晶晶' }])
  const response = await harness.app.inject({ method: 'POST', url: '/api/v1/pingan/orders', payload: orderBody('88002', '郝晶晶(88002)') })

  assert.equal(response.statusCode, 200)
  assert.equal(response.json().data.employeeId, 73)
  assert.equal(harness.getSavedOrder()?.employeeId, 73)
  assert.equal(response.json().data.outcome, 'created')
  await harness.app.close()
})

test('an existing order updates status only and reports already stored attachments', async () => {
  const existing = {
    status: 'WAIT_APPOINTMENT',
    statusName: '待预约',
    employeeId: 73,
    handlerUserId: '88002',
    detailJson: { protected: 'previous detail' },
    decryptedFields: { identityNo: 'clear-value' },
    listJson: { protected: 'previous list' },
    captureState: 'complete'
  }
  const harness = createHarness(null, [], existing, ['attachment-1'])
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
  assert.equal(harness.getSavedStaffId(), null)
  await harness.app.close()
})

test('an existing order with unchanged status is acknowledged without updating its row', async () => {
  const existing = { status: 'WAIT_CONFIRM', statusName: '待用户确认', detailJson: { preserved: true } }
  const harness = createHarness(null, [], existing, [])
  const payload = orderBody('88002', '处理人(88002)')
  payload.order.detailJson = { preserved: false }
  const response = await harness.app.inject({ method: 'POST', url: '/api/v1/pingan/orders', payload })

  assert.equal(response.statusCode, 200)
  assert.equal(response.json().data.outcome, 'unchanged')
  assert.deepEqual(existing.detailJson, { preserved: true })
  assert.equal(harness.getSavedStaffId(), null)
  await harness.app.close()
})

test('PingAn ingest routes bypass only the Taikang employee-header requirement', () => {
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
  assert.equal(unassigned.getSavedStaffId(), null)
  assert.equal(unassigned.getSavedOrder(), null)
  await unassigned.app.close()
})
