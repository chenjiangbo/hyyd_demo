import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'
import { Client } from 'minio'
import { registerNativeChatCollectionAdminRoutes } from './nativeChatCollectionAdmin.js'
import { storePetAnalysisImage } from '../services/petImageAnalysisStorage.js'

async function run(): Promise<void> {
  const prisma = new PrismaClient()
  const statements = [
    'CREATE TABLE sys_settings (key text PRIMARY KEY, value jsonb NOT NULL)',
    'CREATE TABLE employees (id integer PRIMARY KEY, name text NOT NULL)',
    'CREATE TABLE native_chat_conversations (id integer PRIMARY KEY, employee_id integer NOT NULL, channel text NOT NULL, title text)',
    'CREATE TABLE native_chat_messages (id integer PRIMARY KEY, conversation_id integer NOT NULL, source_message_id text NOT NULL, parent_source_message_id text, occurred_at timestamp NOT NULL)',
    'CREATE TABLE native_chat_attachments (id integer PRIMARY KEY, message_id integer NOT NULL, kind text NOT NULL, state text NOT NULL, storage_key text, source_metadata jsonb, order_id integer)',
    'CREATE TABLE pet_image_analysis_records (id integer PRIMARY KEY, employee_id integer NOT NULL, status text NOT NULL, image_analysis jsonb, registration_match jsonb, error text, order_id integer, created_at timestamp NOT NULL, image_storage_key text, image_mime_type text, updated_at timestamp NOT NULL DEFAULT NOW())',
    `INSERT INTO sys_settings VALUES ('native_chat_image_analysis_start', '{"startAt":"2026-11-02T12:00:00.000Z"}')`,
    "INSERT INTO employees VALUES (1, '测试员工')",
    "INSERT INTO native_chat_conversations VALUES (1, 1, 'wechat', '测试会话')",
    `INSERT INTO native_chat_messages VALUES
      (1,1,'before',NULL,'2026-11-02 19:59:59'),
      (2,1,'after',NULL,'2026-11-02 20:00:00'),
      (3,1,'old-parent',NULL,'2026-10-01 00:00:00'),
      (4,1,'child-new','old-parent','2026-11-03 00:00:00'),
      (5,1,'new-parent',NULL,'2026-11-03 00:00:00'),
      (6,1,'child-old','new-parent','2026-10-01 00:00:00')`,
    `INSERT INTO native_chat_attachments VALUES
      (1,1,'image','available','before',NULL,NULL),
      (2,2,'image','available','after',NULL,NULL),
      (3,4,'image','available','old-parent-child',NULL,NULL),
      (4,6,'image','not_downloaded',NULL,NULL,NULL)`,
    `INSERT INTO pet_image_analysis_records (id,employee_id,status,image_analysis,registration_match,error,order_id,created_at,image_storage_key,image_mime_type) VALUES
      (1,1,'completed','{}',NULL,NULL,NULL,'2026-11-03 00:00:00','pet-image-analysis/1/1','image/png'),
      (2,1,'completed','{}',NULL,NULL,NULL,'2026-11-03 00:00:01',NULL,NULL),
      (3,1,'completed','{}',NULL,NULL,NULL,'2026-11-02 19:00:00',NULL,NULL)`,
    `INSERT INTO native_chat_messages SELECT 100+n,1,'extra-'||n,NULL,'2026-11-03 01:00:00'::timestamp + n * interval '1 second' FROM generate_series(1,52) AS n`,
    `INSERT INTO native_chat_attachments SELECT 100+n,100+n,'image','available','extra-'||n,NULL,NULL FROM generate_series(1,52) AS n`
  ]
  try {
    for (const statement of statements) await prisma.$executeRawUnsafe(statement)
    const minio = new Client({ endPoint: '127.0.0.1', port: Number(process.env.TEST_MINIO_PORT), useSSL: false, accessKey: 'localcheck', secretKey: 'localcheck-password' })
    if (!await minio.bucketExists('materials')) await minio.makeBucket('materials', 'us-east-1')
    const imageBytes = Buffer.from('image content for test')
    await storePetAnalysisImage(prisma, minio, 1, 1, imageBytes, 'image/png', (error) => { throw error })
    const saved = await minio.getObject('materials', 'pet-image-analysis/1/1')
    const chunks: Buffer[] = []
    for await (const chunk of saved) chunks.push(Buffer.from(chunk))
    assert.deepEqual(Buffer.concat(chunks), imageBytes)
    await assert.rejects(storePetAnalysisImage(prisma, minio, 1, 999, imageBytes, 'image/png', (error) => { throw error }))
    await assert.rejects(minio.statObject('materials', 'pet-image-analysis/1/999'))
    const app = Fastify()
    registerNativeChatCollectionAdminRoutes(app, prisma, minio, minio)
    const first = await app.inject({ method: 'GET', url: '/api/v1/admin/image-analysis-records' })
    assert.equal(first.statusCode, 200, first.body)
    const page = first.json().data
    assert.equal(page.total, 56)
    assert.equal(page.items.length, 50)
    assert.ok(page.nextCursor)
    const second = await app.inject({ method: 'GET', url: `/api/v1/admin/image-analysis-records?cursor=${page.nextCursor}` })
    assert.equal(second.statusCode, 200, second.body)
    assert.equal(second.json().data.total, 56)
    const all = [...page.items, ...second.json().data.items]
    assert.equal(all.length, 56)
    assert.equal(new Set(all.map((r: { source: string; id: number }) => `${r.source}:${r.id}`)).size, 56)
    assert.equal(all.some((r: { source: string; id: number }) => r.source === 'wechat' && r.id === 1), false)
    assert.equal(all.some((r: { source: string; id: number }) => r.source === 'wechat' && r.id === 3), false)
    assert.equal(all.find((r: { source: string; id: number }) => r.source === 'wechat' && r.id === 4).image_available, false)
    assert.equal(all.find((r: { source: string; id: number }) => r.source === 'pet' && r.id === 1).image_available, true)
    assert.equal(all.find((r: { source: string; id: number }) => r.source === 'pet' && r.id === 2).image_available, false)
    const petUrl = await app.inject({ method: 'GET', url: '/api/v1/admin/image-analysis-records/pet/1/url' })
    assert.equal(petUrl.statusCode, 200)
    assert.match(petUrl.json().data.url, /pet-image-analysis\/1\/1/)
    const noImage = await app.inject({ method: 'GET', url: '/api/v1/admin/image-analysis-records/pet/2/url' })
    assert.equal(noImage.statusCode, 404)
    await app.close()
    console.log('imageAnalysisRecords: cutoff, merged parent time, total, pagination and pet preview passed')
  } finally { await prisma.$disconnect() }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
