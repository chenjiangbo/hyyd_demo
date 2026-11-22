import { pinganContractProducts } from '../dictionaries/pinganContractProducts.js'
import { isValidMainlandIdCard } from './orderIdCardOcr.js'
import { findHuanyuChannelProductByName } from '../db/remoteDictionary.js'
import { createHuanyuOrderOnMysql, findPinganMysqlOrderNo } from '../huanyuMysqlPush.js'

export const PINGAN_CHANNEL_BUSINESS_KEY = 'pingan'
const LIFE_HOSPITAL_CARD = '寿险VIP-住院安排协助'

export function pinganObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, limit: number): string | null {
  return typeof value === 'string' ? value.trim().slice(0, limit) || null : null
}

export function pinganIdentityText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s/g, '').toUpperCase() : ''
}

export function pinganIdentityMask(detailJson: unknown): string {
  const info = pinganObject(pinganObject(detailJson).orderInfo)
  const mask = pinganIdentityText(pinganObject(info.identityMask).maskValue).replace(/[＊●•]/g, '*')
  return /^[0-9X*]{18}$/.test(mask) ? mask : ''
}

export function matchesPinganIdentityMask(mask: string, identity: string): boolean {
  return !mask || (mask.length === identity.length && [...mask].every((char, i) => char === '*' || char === identity[i]))
}

export function pinganIdentityCandidates(content: string, expectedName: string, mask: string): string[] {
  const decoded = pinganObject(JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()))
  if (!Array.isArray(decoded.cards)) throw new Error('InvalidPinganOcrResponse')
  return decoded.cards.flatMap(item => {
    const card = pinganObject(item)
    const identity = pinganIdentityText(card.idNumber)
    const name = typeof card.name === 'string' ? card.name.replace(/\s/g, '') : ''
    return name === expectedName && isValidMainlandIdCard(identity) && matchesPinganIdentityMask(mask, identity)
      ? [identity] : []
  })
}

function sourceIdentity(order: PinganMainOrderSource): string | null {
  const identity = pinganIdentityText(pinganObject(order.decryptedFields).identity)
  return isValidMainlandIdCard(identity) && matchesPinganIdentityMask(pinganIdentityMask(order.detailJson), identity) ? identity : null
}

export function pinganProductName(orderType: string, info: Record<string, unknown>): string | null {
  if (orderType === 'HOSPITALIZE_DOMESTIC') {
    const card = typeof info.rightCardName === 'string' ? info.rightCardName.trim().normalize('NFKC') : ''
    return card === LIFE_HOSPITAL_CARD || card === LIFE_HOSPITAL_CARD + '(按使用结算)'
      ? '寿险全国住院T+10'
      : '全国住院T+10'
  }
  if (orderType !== 'ORDINARY_REGISTER' || typeof info.goodsCode !== 'string') return null
  return pinganContractProducts.get(info.goodsCode.trim()) ?? null
}

export function pinganOrderInfo(detailJson: unknown, orderId: string): Record<string, unknown> | null {
  const info = pinganObject(pinganObject(detailJson).orderInfo)
  return info.orderId === orderId ? info : null
}

export interface PinganMainOrderSource {
  orderId: string
  orderType: string
  detailJson: unknown
  decryptedFields: unknown
  employee: { token: string } | null
}

interface MainOrderDependencies {
  findExisting: typeof findPinganMysqlOrderNo
  channelId: () => Promise<string | null>
  findProduct: typeof findHuanyuChannelProductByName
  insert: typeof createHuanyuOrderOnMysql
}

export type PinganMainOrderResult =
  | { state: 'pending'; failureCode: string }
  | { state: 'created' | 'skipped'; huanyuOrderNo: string; needsIdentity: boolean }

export async function syncPinganMainOrder(
  order: PinganMainOrderSource,
  candidateDdbh: string,
  deps: MainOrderDependencies
): Promise<PinganMainOrderResult> {
  const info = pinganOrderInfo(order.detailJson, order.orderId)
  const person = pinganObject(order.decryptedFields)
  const patientName = text(person.patientName, 50)
  if (!info || !patientName) return { state: 'pending', failureCode: '等待平安订单详情或就诊人信息' }
  const manager = text(order.employee?.token, 50)
  if (!manager) return { state: 'pending', failureCode: '平安处理人没有对应的寰宇员工登录名' }
  const channelId = await deps.channelId()
  if (!channelId) return { state: 'pending', failureCode: '平安好医生 B 端渠道未配置或已停用' }
  // A retry can find the exact DDBH reserved before the previous INSERT. Only that row belongs to this job.
  const existing = await deps.findExisting(order.orderId, candidateDdbh)
  if (existing === candidateDdbh) return { state: 'created', huanyuOrderNo: candidateDdbh, needsIdentity: true }
  if (existing !== null) return { state: 'skipped', huanyuOrderNo: existing, needsIdentity: false }

  const productName = pinganProductName(order.orderType, info)
  if (!productName) return { state: 'pending', failureCode: '平安产品 CODE 未在合同清单中匹配' }
  const product = await deps.findProduct(channelId, productName)
  if (!product) return { state: 'pending', failureCode: '所选渠道中无对应的寰宇服务项目' }
  const amount = product.price.trim()
  if (!/^\d+(?:\.\d+)?$/.test(amount)) return { state: 'pending', failureCode: '寰宇服务项目未配置有效金额' }

  const identity = sourceIdentity(order)
  const contactName = text(person.contactName, 50)
  const patientPhone = text(person.patientTel, 18)
  const contactPhone = text(person.contactTel, 18)
  const sameContact = contactName === patientName && contactPhone === patientPhone
  const age = typeof info.patientAge === 'number' && Number.isInteger(info.patientAge) && info.patientAge >= 0
    ? info.patientAge : null
  await deps.insert({
    DDBH: candidateDdbh,
    DD_state: '待跟进',
    BDQD: channelId,
    BDQD_DDBH: order.orderId,
    BDQD_FWXM: product.id,
    DDJE: amount,
    KHJL: manager,
    JZR_XM: patientName,
    JZR_LXDH: patientPhone,
    JZR_ZJLX: identity || info.identityTypeStr === '身份证' ? '身份证' : text(info.identityTypeStr, 30),
    JZR_ZJHM: identity,
    JZR_XB: info.patientSex === 1 ? '男' : info.patientSex === 2 ? '女' : null,
    JZR_NL: age,
    JZR_JSMC: sameContact ? null : contactName,
    JZR_JSLXFS: sameContact ? null : contactPhone,
    JZR_JB: text(info.illnessDesc, 100),
    JZR_BZ: text(order.orderType === 'HOSPITALIZE_DOMESTIC' ? info.note : info.reqDesc, 2000)
  })
  return { state: 'created', huanyuOrderNo: candidateDdbh, needsIdentity: !identity }
}
