import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import { loadNativeChatFieldAiBatch } from './nativeChatAiAdapter.js'

async function run(): Promise<void> {
  const time = new Date('2026-10-30T00:00:00Z')
  const message = {
    id: 1, text: '渠道订单号：COD123', observedAt: time, applicationLinkedAt: time,
    occurredAt: time, senderName: '经理', direction: 'outgoing', kind: 'text',
    sourceTypeCode: null, sourceItemIndex: null, conversation: { channel: 'wxwork' }, attachments: []
  }
  const proof = {
    id: 2, kind: 'image', fileName: '凭证.jpg', updatedAt: time, applicationLinkedAt: time,
    sourceMetadata: { imageAnalysis: { status: 'completed', imageType: '挂号凭证', description: '医院挂号凭证', visibleText: '患者：张三', visibleFields: [{ label: '科室', value: '内科' }] } },
    message: { ...message, id: 2, text: null, kind: 'image' }
  }
  let messageWhere: unknown
  let attachmentWhere: unknown
  const prisma = {
    nativeChatMessage: { findMany: async (query: { where: unknown }) => { messageWhere = query.where; return [message] } },
    nativeChatAttachment: { findMany: async (query: { where: unknown }) => { attachmentWhere = query.where; return [proof] } }
  } as unknown as PrismaClient
  const result = await loadNativeChatFieldAiBatch(prisma, 'fwyy12345678', 42)
  assert.deepEqual(messageWhere, { applicationLinkStatus: 'matched', OR: [{ applicationNo: 'fwyy12345678', orderId: null }, { orderId: 42 }] })
  assert.deepEqual(attachmentWhere, { applicationLinkStatus: 'matched', kind: 'image', OR: [{ applicationNo: 'fwyy12345678', orderId: null }, { orderId: 42 }], sourceMetadata: { path: ['imageAnalysis', 'imageType'], equals: '挂号凭证' } })
  assert.equal(result.messages.length, 2)
  assert.match(result.messages.find((item) => item.sourceRef === '原生消息#1')?.contentText ?? '', /渠道订单号：COD123/)
  const material = result.messages.find((item) => item.sourceRef === '挂号凭证素材#2')?.contentText ?? ''
  assert.match(material, /图片描述=医院挂号凭证/)
  assert.match(material, /患者：张三/)
  assert.match(material, /科室=内科/)
  console.log('nativeChatAiAdapter: individually linked messages and independent proof material passed')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
