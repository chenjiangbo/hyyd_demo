import assert from 'node:assert/strict'
import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { Client } from 'minio'
import { registerNativeChatAttachmentRoutes } from './nativeChatAttachments.js'

async function run(): Promise<void> {
  let employeeId = 1
  let writes: unknown[][] = []
  let affected = 1
  const attachment = { id: 9, employee_id: 1, message_id: 5, conversation_id: 2, storage_key: 'native/9',
    application_no: null, order_id: null, application_link_status: 'unmatched', application_link_source: null, application_link_evidence: null,
    source_metadata: { imageAnalysis: { imageType: '挂号凭证', registrationMatch: { status: 'completed', candidateApplications: [{ applicationNo: 'APP1', orders: [{ orderId: 10 }] }] } } } }
  const tx = { $executeRaw: async (_sql: TemplateStringsArray, ...values: unknown[]) => { writes.push(values); return affected } }
  const prisma = {
    $queryRaw: async () => [attachment],
    $executeRaw: tx.$executeRaw,
    $transaction: async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx),
    order: { findUnique: async ({ where }: { where: { id: number } }) => where.id === 20
      ? { assignedEmployeeId: 1, rawJson: { crmApplyNo: 'APP2' } }
      : { assignedEmployeeId: 2, rawJson: { crmApplyNo: 'APP3' } } }
  } as unknown as PrismaClient
  const app = Fastify()
  app.addHook('onRequest', async (request) => { Object.assign(request, { employee: { id: employeeId } }) })
  const triggered: number[] = []
  registerNativeChatAttachmentRoutes(app, prisma, {} as Client, {} as Client, async (_prisma, _minio, orderId) => { triggered.push(orderId); return null })
  const url = '/api/v1/native-chat/attachments/9/resolve-image-match'
  const wrongOwner = await app.inject({ method: 'POST', url, payload: { applicationNo: 'APP3', orderId: 30, manualSelection: true } })
  assert.equal(wrongOwner.statusCode, 400)
  const wrongApp = await app.inject({ method: 'POST', url, payload: { applicationNo: 'APP1', orderId: 20, manualSelection: true } })
  assert.equal(wrongApp.statusCode, 400)
  const nonCandidate = await app.inject({ method: 'POST', url, payload: { applicationNo: 'APP2', orderId: 20 } })
  assert.equal(nonCandidate.statusCode, 400)
  assert.equal(writes.length, 0)
  affected = 0
  const race = await app.inject({ method: 'POST', url, payload: { applicationNo: 'APP2', orderId: 20, manualSelection: true } })
  assert.equal(race.statusCode, 409)
  affected = 1
  writes = []
  const selected = await app.inject({ method: 'POST', url, payload: { applicationNo: 'APP2', orderId: 20, manualSelection: true } })
  assert.equal(selected.statusCode, 200)
  assert.equal(selected.json().data.orderId, 20)
  assert.ok(writes[0].some((value) => typeof value === 'string' && value.includes('order_list')))
  assert.deepEqual(triggered, [20])
  employeeId = 2
  const unauthorized = await app.inject({ method: 'POST', url: '/api/v1/native-chat/attachments/9/dismiss-image-match' })
  assert.equal(unauthorized.statusCode, 404)
  employeeId = 1
  writes = []
  const dismissed = await app.inject({ method: 'POST', url: '/api/v1/native-chat/attachments/9/dismiss-image-match' })
  assert.equal(dismissed.statusCode, 200)
  assert.ok(writes[0].some((value) => typeof value === 'string' && value.includes('manager_not_applicable')))
  assert.deepEqual(triggered, [20])
  await app.close()
  console.log('nativeChatAttachments: manual order validation, ownership, race and dismissal passed')
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
