import assert from 'node:assert/strict'
import type { PoolConnection } from 'mysql2/promise'
import { updateHuanyuOrderDirectlyOnMysql, type PetHuanyuOrderUpdate } from './huanyuMysqlPush.js'

async function run() {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let currentSummary = '已有小结'
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    execute: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      if (sql.startsWith('SELECT `DDBH`')) return [[{ DDBH: 'HYYD123456', DD_state: '进行中', PZXJ: currentSummary }]]
      if (sql.startsWith('SELECT `ZJ`')) return [[]]
      return [{ affectedRows: 1 }]
    }
  } as unknown as PoolConnection
  const input: PetHuanyuOrderUpdate = { orderNo: 'HYYD123456', orderStatus: '进行中', hospitalId: null, hospitalAddressId: null, departmentId: null, doctorId: null, requestTime: null, responseTime: null, serviceStartTime: null, bookingFeedbackTime: null, latestTicketTime: null, escortSummary: '人工确认的小结', escortList: [], expectedEscorts: [], expectedOrder: { orderStatus: '进行中', escortSummary: '已有小结' } }
  await updateHuanyuOrderDirectlyOnMysql(input, connection)
  const update = calls.find((call) => call.sql.startsWith('UPDATE `HY_FACT_DDCX_NEW` SET\n'))
  assert.ok(update)
  assert.match(update.sql, /`PZXJ` = \?/)
  assert.equal(update.params.at(-2), '人工确认的小结')
  currentSummary = '其他员工刚更新的小结'
  calls.length = 0
  await assert.rejects(() => updateHuanyuOrderDirectlyOnMysql(input, connection), /订单内容已发生变化/)
  assert.equal(calls.some((call) => call.sql.startsWith('UPDATE `HY_FACT_DDCX_NEW`')), false)
  console.log('ABI 陪诊小结写入及并发修改保护通过')
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
