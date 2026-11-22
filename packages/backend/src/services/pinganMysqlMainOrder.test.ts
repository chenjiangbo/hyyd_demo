import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pinganIdentityCandidates, pinganIdentityMask, pinganProductName, syncPinganMainOrder } from './pinganMysqlMainOrder.js'

const candidate = 'HYYD2026112000000001'
const identity = '11010519491231002X'

function order(orderType = 'HOSPITALIZE_DOMESTIC', decryptedIdentity = identity) {
  return {
    orderId: 'test-pingan-order',
    orderType,
    detailJson: {
      orderInfo: {
        orderId: 'test-pingan-order',
        rightCardName: '寿险VIP-住院安排协助（按使用结算）',
        goodsCode: 'XWA4558',
        identityTypeStr: orderType === 'HOSPITALIZE_DOMESTIC' ? '身份证' : '其他',
        identityMask: { maskValue: orderType === 'HOSPITALIZE_DOMESTIC' ? '110105********002X' : '1234****' },
        patientSex: 2,
        patientAge: 76
      }
    },
    decryptedFields: {
      identity: decryptedIdentity,
      patientName: '测试就诊人',
      patientTel: '13000000000',
      contactName: '测试就诊人',
      contactTel: '13000000000'
    },
    employee: { token: 'handler-login' }
  }
}

function harness(existing: string[] = [], channel: string | null = '0070') {
  const inserted: Record<string, unknown>[] = []
  const productQueries: Array<[string, string]> = []
  const lookups: string[] = []
  const deps = {
    findExisting: async (id: string, reservedDdbh: string) => {
      lookups.push(id)
      return existing.includes(reservedDdbh) ? reservedDdbh : existing[0] ?? null
    },
    channelId: async () => channel,
    findProduct: async (id: string, name: string) => {
      productQueries.push([id, name])
      return { id: '0070004', name, price: '7980.00', internalLevelOne: '', internalLevelTwo: '' }
    },
    insert: async (row: Record<string, unknown>) => { inserted.push(row) }
  }
  return { deps, inserted, productQueries, lookups }
}

test('matches the exact PingAn card variants and contract product CODE', () => {
  assert.equal(pinganProductName('HOSPITALIZE_DOMESTIC', { rightCardName: '寿险VIP-住院安排协助' }), '寿险全国住院T+10')
  assert.equal(pinganProductName('HOSPITALIZE_DOMESTIC', { rightCardName: '寿险VIP-住院安排协助（按使用结算）' }), '寿险全国住院T+10')
  assert.equal(pinganProductName('HOSPITALIZE_DOMESTIC', { rightCardName: '住院安排（居家）' }), '全国住院T+10')
  assert.equal(pinganProductName('ORDINARY_REGISTER', { goodsCode: 'XWA4558' }),
    '名医门诊预约协助-成都华西系统-院士、国医大师-履约结算-T+4-20938')
  assert.equal(pinganProductName('ORDINARY_REGISTER', { goodsCode: 'UNKNOWN' }), null)
})

test('creates the PingAn main order with the handler login, dictionary price and verified full ID', async () => {
  const { deps, inserted, productQueries, lookups } = harness()
  assert.deepEqual(await syncPinganMainOrder(order(), candidate, deps), {
    state: 'created', huanyuOrderNo: candidate, needsIdentity: false
  })
  assert.deepEqual(lookups, ['test-pingan-order'])
  assert.deepEqual(productQueries, [['0070', '寿险全国住院T+10']])
  assert.deepEqual(Object.fromEntries(['DDBH', 'BDQD_DDBH', 'BDQD', 'BDQD_FWXM', 'DDJE', 'KHJL', 'JZR_ZJHM', 'JZR_JSLXFS']
    .map(key => [key, inserted[0]?.[key]])), {
    DDBH: candidate, BDQD_DDBH: 'test-pingan-order', BDQD: '0070', BDQD_FWXM: '0070004', DDJE: '7980.00',
    KHJL: 'handler-login', JZR_ZJHM: identity, JZR_JSLXFS: null
  })
})

test('never writes an eight-digit other document number into the ID field', async () => {
  const { deps, inserted } = harness()
  assert.equal((await syncPinganMainOrder(order('ORDINARY_REGISTER', '12345678'), candidate, deps)).state, 'created')
  assert.equal(inserted[0]?.JZR_ZJHM, null)
  assert.equal(inserted[0]?.JZR_ZJLX, '其他')
})

test('skips a remotely existing order and never marks it for OCR', async () => {
  const { deps, inserted, productQueries } = harness(['already-existing'])
  assert.deepEqual(await syncPinganMainOrder(order(), candidate, deps), {
    state: 'skipped', huanyuOrderNo: 'already-existing', needsIdentity: false
  })
  assert.equal(productQueries.length, 0)
  assert.equal(inserted.length, 0)
})

test('recovers only the reserved DDBH after the MySQL write acknowledgement is lost', async () => {
  const { deps, inserted } = harness(['already-existing', candidate])
  assert.deepEqual(await syncPinganMainOrder(order(), candidate, deps), {
    state: 'created', huanyuOrderNo: candidate, needsIdentity: true
  })
  assert.equal(inserted.length, 0)
})

test('keeps jobs pending when configuration or required detail is unavailable', async () => {
  const { deps, inserted, lookups } = harness([], null)
  assert.equal((await syncPinganMainOrder(order(), candidate, deps)).state, 'pending')
  assert.equal((await syncPinganMainOrder({ ...order(), detailJson: null }, candidate, deps)).state, 'pending')
  assert.equal(lookups.length, 0)
  assert.equal(inserted.length, 0)
})

test('checks OCR candidate name, ID checksum and visible source digits without treating other-document masks as ID masks', () => {
  const payload = JSON.stringify({ cards: [
    { name: '其他人', idNumber: identity },
    { name: '测试 就诊人', idNumber: identity.toLowerCase() },
    { name: '测试就诊人', idNumber: '110105194912310027' }
  ] })
  assert.deepEqual(pinganIdentityCandidates(payload, '测试就诊人', '110105********002X'), [identity])
  assert.deepEqual(pinganIdentityCandidates(payload, '测试就诊人', '440105********002X'), [])
  assert.equal(pinganIdentityMask(order('ORDINARY_REGISTER').detailJson), '')
})
