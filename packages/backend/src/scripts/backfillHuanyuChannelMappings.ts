import * as dotenv from 'dotenv'
import { Prisma, PrismaClient } from '@prisma/client'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import {
  findHuanyuChannelById,
  findHuanyuChannelProductById,
  findHuanyuChannelProductByName,
  type HuanyuChannelOption,
  type HuanyuChannelProductOption
} from '../db/remoteDictionary.js'
import { ensureTaikangHuanyuChannelMappingTable } from '../db/ensureTaikangHuanyuChannelMappingTable.js'
import {
  findTaikangHuanyuChannelMapping,
  taikangBusinessKeyOf,
  type TaikangBusinessKey
} from '../taikangHuanyuChannelMapping.js'

// 兼容 Linux 服务器从仓库根目录执行，以及从 packages/backend 执行两种方式。
dotenv.config({ path: resolve(process.cwd(), '.env'), override: false })
dotenv.config({ path: resolve(process.cwd(), '../../.env'), override: false })

const prisma = new PrismaClient()
const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const force = args.has('--force')
const confirmed = args.has('--confirm=UPDATE_HUANYU_CHANNELS')

type JsonRecord = Record<string, unknown>
type HistoryRow = {
  order_id: number
  source_order_no: string
  huanyu_order_no: string
  raw_json: Prisma.JsonValue | null
  detail_json: Prisma.JsonValue | null
  current_channel_id: string | null
  current_product_id: string | null
}

type Candidate = {
  orderId: number
  sourceOrderNo: string
  huanyuOrderNo: string
  businessKey: TaikangBusinessKey
  currentChannelId: string | null
  currentProductId: string | null
  expectedChannel: HuanyuChannelOption
  expectedProduct: HuanyuChannelProductOption
  reason: string
}

type Unresolved = {
  orderId: number
  sourceOrderNo: string
  huanyuOrderNo: string
  businessKey: TaikangBusinessKey
  reason: string
}

