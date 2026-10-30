import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchesMaskedId, runGreenPassIdCardOcr } from '../src/services/greenPassIdCardOcr.js'
import { isValidMainlandIdCard } from '../src/services/orderIdCardOcr.js'

test('脱敏号码必须逐位一致，不能用不同号码补全', () => {
  const id = '11010519491231002X'
  assert.equal(isValidMainlandIdCard(id), true)
  assert.equal(matchesMaskedId('110105********002X', id), true)
  assert.equal(matchesMaskedId('110106********002X', id), false)
  assert.equal(matchesMaskedId('110105****002X', id), false)
  assert.equal(isValidMainlandIdCard('110105194912310021'), false)
})

test('尚未关联远程订单时保留待处理，不读取图片或调用模型', async () => {
  const statuses: unknown[] = []
  const prisma: any = {
    $executeRaw: async (_sql: unknown, ...values: unknown[]) => { statuses.push(values); return 1 },
    order: { findUnique: async () => ({ source: 'taikang', sourceOrderNo: 'test', huanyuOrderNo: null }) },
    orderAttachment: { findMany: async () => { throw new Error('不应读取附件') } }
  }
  await runGreenPassIdCardOcr(prisma, {} as any, 123)
  assert.equal(statuses.length, 2)
  assert.equal(statuses[1][0], 'pending')
})

test('任务未抢占成功时不重复执行', async () => {
  const prisma: any = { $executeRaw: async () => 0, order: { findUnique: async () => { throw new Error('不应读取订单') } } }
  await runGreenPassIdCardOcr(prisma, {} as any, 123)
})
