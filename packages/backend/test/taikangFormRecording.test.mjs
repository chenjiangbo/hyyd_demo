import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { saveTaikangFormEvent } = require('../dist/taikangFormRecording.js')

const session = {
  id: '00000000-0000-4000-8000-000000000001',
  routeKind: 'green-order',
  startedAt: '2026-10-23T00:00:00.000Z'
}
const event = {
  id: '00000000-0000-4000-8000-000000000002',
  sequence: 2,
  occurredAt: '2026-10-23T00:00:01.000Z',
  kind: 'screenshot',
  payload: { trigger: '页面操作', relatedSequence: 1 }
}

test('screenshot event requires a JPEG image', async () => {
  const result = await saveTaikangFormEvent({}, {}, 'screenshots', 1, 'txy', 10, session, event)
  assert.equal(result.ok, false)
  assert.match(result.error, /截图数据缺失/)
})

test('screenshot is stored before the event is acknowledged', async () => {
  const operations = []
  let storedPayload
  const minio = {
    async putObject(bucket, key, bytes, length, metadata) {
      operations.push('image')
      assert.equal(bucket, 'screenshots')
      assert.match(key, /^taikang-form-recordings\/1\//)
      assert.equal(length, bytes.length)
      assert.equal(metadata['Content-Type'], 'image/jpeg')
    }
  }
  const tx = {
    taikangFormSession: {
      findUnique: async () => null,
      create: async () => { operations.push('session') },
      update: async () => { operations.push('count') }
    },
    taikangFormEvent: {
      findUnique: async () => null,
      create: async ({ data }) => { operations.push('event'); storedPayload = data.payload }
    }
  }
  const prisma = { $transaction: async (callback) => callback(tx) }
  const jpeg = Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9])
  const result = await saveTaikangFormEvent(
    prisma, minio, 'screenshots', 1, 'txy', 10, session, event,
    `data:image/jpeg;base64,${jpeg.toString('base64')}`
  )
  assert.deepEqual(result, { ok: true, duplicate: false })
  assert.deepEqual(operations, ['image', 'session', 'event', 'count'])
  assert.equal(storedPayload.byteSize, jpeg.length)
  assert.match(storedPayload.imageKey, /\.jpg$/)
})

test('storage failure does not acknowledge a screenshot event', async () => {
  const minio = { putObject: async () => { throw new Error('object store unavailable') } }
  const jpeg = Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9])
  const result = await saveTaikangFormEvent(
    {}, minio, 'screenshots', 1, 'txy', 10, session, event,
    `data:image/jpeg;base64,${jpeg.toString('base64')}`
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /object store unavailable/)
})
