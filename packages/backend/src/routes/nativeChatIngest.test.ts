import assert from 'node:assert/strict'
import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { registerNativeChatIngestRoutes } from './nativeChatIngest.js'

async function run(): Promise<void> {
  let conversation: { id: number; application_no: string | null; application_candidate: string | null; application_link_status: string } | null = null
  const inserted: unknown[][] = []
  const queued: string[] = []
  const tx = {
    $queryRaw: async (query: TemplateStringsArray | { sql: string }, ...values: unknown[]) => {
      const sql = Array.isArray(query) ? query.join('?') : (query as { sql: string }).sql
      if (sql.includes('FROM native_chat_conversations')) return conversation ? [conversation] : []
      if (sql.includes('INSERT INTO native_chat_messages')) {
        inserted.push(values)
        return [{ id: inserted.length, inserted: true }]
      }
      if (sql.includes('FROM orders')) return [{ id: 42, source_order_no: 'COD12345678', application_no: 'fwyy12345678' }]
      throw new Error(`unexpected query: ${sql}`)
    },
    $executeRaw: async (query: TemplateStringsArray) => { queued.push(query.join('?')); return 1 }
  }
  const prisma = { $transaction: async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient
  const app = Fastify()
  app.addHook('onRequest', async (request) => { Object.assign(request, { employee: { id: 1 } }) })
  registerNativeChatIngestRoutes(app, prisma)
  const base = { channel: 'wechat', accountId: 'account', sourceConversationId: 'session' }
  const message = { ...base, sourceMessageId: 'msg1', direction: 'incoming', kind: 'text', text: '普通消息', occurredAt: '2026-10-30T00:00:00Z', observedAt: '2026-10-30T00:00:00Z' }
  const payload = { conversation: { ...base, kind: 'single', title: '陪诊' }, messages: [message] }
  const missing = await app.inject({ method: 'POST', url: '/api/v1/native-chat/ingest', payload })
  assert.equal(missing.statusCode, 409)
  assert.equal(missing.json().code, 'conversation_not_registered')
  assert.equal(inserted.length, 0)

  conversation = { id: 10, application_no: null, application_candidate: null, application_link_status: 'no_candidate' }
  const unmatched = await app.inject({ method: 'POST', url: '/api/v1/native-chat/ingest', payload })
  assert.equal(unmatched.statusCode, 200)
  assert.equal(unmatched.json().data.acknowledged, true)
  assert.equal(inserted[0][13], null)

  conversation = { id: 10, application_no: 'fwyy12345678', application_candidate: 'fwyy12345678', application_link_status: 'matched' }
  const matched = await app.inject({ method: 'POST', url: '/api/v1/native-chat/ingest', payload })
  assert.equal(matched.statusCode, 200)
  assert.equal(inserted[1][13], 'fwyy12345678')
  assert.equal(inserted[1][14], null)

  conversation = { id: 10, application_no: null, application_candidate: null, application_link_status: 'no_candidate' }
  const dispatch = await app.inject({ method: 'POST', url: '/api/v1/native-chat/ingest', payload: {
    ...payload, messages: [{ ...message, sourceMessageId: 'msg2', text: '渠道订单号：COD12345678' }]
  } })
  assert.equal(dispatch.statusCode, 200)
  assert.equal(inserted[2][13], 'fwyy12345678')
  assert.equal(inserted[2][14], 42)
  const summary = await app.inject({ method: 'POST', url: '/api/v1/native-chat/ingest', payload: {
    ...payload, messages: [{ ...message, sourceMessageId: 'msg3', text: '陪诊小结：' + '字'.repeat(77) }]
  } })
  assert.equal(summary.statusCode, 200)
  assert.ok(queued.some((sql) => sql.includes('INSERT INTO escort_summary_jobs') && sql.includes('enabled_since')))
  queued.length = 0
  const shortSummary = await app.inject({ method: 'POST', url: '/api/v1/native-chat/ingest', payload: {
    ...payload, messages: [{ ...message, sourceMessageId: 'msg4', text: '陪诊小结' + '字'.repeat(76) }]
  } })
  assert.equal(shortSummary.statusCode, 200)
  assert.equal(queued.some((sql) => sql.includes('INSERT INTO escort_summary_jobs')), false)
  await app.close()
  console.log('nativeChatIngest: missing directory, unmatched, title link and dispatch link passed')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
