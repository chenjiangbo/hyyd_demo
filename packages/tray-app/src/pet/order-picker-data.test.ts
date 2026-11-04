import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applicationNoOf, loadApplicationOrders } from './order-picker-data'

test('loads all pages and selects only the exact application', async () => {
  const pages: number[] = []
  const order = (id: number, app: string) => ({ id, rawJson: { crmApplyNo: app }, sourceOrderNo: String(id), customerName: '客户', hospital: null, dept: null, doctor: null, status: '' })
  const items = await loadApplicationOrders('APP1', async (page, appNo) => {
    assert.equal(appNo, 'APP1'); pages.push(page)
    return { data: page === 1 ? [order(1, 'APP1'), order(2, 'APP10')] : [order(3, 'APP1')], page, total: 3, totalPages: 2 }
  })
  assert.deepEqual(pages, [1, 2])
  assert.deepEqual(items.map((item) => item.id), [1, 3])
  assert.equal(applicationNoOf(items[0]), 'APP1')
})

test('reports invalid pagination rather than silently omitting orders', async () => {
  await assert.rejects(loadApplicationOrders('APP1', async () => ({ data: [], page: 2, totalPages: 3 })), /格式无效/)
})
