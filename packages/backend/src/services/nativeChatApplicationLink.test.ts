import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import { resolveNativeChatApplicationLinks } from './nativeChatApplicationLink.js'

type OrderFixture = { id: number; rawJson: { crmApplyNo: string }; customerName: string | null }

function prismaWithOrders(orders: OrderFixture[]): { prisma: PrismaClient; orderReads: number; unmatchedReads: number } {
  let orderReads = 0
  let unmatchedReads = 0
  const prisma = {
    order: {
      findMany: async () => {
        orderReads++
        return orders
      }
    },
    unmatchedOrderRef: {
      findMany: async () => {
        unmatchedReads++
        return []
      }
    }
  } as unknown as PrismaClient
  return {
    prisma,
    get orderReads() { return orderReads },
    get unmatchedReads() { return unmatchedReads }
  }
}

async function main(): Promise<void> {
  const db = prismaWithOrders([
    { id: 1, rawJson: { crmApplyNo: 'fwyy123456789012' }, customerName: '张三' },
    { id: 2, rawJson: { crmApplyNo: 'OD1234567890abcdef' }, customerName: '李四' },
    { id: 3, rawJson: { crmApplyNo: 'HY0000000012345678' }, customerName: '王五' }
  ])
  const links = await resolveNativeChatApplicationLinks(db.prisma, 7, [
    '就医服务群 fwyy123456789012',
    // The old resolver canonicalizes OCR-confusable characters before comparing.
    '李四 OD1234567890abcde|',
    // The old resolver has separate suffix behavior for the existing # tail convention.
    '王五#12345678',
    '普通业务会话'
  ])

  assert.deepEqual(links, [
    { applicationNo: 'fwyy123456789012', candidate: 'fwyy123456789012', status: 'matched' },
    { applicationNo: 'OD1234567890abcdef', candidate: 'OD1234567890abcde|', status: 'matched' },
    { applicationNo: 'HY0000000012345678', candidate: '#12345678', status: 'matched' },
    { applicationNo: null, candidate: null, status: 'no_candidate' }
  ])
  assert.equal(db.orderReads, 1, 'order source must be read once for the full directory')
  assert.equal(db.unmatchedReads, 1, 'confirmed mappings must be read once for the full directory')
  const padded = prismaWithOrders([
    { id: 4, rawJson: { crmApplyNo: ' fwyy123456789012 ' }, customerName: '张三' },
    { id: 5, rawJson: { crmApplyNo: 'fwyy123456789012' }, customerName: '张三' }
  ])
  assert.deepEqual(await resolveNativeChatApplicationLinks(padded.prisma, 7, ['就医服务群 fwyy123456789012']), [
    { applicationNo: 'fwyy123456789012', candidate: 'fwyy123456789012', status: 'matched' }
  ])
  console.log('nativeChatApplicationLink: 4 cases passed; database reads=2 for 4 titles')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
