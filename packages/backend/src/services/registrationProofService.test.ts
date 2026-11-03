import assert from 'node:assert/strict'
import { matchNativeRegistrationProofToOrders, parseNativeMatch } from './registrationProofService.js'
import type { PrismaClient } from '@prisma/client'

const app = 'fwyy12345678'
const applications = new Set([app])
const orders = new Map([[app, new Set([42])]])
const response = (applicationDecision: string, applicationNo: string | null, orderDecision: string, orderId: number | null) => JSON.stringify({
  applicationDecision, applicationNo, applicationEvidence: [], orderDecision, orderId, orderEvidence: [], alternatives: [], reason: ''
})

for (const decision of ['no_match', 'ambiguous']) {
  const result = parseNativeMatch(response(decision, null, 'not_evaluated', null), applications, orders, null)
  assert.equal(result.applicationDecision, decision)
  assert.equal(result.orderDecision, 'not_evaluated')
  assert.throws(() => parseNativeMatch(response(decision, null, 'matched', 42), applications, orders, null))
}
assert.equal(parseNativeMatch(response('matched', app, 'matched', 42), applications, orders, null).orderId, 42)
assert.equal(parseNativeMatch(response('matched', app, 'ambiguous', null), applications, orders, app).applicationNo, app)
async function run() {
  const image = { imageType: '挂号凭证', typeDescription: '', description: '', visibleText: '', visibleFields: [{ label: '医院', value: '第一医院' }] }
  const order = { id: 42, sourceOrderNo: 'X', customerName: '张三', customerPhone: null, hospital: '第一医院', dept: null, doctor: null, status: '进行中', assignedEmployeeId: null, rawJson: { crmApplyNo: app }, detailJson: {} }
  const prisma = { order: { findMany: async () => [order] } } as unknown as PrismaClient
  const unique = await matchNativeRegistrationProofToOrders(prisma, '', image, { applicationNo: null })
  assert.equal(unique.applicationNo, app)
  assert.equal(unique.orderId, 42)
  assert.equal(unique.reason, '程序找到唯一申领号和订单')
  const none = await matchNativeRegistrationProofToOrders(prisma, '', { ...image, visibleFields: [] }, { applicationNo: null })
  assert.equal(none.applicationDecision, 'no_match')
  assert.equal(none.candidateApplicationCount, 0)
  console.log('registrationProofService: candidate decisions and unique match verified')
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
