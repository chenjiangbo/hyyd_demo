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
  const savedFetch = globalThis.fetch
  for (const [key, value] of Object.entries({ DATABASE_URL: 'postgresql://test:test@localhost:5432/test', HOST: '127.0.0.1', PORT: '13000', ADMIN_PASSWORD: 'test', ADMIN_JWT_SECRET: 'test', MINIO_HOST: 'localhost', MINIO_PORT: '9000', MINIO_PUBLIC_HOST: 'localhost', MINIO_PUBLIC_PORT: '9000', MINIO_ACCESS_KEY: 'test', MINIO_SECRET_KEY: 'test', MINIO_BUCKET_RECORDINGS: 'recordings', MINIO_BUCKET_SCREENSHOTS: 'screenshots' })) process.env[key] ??= value
  const savedKey = process.env.DASHSCOPE_API_KEY
  process.env.DASHSCOPE_API_KEY = 'test-key'
  const traces: Array<{ systemPrompt: string; userPrompt: string; response?: string }> = []
  let requestBody: any
  let requestUrl = ''
  globalThis.fetch = async (_url, init) => {
    requestUrl = String(_url)
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ model: 'test-model', choices: [{ message: { content: '{"applications":[]}' } }] }), { status: 200 })
  }
  try {
    const second = { ...order, id: 43, rawJson: { crmApplyNo: 'fwyy87654321' } }
    const unexpectedCommunicationQuery = async () => { throw new Error('图片归属匹配不应读取沟通记录') }
    const prismaMultiple = { order: { findMany: async () => [order, second] }, call: { findMany: unexpectedCommunicationQuery }, nativeChatMessage: { findMany: unexpectedCommunicationQuery }, $queryRaw: async () => [{ key: 'order_ai_automation_config', value: { imageAiEnabled: true, communicationSilenceMinutes: 5, textAnalysisModel: 'qwen-plus', imageAnalysisModel: 'qwen3-vl-plus', textAnalysisProvider: 'dashscope' }, updated_at: new Date() }, { key: 'native_chat_image_analysis_start', value: { startAt: '2026-11-02T12:00:00.000Z' } }] } as unknown as PrismaClient
    const imageWithTrace = { ...image, imageAttempts: [{ response: '重复的原始返回' }] }
    await assert.rejects(matchNativeRegistrationProofToOrders(prismaMultiple, 'data:image/jpeg;base64,AA==', imageWithTrace, { applicationNo: null, onAiTrace: async (trace) => { traces.push({ ...trace }) } }), /候选不完整/)
    assert.equal(traces.length, 2)
    assert.equal(traces[0].systemPrompt, requestBody.messages[0].content)
    assert.equal(traces[0].userPrompt, requestBody.messages[1].content)
    assert.equal(requestBody.model, 'qwen-plus')
    assert.match(requestBody.messages[1].content, /图片识别结果/)
    assert.match(requestBody.messages[1].content, /程序检索到的申领号及其全部订单/)
    assert.equal(requestBody.messages[1].content.includes('沟通'), false)
    assert.equal(requestBody.messages[0].content.includes('沟通'), false)
    assert.ok(requestBody.messages[1].content.includes(app))
    assert.ok(requestBody.messages[1].content.includes('fwyy87654321'))
    assert.match(requestBody.messages[1].content, /"sourceOrderNo":"X"/)
    assert.equal(requestBody.messages[1].content.includes('重复的原始返回'), false)
    assert.equal(requestBody.messages[1].content.includes('data:image'), false)
    assert.equal(traces[1].response, '{"applications":[]}')
    assert.match(traces[0].systemPrompt, /申领号尚未确定/)
    const sameApplication = { ...order, id: 43 }
    const oneApplicationPrisma = { ...prismaMultiple, order: { findMany: async () => [order, sameApplication] } } as unknown as PrismaClient
    const singleTraces: Array<{ systemPrompt: string }> = []
    await assert.rejects(matchNativeRegistrationProofToOrders(oneApplicationPrisma, '', image, { applicationNo: null, onAiTrace: async (trace) => { singleTraces.push(trace) } }), /候选不完整/)
    assert.match(singleTraces[0].systemPrompt, /程序已确定唯一候选申领号/)
    const incompleteResponseFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({ model: 'test-model', choices: [{ message: { content: JSON.stringify({ applications: [
      { applicationNo: app, confidence: 98, evidence: ['医院一致'], orders: [{ orderId: 42, confidence: 98, evidence: ['医院一致'] }] },
      { applicationNo: 'fwyy87654321', confidence: 20, evidence: [], orders: [{ orderId: 43, confidence: 20, evidence: [] }] }
    ], reason: '医院一致' }) } }] }), { status: 200 })
    const matched = await matchNativeRegistrationProofToOrders(prismaMultiple, '', image, { applicationNo: null })
    assert.equal(matched.applicationNo, app)
    assert.equal(matched.orderId, 42)
    globalThis.fetch = incompleteResponseFetch
    const savedDeepseekKey = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = 'test-key'
    try {
      const deepseekPrisma = { ...prismaMultiple, $queryRaw: async () => [{ key: 'order_ai_automation_config', value: { imageAiEnabled: true, communicationSilenceMinutes: 5, textAnalysisModel: 'deepseek-flash', imageAnalysisModel: 'qwen3-vl-plus', textAnalysisProvider: 'deepseek' }, updated_at: new Date() }, { key: 'native_chat_image_analysis_start', value: { startAt: '2026-11-02T12:00:00.000Z' } }] } as unknown as PrismaClient
      await assert.rejects(matchNativeRegistrationProofToOrders(deepseekPrisma, '', image, { applicationNo: null }), /候选不完整/)
      assert.equal(requestBody.model, 'deepseek-flash')
      assert.equal(requestUrl, 'https://api.deepseek.com/chat/completions')
    } finally {
      if (savedDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = savedDeepseekKey
    }
  } finally {
    globalThis.fetch = savedFetch
    if (savedKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = savedKey
  }
  console.log('registrationProofService: candidate decisions and unique match verified')
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
