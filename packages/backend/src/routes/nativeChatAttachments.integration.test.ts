import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'
import type { Client } from 'minio'
import { registerNativeChatAttachmentRoutes } from './nativeChatAttachments.js'

async function run(): Promise<void> {
  const prisma = new PrismaClient()
  const metadata = JSON.stringify({ imageAnalysis: { imageType: '挂号凭证', registrationMatch: { status: 'completed', applicationDecision: 'ambiguous', orderDecision: 'not_evaluated', candidateApplications: [{ applicationNo: 'APP1', orders: [{ orderId: 10 }] }] } } })
  const statements = [
    'CREATE TABLE orders (id integer PRIMARY KEY, assigned_employee_id integer, raw_json jsonb)',
    'CREATE TABLE native_chat_conversations (id integer PRIMARY KEY, employee_id integer NOT NULL, channel text NOT NULL)',
    'CREATE TABLE native_chat_messages (id integer PRIMARY KEY, conversation_id integer NOT NULL, occurred_at timestamp NOT NULL, sender_name text)',
    'CREATE TABLE native_chat_attachments (id integer PRIMARY KEY, message_id integer NOT NULL, kind text NOT NULL, file_name text, storage_key text, source_metadata jsonb, application_no text, order_id integer, application_link_status text NOT NULL, application_link_source text, application_link_evidence jsonb, application_linked_at timestamp, updated_at timestamp NOT NULL DEFAULT NOW())',
    `INSERT INTO orders VALUES (20,1,'{"crmApplyNo":"APP2"}'),(30,2,'{"crmApplyNo":"APP3"}')`,
    "INSERT INTO native_chat_conversations VALUES (1,1,'wechat')",
    "INSERT INTO native_chat_messages VALUES (1,1,'2026-11-04 12:00:00','员工')"
  ]
  try {
    for (const statement of statements) await prisma.$executeRawUnsafe(statement)
    await prisma.$executeRawUnsafe("INSERT INTO native_chat_attachments (id,message_id,kind,file_name,storage_key,source_metadata,application_link_status) VALUES (9,1,'image','a.png','key1',$1::jsonb,'unmatched'),(10,1,'image','b.png','key2',$1::jsonb,'unmatched')", metadata)
    const app = Fastify()
    app.addHook('onRequest', async (request) => { Object.assign(request, { employee: { id: 1 } }) })
    const triggered: number[] = []
    const minio = { presignedGetObject: async () => 'http://example.invalid/test' } as unknown as Client
    registerNativeChatAttachmentRoutes(app, prisma, minio, minio, async (_prisma, _minio, id) => { triggered.push(id); return null })
    const pending = async () => (await app.inject({ method: 'GET', url: '/api/v1/native-chat/pending-image-matches' })).json().data
    assert.equal((await pending()).length, 2)
    const dismissed = await app.inject({ method: 'POST', url: '/api/v1/native-chat/attachments/9/dismiss-image-match' })
    assert.equal(dismissed.statusCode, 200, dismissed.body)
    assert.equal((await pending()).length, 1)
    await prisma.$executeRawUnsafe('UPDATE native_chat_attachments SET source_metadata = $1::jsonb WHERE id = 9', metadata)
    assert.equal((await pending()).length, 1, 'manual decision survives refreshed AI metadata')
    const wrongEmployee = await app.inject({ method: 'POST', url: '/api/v1/native-chat/attachments/10/resolve-image-match', payload: { applicationNo: 'APP3', orderId: 30, manualSelection: true } })
    assert.equal(wrongEmployee.statusCode, 400)
    const selected = await app.inject({ method: 'POST', url: '/api/v1/native-chat/attachments/10/resolve-image-match', payload: { applicationNo: 'APP2', orderId: 20, manualSelection: true } })
    assert.equal(selected.statusCode, 200, selected.body)
    assert.deepEqual(triggered, [20])
    assert.equal((await pending()).length, 0)
    const rows = await prisma.$queryRawUnsafe<Array<{ id: number; application_no: string | null; order_id: number | null; application_link_evidence: { status: string } }>>('SELECT id, application_no, order_id, application_link_evidence FROM native_chat_attachments ORDER BY id')
    assert.equal(rows[0].application_link_evidence.status, 'manager_not_applicable')
    assert.equal(rows[0].application_no, null)
    assert.equal(rows[1].application_no, 'APP2')
    assert.equal(rows[1].order_id, 20)
    await app.close()
    console.log('nativeChatAttachments: database selection, dismissal, reanalysis and order AI trigger passed')
  } finally { await prisma.$disconnect() }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
