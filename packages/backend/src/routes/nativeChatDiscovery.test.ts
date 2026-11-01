import assert from 'node:assert/strict'
import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { registerNativeChatDiscoveryRoutes } from './nativeChatDiscovery.js'

async function run(): Promise<void> {
  let orderReads = 0
  let transactionCount = 0
  let nextId = 1
  const tx = {
    $queryRaw: async (query: { values: unknown[] }) => {
      const values = query.values
      return [{ id: nextId++, channel: values[1], account_id: values[2], source_conversation_id: values[3], application_no: values[6], application_link_status: values[8] }]
    },
    $executeRaw: async () => 0
  }
  const prisma = {
    order: { findMany: async () => { orderReads++; return [{ id: 1, rawJson: { crmApplyNo: 'fwyy123456789012' }, customerName: '张三' }] } },
    unmatchedOrderRef: { findMany: async () => [] },
    $transaction: async (fn: (value: typeof tx) => Promise<unknown>) => {
      transactionCount++
      if (transactionCount === 2) throw new Error('simulated batch failure')
      return fn(tx)
    }
  } as unknown as PrismaClient
  const app = Fastify()
  app.addHook('onRequest', async (request) => { Object.assign(request, { employee: { id: 1 } }) })
  registerNativeChatDiscoveryRoutes(app, prisma)
  const syncId = '12345678-1234-1234-1234-123456789012'
  const session = (id: string) => ({ channel: 'wechat', accountId: 'account', sourceConversationId: id, title: '就医服务群 fwyy123456789012', kind: 'group' })
  const request = (id: string, startSnapshot: boolean, lastBatch: boolean) => app.inject({ method: 'POST', url: '/api/v1/native-chat/discovery', payload: { syncId, startSnapshot, lastBatch, sessions: [session(id)] } })
  const first = await request('one', true, false)
  assert.equal(first.statusCode, 200, first.body)
  assert.equal(first.json().data.persisted, 1)
  const failed = await request('two', false, true)
  assert.equal(failed.statusCode, 500)
  const second = await request('two', false, true)
  assert.equal(second.statusCode, 200, second.body)
  assert.equal(second.json().data.persisted, 1)
  assert.equal(orderReads, 1, 'one directory sync must read order data once')
  assert.equal(transactionCount, 3, 'each batch and retry must use its own transaction')
  const expired = await request('three', false, false)
  assert.equal(expired.statusCode, 409)
  assert.equal(expired.json().code, 'discovery_snapshot_expired')
  await app.close()
  console.log('nativeChatDiscovery: independent batch commits, one order snapshot and expired snapshot passed')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
