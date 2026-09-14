import { Prisma, PrismaClient } from '@prisma/client'
import { randomInt } from 'node:crypto'
import {
  findHuanyuBdUserNameByUserId,
  findHuanyuChannelByName,
  findHuanyuChannelProductByName,
  type HuanyuChannelOption,
  type HuanyuChannelProductOption
} from './db/remoteDictionary.js'

/** 订单同步所需的最小字段，既可用于实时抓单，也可用于历史回填。 */
export interface HuanyuSourceOrder {
  id: number
  sourceOrderNo: string
  customerName: string
  status?: string
  createdAt: Date
  rawJson: Prisma.JsonValue | null
  detailJson?: Prisma.JsonValue | null
  huanyuOrderNo: string | null
}

export interface HuanyuOrderSyncResult {
  ddbh: string
  created: boolean
  channelFound: boolean
  productFound: boolean
  managerFound: boolean
}

/**
 * 常规抓单只补齐空字段，避免覆盖寰宇页面的人工编辑。
 * `repairPatientContactMapping` 仅供一次性历史修复脚本使用：它只替换能确认仍为旧映射的电话字段。
 */
export interface HuanyuOrderSyncOptions {
  repairPatientContactMapping?: boolean
}

type JsonRecord = Record<string, unknown>

const channelCache = new Map<string, HuanyuChannelOption | null>()
const productCache = new Map<string, HuanyuChannelProductOption | null>()
const managerCache = new Map<string, string | null>()

