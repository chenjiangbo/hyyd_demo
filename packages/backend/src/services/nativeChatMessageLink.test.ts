import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import { resolveNativeMessageBusinessLinksBatch } from './nativeChatMessageLink.js'
import { parseEscortDispatchTemplate } from '../lib/escortTemplateMatch.js'

function prismaWithOrders(rows: Array<{ id: number; source_order_no: string; application_no: string | null }>): PrismaClient {
  return {
    $queryRaw: async () => rows
  } as unknown as PrismaClient
}

const linkedTitle = { applicationNo: 'APP-12345678', candidate: 'APP-12345678', status: 'matched' as const }
const noTitle = { applicationNo: null, candidate: null, status: 'no_candidate' as const }

async function main(): Promise<void> {
  assert.equal(parseEscortDispatchTemplate('渠道订单号：COD12345678 服务项目：全程门诊').channelOrderNo, 'COD12345678')
  assert.equal(parseEscortDispatchTemplate('渠道订单编号: COD12345678\n服务项目：全程门诊').channelOrderNo, 'COD12345678')
  const sourceMessageId = 'dispatch-1'
  const body = '渠道订单号：COD1234567890123456\n就诊人：客户'
  const exact = await resolveNativeMessageBusinessLinksBatch(
    prismaWithOrders([{ id: 10, source_order_no: 'COD1234567890123456', application_no: 'APP-12345678' }]),
    [{ message: { sourceMessageId, text: body }, conversationLink: noTitle }]
  )
  assert.deepEqual(exact.get(sourceMessageId), {
    applicationNo: 'APP-12345678', candidate: 'COD1234567890123456', status: 'matched',
    orderId: 10, source: 'dispatch_channel_order_no',
    evidence: { channelOrderNo: 'COD1234567890123456', matchedOrderId: 10 }
  })

  const ambiguous = await resolveNativeMessageBusinessLinksBatch(
    prismaWithOrders([
      { id: 10, source_order_no: 'COD1234567890123456', application_no: 'APP-12345678' },
      { id: 11, source_order_no: 'COD1234567890123456', application_no: 'APP-87654321' }
    ]),
    [{ message: { sourceMessageId, text: body }, conversationLink: noTitle }]
  )
  assert.equal(ambiguous.get(sourceMessageId)?.status, 'ambiguous')
  assert.equal(ambiguous.get(sourceMessageId)?.applicationNo, null)
  assert.equal(ambiguous.get(sourceMessageId)?.orderId, null)

  const missingOrderDoesNotFallBackToTitle = await resolveNativeMessageBusinessLinksBatch(
    prismaWithOrders([]),
    [{ message: { sourceMessageId, text: body }, conversationLink: linkedTitle }]
  )
  assert.equal(missingOrderDoesNotFallBackToTitle.get(sourceMessageId)?.status, 'unmatched')
  assert.equal(missingOrderDoesNotFallBackToTitle.get(sourceMessageId)?.applicationNo, null)

  const ordinaryMessage = await resolveNativeMessageBusinessLinksBatch(
    prismaWithOrders([]),
    [{ message: { sourceMessageId: 'ordinary-1', text: '普通沟通' }, conversationLink: linkedTitle }]
  )
  assert.equal(ordinaryMessage.get('ordinary-1')?.applicationNo, 'APP-12345678')
  assert.equal(ordinaryMessage.get('ordinary-1')?.source, 'conversation_title')
  console.log('nativeChatMessageLink: 4 cases passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
