import assert from 'node:assert/strict'
import { selectRegistrationProofScores } from './registrationProofConfidence.js'

const candidates = [
  { applicationNo: 'A', orders: [{ orderId: 1 }] },
  { applicationNo: 'B', orders: [{ orderId: 2 }] }
]
const input = (a: number, b: number, order = 95) => ({ applications: [
  { applicationNo: 'A', confidence: a, evidence: [], orders: [{ orderId: 1, confidence: order, evidence: [] }] },
  { applicationNo: 'B', confidence: b, evidence: [], orders: [{ orderId: 2, confidence: 80, evidence: [] }] }
] })
assert.equal(selectRegistrationProofScores(input(92, 70), candidates).order?.orderId, 1)
assert.equal(selectRegistrationProofScores(input(92, 89), candidates).application, null)
assert.equal(selectRegistrationProofScores(input(90, 70), candidates).application, null)
assert.equal(selectRegistrationProofScores(input(92, 82), candidates).application?.applicationNo, 'A')
assert.equal(selectRegistrationProofScores(input(92, 70, 90), candidates).order, null)
const multipleOrders = [{ applicationNo: 'A', orders: [{ orderId: 1 }, { orderId: 3 }] }]
const orderInput = (first: number, second: number) => ({ applications: [{ applicationNo: 'A', confidence: 20, evidence: [], orders: [
  { orderId: 1, confidence: first, evidence: [] }, { orderId: 3, confidence: second, evidence: [] }
] }] })
assert.equal(selectRegistrationProofScores(orderInput(92, 80), multipleOrders).application?.applicationNo, 'A')
assert.equal(selectRegistrationProofScores(orderInput(92, 80), multipleOrders).order?.orderId, 1)
assert.equal(selectRegistrationProofScores(orderInput(92, 85), multipleOrders).order, null)
assert.throws(() => selectRegistrationProofScores({ applications: [] }, candidates))
assert.throws(() => selectRegistrationProofScores(input(101, 70), candidates))
console.log('registration proof confidence thresholds verified')