function asRecord(value: Prisma.JsonValue | unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function valueAsText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/** 与创建寰宇订单保持相同的字段优先级：详情 recommendations 覆盖列表快照。 */
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

function productNames(raw: JsonRecord): string[] {
  return [...new Set([
    field(raw, 'serviceType'),
    field(raw, 'serviceItemName'),
    field(raw, 'serviceName'),
    field(raw, 'itemName')
  ].filter((name): name is string => Boolean(name)))]
}

function timestampTag(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_')
}

function backupTableName(): string {
  // 仅由程序生成，符合 PostgreSQL 标识符安全字符集。
  return `hy_channel_mapping_backup_${timestampTag()}`
}

async function isCurrentPairValid(
  currentChannelId: string | null,
  currentProductId: string | null,
  cache: Map<string, Promise<HuanyuChannelOption | null | HuanyuChannelProductOption>>
): Promise<boolean> {
  if (!currentChannelId || !currentProductId) return false
  const channelKey = `channel:${currentChannelId}`
  const productKey = `product:${currentProductId}`
  if (!cache.has(channelKey)) cache.set(channelKey, findHuanyuChannelById(currentChannelId))
  if (!cache.has(productKey)) cache.set(productKey, findHuanyuChannelProductById(currentProductId))
  const [channel, product] = await Promise.all([cache.get(channelKey)!, cache.get(productKey)!])
  return Boolean(
    channel && product &&
    String(product.id).slice(0, 4) === String(channel.id).slice(0, 4)
  )
}

async function main(): Promise<void> {
  if (apply && !confirmed) {
    throw new Error('实际写入必须同时传入 --apply --confirm=UPDATE_HUANYU_CHANNELS；仅预览请使用 --dry-run（或不传参数）')
  }
  if (!apply && args.has('--confirm=UPDATE_HUANYU_CHANNELS')) {
    throw new Error('--confirm 只能与 --apply 同时使用')
  }

  await ensureTaikangHuanyuChannelMappingTable(prisma)

  const rows = await prisma.$queryRaw<HistoryRow[]>`
    SELECT o.id AS order_id,
           o.source_order_no,
           o.huanyu_order_no,
           o.raw_json,
           o.detail_json,
           h."BDQD" AS current_channel_id,
           h."BDQD_FWXM" AS current_product_id
      FROM orders AS o
      JOIN "HY_FACT_DDCX_NEW" AS h ON h."DDBH" = o.huanyu_order_no
     WHERE o.source = ${'taikang'}
       AND o.huanyu_order_no IS NOT NULL
     ORDER BY o.id
  `

  const mappingByBusiness = new Map<TaikangBusinessKey, Awaited<ReturnType<typeof findTaikangHuanyuChannelMapping>>>()
  const channelByBusiness = new Map<TaikangBusinessKey, HuanyuChannelOption>()
  const requiredBusinessKeys = new Set<TaikangBusinessKey>()
  for (const row of rows) {
    const detail = asRecord(asRecord(row.detail_json).recommendations)
    const raw = { ...asRecord(row.raw_json), ...detail }
    requiredBusinessKeys.add(taikangBusinessKeyOf(field(raw, 'poolType')))
  }
  for (const businessKey of requiredBusinessKeys) {
    const mapping = await findTaikangHuanyuChannelMapping(prisma, businessKey)
    mappingByBusiness.set(businessKey, mapping)
    if (!mapping?.huanyuChannelId) {
      if (apply) throw new Error(`“${businessKey}”未配置或已停用 B端渠道，请先在管理后台完成配置`)
      continue
    }
    const channel = await findHuanyuChannelById(mapping.huanyuChannelId)
    if (!channel) {
      if (apply) throw new Error(`“${businessKey}”配置的渠道 ${mapping.huanyuChannelId} 已不在远端 dim_hy_qd 中`)
      continue
    }
    channelByBusiness.set(businessKey, channel)
  }

  const candidates: Candidate[] = []
  const unresolved: Unresolved[] = []
  let unchanged = 0
  const validityCache = new Map<string, Promise<HuanyuChannelOption | null | HuanyuChannelProductOption>>()

  for (const row of rows) {
    const detail = asRecord(asRecord(row.detail_json).recommendations)
    const raw = { ...asRecord(row.raw_json), ...detail, taikangRawJson: asRecord(row.raw_json).taikangRawJson ?? asRecord(row.raw_json).rawJson }
    const businessKey = taikangBusinessKeyOf(field(raw, 'poolType'))
    const expectedChannel = channelByBusiness.get(businessKey)
    if (!expectedChannel) {
      unresolved.push({ orderId: row.order_id, sourceOrderNo: row.source_order_no, huanyuOrderNo: row.huanyu_order_no, businessKey, reason: '后台未配置有效 B端渠道' })
      continue
    }

    let expectedProduct: HuanyuChannelProductOption | null = null
    const names = productNames(raw)
    for (const name of names) {
      expectedProduct = await findHuanyuChannelProductByName(expectedChannel.id, name)
      if (expectedProduct) break
    }
    if (!expectedProduct) {
      unresolved.push({
        orderId: row.order_id,
        sourceOrderNo: row.source_order_no,
        huanyuOrderNo: row.huanyu_order_no,
        businessKey,
        reason: names.length > 0 ? `目标渠道下未匹配服务项目：${names.join(' / ')}` : '泰康订单缺少服务项目名称'
      })
      continue
    }

    if (row.current_channel_id === expectedChannel.id && row.current_product_id === expectedProduct.id) {
      unchanged += 1
      continue
    }
    const currentValid = await isCurrentPairValid(row.current_channel_id, row.current_product_id, validityCache)
    if (currentValid && !force) {
      unchanged += 1
      continue
    }
    candidates.push({
      orderId: row.order_id,
      sourceOrderNo: row.source_order_no,
      huanyuOrderNo: row.huanyu_order_no,
      businessKey,
      currentChannelId: row.current_channel_id,
      currentProductId: row.current_product_id,
      expectedChannel,
      expectedProduct,
      reason: currentValid ? '强制替换现有有效渠道/服务项目' : '当前渠道或服务项目为空、旧名称或无效码值'
    })
  }

  let backupTable: string | null = null
  let updated = 0
  if (apply && candidates.length > 0) {
    backupTable = backupTableName()
    const backupIdentifier = Prisma.raw(`"${backupTable}"`)
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        CREATE TABLE ${backupIdentifier} AS
        SELECT h."DDBH", h."BDQD", h."BDQD_FWXM", now() AS backed_up_at
          FROM "HY_FACT_DDCX_NEW" AS h
         WHERE h."DDBH" IN (${Prisma.join(candidates.map((candidate) => candidate.huanyuOrderNo))})
      `
      for (const candidate of candidates) {
        const count = await tx.$executeRaw`
          UPDATE "HY_FACT_DDCX_NEW"
             SET "BDQD" = ${candidate.expectedChannel.id},
                 "BDQD_FWXM" = ${candidate.expectedProduct.id}
           WHERE "DDBH" = ${candidate.huanyuOrderNo}
        `
        updated += Number(count)
      }
    })
  }

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    force,
    totalHistoryOrders: rows.length,
    candidateCount: candidates.length,
    updated,
    unchanged,
    unresolvedCount: unresolved.length,
    backupTable,
    candidates,
    unresolved
  }
  const reportPath = resolve(process.cwd(), `huanyu-channel-mapping-backfill-${timestampTag()}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({
    ...report,
    candidates: candidates.slice(0, 20),
    unresolved: unresolved.slice(0, 20),
    reportPath,
    note: '控制台仅展示前 20 条候选和未匹配项，完整结果见 reportPath。不会推送 MySQL、不会修改金额或订单步骤。'
  }, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
