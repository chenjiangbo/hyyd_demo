import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { Client } from 'minio'
import { registerNativeChatCollectionAdminRoutes } from './nativeChatCollectionAdmin.js'

async function run() {
  for (const [key, value] of Object.entries({ DATABASE_URL: 'postgresql://test:test@localhost:5432/test', HOST: '127.0.0.1', PORT: '13000', ADMIN_PASSWORD: 'test', ADMIN_JWT_SECRET: 'test', MINIO_HOST: 'localhost', MINIO_PORT: '9000', MINIO_PUBLIC_HOST: 'localhost', MINIO_PUBLIC_PORT: '9000', MINIO_ACCESS_KEY: 'test', MINIO_SECRET_KEY: 'test', MINIO_BUCKET_RECORDINGS: 'recordings', MINIO_BUCKET_SCREENSHOTS: 'screenshots', DASHSCOPE_API_KEY: 'test', HYYD_VLM_API_KEY: 'test' })) process.env[key] = value
  const runs: Array<{ id: bigint; status: string; result: unknown; created_at: Date }> = []
  const order = (id: number, app: string) => ({ id, sourceOrderNo: `O${id}`, customerName: '张三', customerPhone: null, hospital: '第一医院', dept: null, doctor: null, status: '进行中', assignedEmployeeId: null, rawJson: { crmApplyNo: app }, detailJson: {} })
  const prisma = {
    $queryRaw: async (parts: TemplateStringsArray) => {
      const sql = parts.join('?')
      if (sql.includes('FROM native_chat_attachments a JOIN')) return [{ storage_key: 'one.jpg', mime_type: null, application_no: null }]
      if (sql.includes('INSERT INTO image_analysis_test_runs')) { const row = { id: BigInt(runs.length + 1), status: 'running', result: {}, created_at: new Date() }; runs.push(row); return [{ id: row.id }] }
      if (sql.includes('FROM image_analysis_test_runs')) return runs
      if (sql.includes('FROM sys_settings')) return [{ key: 'order_ai_automation_config', value: { imageAiEnabled: false, communicationSilenceMinutes: 5, imageAnalysisModel: 'vision-test-model', textAnalysisProvider: 'dashscope', textAnalysisModel: 'qwen-plus' }, updated_at: new Date() }, { key: 'native_chat_image_analysis_start', value: { startAt: '2026-11-02T12:00:00.000Z' } }]
      throw new Error(`unexpected query: ${sql}`)
    },
    $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      assert.match(parts.join('?'), /UPDATE image_analysis_test_runs/)
      const row = runs.find((item) => item.id === values[2])!
      row.status = String(values[0]); row.result = JSON.parse(String(values[1]))
      return 1
    },
    order: { findMany: async () => [order(1, 'fwyy12345678'), order(2, 'fwyy87654321')] },
    call: { findMany: async () => [] }, nativeChatMessage: { findMany: async () => [] }
  } as unknown as PrismaClient
  const minio = { getObject: async () => Readable.from([Buffer.from('ffd8ffe00000', 'hex')]) } as unknown as Client
  const app = Fastify()
  registerNativeChatCollectionAdminRoutes(app, prisma, minio, minio)
  const savedFetch = globalThis.fetch
  let call = 0
  globalThis.fetch = async (_url, options) => {
    call++
    const body = JSON.parse(String(options?.body))
    assert.equal(body.model, call % 2 === 1 ? 'vision-test-model' : 'qwen-plus')
    const content = call % 2 === 1
      ? JSON.stringify({ imageType: '挂号凭证', typeDescription: '', description: '', visibleText: '', visibleFields: [{ label: '医院', value: '第一医院' }] })
      : call === 2 ? JSON.stringify({ applications: [] }) : JSON.stringify({ applications: [
        { applicationNo: 'fwyy12345678', confidence: 95, evidence: [], orders: [{ orderId: 1, confidence: 95, evidence: [] }] },
        { applicationNo: 'fwyy87654321', confidence: 60, evidence: [], orders: [{ orderId: 2, confidence: 60, evidence: [] }] }
      ], reason: '测试' })
    return new Response(JSON.stringify({ model: 'test-model', choices: [{ message: { content } }] }), { status: 200 })
  }
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/image-analysis-records/wechat/1/tests', headers: { 'content-type': 'application/json' }, payload: '{}' })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().data.status, 'failed')
    const result = response.json().data.result
    assert.match(result.error, /候选不完整/)
    assert.equal(result.image.imageType, '挂号凭证')
    assert.ok(result.imageResponse.content.includes('挂号凭证'))
    assert.equal(result.matchTrace.response, '{"applications":[]}')
    assert.ok(result.matchTrace.userPrompt.includes('fwyy12345678'))
    const history = await app.inject({ method: 'GET', url: '/api/v1/admin/image-analysis-records/wechat/1/tests' })
    assert.equal(history.json().data.length, 1)
    assert.equal(history.json().data[0].result.matchTrace.response, '{"applications":[]}')
    const success = await app.inject({ method: 'POST', url: '/api/v1/admin/image-analysis-records/wechat/1/tests', headers: { 'content-type': 'application/json' }, payload: '{}' })
    assert.equal(success.json().data.status, 'completed', success.body)
    assert.equal(success.json().data.result.match.orderId, 1)
    assert.equal(call, 4)
    console.log('图片测试接口保留识别与失败记录，且不修改业务数据')
  } finally { globalThis.fetch = savedFetch; await app.close() }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
