import assert from 'node:assert/strict'
import { parseNativeMatch } from './registrationProofService.js'

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
console.log('registrationProofService: unmatched and ambiguous decisions preserved')