function asRecord(value: Prisma.JsonValue | unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function valueAsText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/** 优先读取上报的扁平字段，再读取泰康原始对象字段。 */
function field(raw: JsonRecord, ...names: string[]): string | null {
  const original = asRecord(raw.taikangRawJson ?? raw.rawJson)
  for (const source of [raw, original]) {
    for (const name of names) {
      const result = valueAsText(source[name])
      if (result) return result
    }
  }
  return null
}

function text(value: string | null, maxLength: number): string | null {
  return value ? value.slice(0, maxLength) : null
}

function phoneLike(value: string | null): boolean {
  if (!value) return false
  return /^[+\d][\d\s-]{5,}$/.test(value)
}

/** 泰康第二联系人电话偶有落在 secEcpName；仅在其形态明确是电话号码时才兜底采用。 */
function secondContactPhone(raw: JsonRecord): string | null {
  const explicitPhone = field(raw, 'secEcpPhone', 'accompanyFamilyMembersMobile')
  if (explicitPhone) return explicitPhone
  const legacyPhoneInName = field(raw, 'secEcpName')
  return phoneLike(legacyPhoneInName) ? legacyPhoneInName : null
}

/** 泰康返回名称与寰宇“证件类型”固定选项统一，未知/无对应项不猜测，归入“其他”。 */
function huanyuDocumentType(value: string | null): string | null {
  if (!value) return null
  const normalized = value.replace(/\s+/g, '')
  const mapped: Record<string, string> = {
    '身份证': '身份证',
    '护照': '护照',
    '军人证': '军人证',
    '儿童身份证': '儿童身份证',
    '港澳居民通行证': '港澳居民通行证',
    '港澳居民来往内地通行证': '港澳居民通行证',
    '台湾居民通行证': '台湾居民通行证',
    '台湾居民往来大陆通行证': '台湾居民通行证',
    '外国人居留证': '外国人居留证',
    '户口本': '其他',
    '其他': '其他'
  }
  return mapped[normalized] ?? '其他'
}

function localDateYmd(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}${part('month')}${part('day')}`
}

/** HYDD + YYYYMMDD + 8 位随机数，共 20 位。 */
function generateDdbh(): string {
  return `HYDD${localDateYmd()}${randomInt(0, 100_000_000).toString().padStart(8, '0')}`
}

function ageFromBirthday(value: string | null): number | null {
  if (!value) return null
  const match = /^(\d{4})[-/]?(\d{1,2})[-/]?(\d{1,2})/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return null
  const nowParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date())
  const current = (type: string) => Number(nowParts.find((item) => item.type === type)?.value)
  let age = current('year') - year
  if (current('month') < month || (current('month') === month && current('day') < day)) age -= 1
  return age >= 0 && age <= 150 ? age : null
}

function productPrice(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Number(value.replace(/,/g, '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

function isCancelledOrder(status: string | null | undefined): boolean {
  return Boolean(status && (status.includes('已取消') || status.includes('无责取消')))
}

async function stableDdbh(prisma: PrismaClient, order: HuanyuSourceOrder): Promise<string> {
  if (order.huanyuOrderNo) return order.huanyuOrderNo

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = generateDdbh()
    try {
      const updated = await prisma.order.updateMany({
        where: { id: order.id, huanyuOrderNo: null },
        data: { huanyuOrderNo: candidate }
      })
      if (updated.count === 1) return candidate

      const current = await prisma.order.findUnique({
        where: { id: order.id },
        select: { huanyuOrderNo: true }
      })
      if (current?.huanyuOrderNo) return current.huanyuOrderNo
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    }
  }
  throw new Error(`无法为订单 ${order.id} 生成唯一的寰宇订单号`)
}

async function channelByName(name: string): Promise<HuanyuChannelOption | null> {
  if (!channelCache.has(name)) channelCache.set(name, await findHuanyuChannelByName(name))
  return channelCache.get(name) ?? null
}

async function productByName(channelId: string, name: string): Promise<HuanyuChannelProductOption | null> {
  const key = `${channelId}\u0000${name}`
  if (!productCache.has(key)) productCache.set(key, await findHuanyuChannelProductByName(channelId, name))
  return productCache.get(key) ?? null
}

async function managerByUserId(userId: string): Promise<string | null> {
  if (!managerCache.has(userId)) managerCache.set(userId, await findHuanyuBdUserNameByUserId(userId))
  return managerCache.get(userId) ?? null
}

function productNames(raw: JsonRecord): string[] {
  const names = [
    field(raw, 'serviceType'),
    field(raw, 'serviceItemName'),
    field(raw, 'serviceName'),
    field(raw, 'itemName')
  ]
  return [...new Set(names.filter((name): name is string => Boolean(name)))]
}

/**
 * 为一笔已入 orders 的泰康订单创建寰宇主订单。
 *
 * 幂等规则：DDBH 写回 orders 后固定不变；HY_FACT_DDCX_NEW 已有同一 DDBH 时绝不覆盖，
 * 因此后续人工在寰宇订单详情页修改的内容不会被下一次抓单覆盖。
 */
export async function syncHuanyuOrderFromTaikang(
  prisma: PrismaClient,
  order: HuanyuSourceOrder,
  taikangAccount?: string | null,
  employeeName?: string | null,
  options: HuanyuOrderSyncOptions = {}
): Promise<HuanyuOrderSyncResult> {
  const ddbh = await stableDdbh(prisma, order)
  const listRaw = asRecord(order.rawJson)
  const detail = asRecord(asRecord(order.detailJson ?? null).recommendations)
  // 详情接口是客户信息的权威来源；同名字段覆盖列表值，未返回的字段再回退列表原始数据。
  const raw: JsonRecord = { ...listRaw, ...detail, taikangRawJson: listRaw.taikangRawJson ?? listRaw.rawJson }
  const isRegister = field(raw, 'poolType') === 'register'
  const channelName = isRegister ? '泰康挂号协助2025' : '泰康集团（2026）'
  const channel = await channelByName(channelName)

  let product: HuanyuChannelProductOption | null = null
  if (channel) {
    for (const name of productNames(raw)) {
      product = await productByName(channel.id, name)
      if (product) break
    }
  }

  const account = taikangAccount?.trim() || field(raw, 'taikangAccount')
  // 首选寰宇 BD 用户字典；泰康账号不在该字典时，回退到订单所属申请员工的姓名。
  // 这是显示名称回填，绝不以模糊匹配猜测其他人的姓名。
  const manager = (account ? await managerByUserId(account) : null) ?? (employeeName?.trim() || null)
  const birthday = field(raw, 'birthday')
  const patientName = field(raw, 'patientName') ?? order.customerName
  // 泰康客户信息页中“联系人手机号”对应 ecpPhone；无该值时才回退患者手机号。
  const patientPhone = field(raw, 'ecpPhone', 'paMobile', 'patientMobile', 'patientPhone')
  // 家属联系电话对应第二联系人电话；历史页面偶发将号码写入第二联系人姓名字段。
  const familyPhone = secondContactPhone(raw)
  // 用于一次性历史修复的旧映射判断。常规抓单不会据此覆盖已有值。
  const legacyPatientPhone = field(raw, 'paMobile', 'patientMobile', 'patientPhone')
  const legacyFamilyPhone = field(raw, 'ecpPhone')
  const repairPatientContactMapping = Boolean(options.repairPatientContactMapping)
  // 取消类订单的金额规则优先级最高，固定写 0；其他订单取维表 CPJG。
  const amount = isCancelledOrder(order.status) ? 0 : productPrice(product?.price)
  const targetExists = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS(SELECT 1 FROM "HY_FACT_DDCX_NEW" WHERE "DDBH" = ${ddbh}) AS "exists"
  `
  await prisma.$executeRaw`
    INSERT INTO "HY_FACT_DDCX_NEW" (
      "DDBH", "DD_state", "BDQD", "BDQD_DDBH", "BDQD_FWXM", "DDJE", "KHJL",
      "JZR_XM", "JZR_ZJLX", "JZR_ZJHM", "JZR_XB", "JZR_NL", "JZR_LXDH",
      "JZR_JSMC", "JZR_JSGX", "JZR_JSLXFS", "JZR_JB", "JZR_BZ",
      "H_NAME", "H_ADDRESS", "H_KS", "H_YS", "DDFWBZ",
      "BBQ_XQ", "DATE_XQ", "YYQDLX", "xtsj_",
      "expectedProvince", "expectedCity", "expectedHospital", "expectedDepartment"
    ) VALUES (
      ${ddbh}, ${'待跟进'}, ${text(channel?.id ?? null, 100)}, ${text(order.sourceOrderNo, 50)}, ${text(product?.id ?? null, 50)}, ${amount}, ${text(manager, 50)},
      ${text(patientName, 50)}, ${huanyuDocumentType(field(raw, 'cardType'))}, ${text(field(raw, 'cardId'), 50)}, ${text(field(raw, 'sex'), 20)}, ${ageFromBirthday(birthday)}, ${text(patientPhone, 18)},
      ${text(field(raw, 'ecpName'), 50)}, ${text(field(raw, 'patEcpRelationship', 'relationship'), 50)}, ${text(familyPhone, 18)}, ${text(field(raw, 'suspectDisease'), 100)}, ${text(field(raw, 'comments', 'comment'), 2000)},
      ${text(field(raw, 'hospital', 'intendHos', 'visitingHospital'), 100)}, ${text(field(raw, 'visitingHospitalDetailAddress'), 500)}, ${text(field(raw, 'dept', 'intendDept'), 50)}, ${text(field(raw, 'doctor', 'intendDoc'), 50)}, ${text(field(raw, 'comments', 'comment'), 2000)},
      ${text(field(raw, 'intendDateAmorpm'), 20)}, ${text(field(raw, 'intendDate'), 20)}, ${'1'}, ${order.createdAt.toISOString()},
      ${text(field(raw, 'intendProvince'), 50)}, ${text(field(raw, 'intendCity'), 50)}, ${text(field(raw, 'intendHos', 'hospital'), 255)}, ${text(field(raw, 'intendDept', 'dept'), 255)}
    ) ON CONFLICT ("DDBH") DO UPDATE
      SET "BDQD_DDBH" = EXCLUDED."BDQD_DDBH",
          "DDJE" = COALESCE("HY_FACT_DDCX_NEW"."DDJE", EXCLUDED."DDJE"),
          "KHJL" = COALESCE("HY_FACT_DDCX_NEW"."KHJL", EXCLUDED."KHJL"),
          "JZR_XM" = CASE
            WHEN ("HY_FACT_DDCX_NEW"."JZR_XM" IS NULL OR "HY_FACT_DDCX_NEW"."JZR_XM" LIKE ${'%*%'})
              AND EXCLUDED."JZR_XM" IS NOT NULL
              AND EXCLUDED."JZR_XM" NOT LIKE ${'%*%'}
              THEN EXCLUDED."JZR_XM"
            ELSE "HY_FACT_DDCX_NEW"."JZR_XM"
          END,
          "JZR_ZJLX" = COALESCE("HY_FACT_DDCX_NEW"."JZR_ZJLX", EXCLUDED."JZR_ZJLX"),
          "JZR_ZJHM" = COALESCE("HY_FACT_DDCX_NEW"."JZR_ZJHM", EXCLUDED."JZR_ZJHM"),
          "JZR_XB" = COALESCE("HY_FACT_DDCX_NEW"."JZR_XB", EXCLUDED."JZR_XB"),
          "JZR_NL" = COALESCE("HY_FACT_DDCX_NEW"."JZR_NL", EXCLUDED."JZR_NL"),
          "JZR_LXDH" = CASE
            WHEN "HY_FACT_DDCX_NEW"."JZR_LXDH" IS NULL THEN EXCLUDED."JZR_LXDH"
            WHEN ${repairPatientContactMapping}
              AND EXCLUDED."JZR_LXDH" IS NOT NULL
              AND "HY_FACT_DDCX_NEW"."JZR_LXDH" IS NOT DISTINCT FROM ${legacyPatientPhone}
              THEN EXCLUDED."JZR_LXDH"
            ELSE "HY_FACT_DDCX_NEW"."JZR_LXDH"
          END,
          "JZR_JSMC" = COALESCE("HY_FACT_DDCX_NEW"."JZR_JSMC", EXCLUDED."JZR_JSMC"),
          "JZR_JSGX" = COALESCE("HY_FACT_DDCX_NEW"."JZR_JSGX", EXCLUDED."JZR_JSGX"),
          "JZR_JSLXFS" = CASE
            WHEN "HY_FACT_DDCX_NEW"."JZR_JSLXFS" IS NULL THEN EXCLUDED."JZR_JSLXFS"
            WHEN ${repairPatientContactMapping}
              AND "HY_FACT_DDCX_NEW"."JZR_JSLXFS" IS NOT DISTINCT FROM ${legacyFamilyPhone}
              THEN EXCLUDED."JZR_JSLXFS"
            ELSE "HY_FACT_DDCX_NEW"."JZR_JSLXFS"
          END,
          "JZR_JB" = COALESCE("HY_FACT_DDCX_NEW"."JZR_JB", EXCLUDED."JZR_JB"),
          "JZR_BZ" = COALESCE("HY_FACT_DDCX_NEW"."JZR_BZ", EXCLUDED."JZR_BZ")
  `

  return {
    ddbh,
    created: !targetExists[0]?.exists,
    channelFound: Boolean(channel),
    productFound: Boolean(product),
    managerFound: Boolean(manager)
  }
}
