import * as dotenv from 'dotenv'
import { Prisma, PrismaClient } from '@prisma/client'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ensureHuanyuTables } from '../db/ensureHuanyuTables.js'
import { findHuanyuChannelProductById, type HuanyuChannelProductOption } from '../db/remoteDictionary.js'

// 支持 Linux 服务器从仓库根目录执行，也支持从 packages/backend 目录执行。
dotenv.config({ path: resolve(process.cwd(), '.env'), override: false })
dotenv.config({ path: resolve(process.cwd(), '../../.env'), override: false })

const prisma = new PrismaClient()
const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const force = args.has('--force')
const confirmed = args.has('--confirm=REPAIR_HUANYU_ORDER_AMOUNTS')

type HistoryRow = {
  order_id: number
  source_order_no: string
  huanyu_order_no: string
  order_status: string | null
  service_project_id: string
  current_amount: Prisma.Decimal | null
}

type Candidate = {
  orderId: number
  sourceOrderNo: string
  huanyuOrderNo: string
  serviceProjectId: string
  serviceProjectName: string
  currentAmount: string | null
  targetAmount: number
  reason: string
}

type Skipped = {
  orderId: number
  sourceOrderNo: string
  huanyuOrderNo: string
  serviceProjectId: string
  currentAmount: string | null
  reason: string
}

function timestampTag(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_')
}

function backupTableName(): string {
  // 表名完全由程序生成，符合 PostgreSQL 标识符规则。
  return `hy_order_amount_backup_${timestampTag()}`
}

function isCancelledOrder(status: string | null): boolean {
  return Boolean(status && (status.includes('已取消') || status.includes('无责取消')))
}

function numericPrice(value: string): number | null {
  const price = Number(value.replace(/,/g, '').trim())
  return Number.isFinite(price) ? price : null
}

function equalAmount(current: Prisma.Decimal | null, target: number): boolean {
  return current !== null && Number(current.toString()) === target
}

async function main(): Promise<void> {
  if (apply && !confirmed) {
    throw new Error('实际写入必须同时传入 --apply --confirm=REPAIR_HUANYU_ORDER_AMOUNTS；仅预演请不传参数或传 --dry-run')
  }
  if (!apply && confirmed) {
    throw new Error('--confirm 只能与 --apply 同时使用')
  }

  await ensureHuanyuTables(prisma)

  // 仅处理已有关联订单、且 B端渠道服务项目（BDQD_FWXM）有值的泰康订单。
  const rows = await prisma.$queryRaw<HistoryRow[]>`
    SELECT o.id AS order_id,
           o.source_order_no,
           o.huanyu_order_no,
           o.status AS order_status,
           BTRIM(h."BDQD_FWXM") AS service_project_id,
           h."DDJE" AS current_amount
      FROM orders AS o
      JOIN "HY_FACT_DDCX_NEW" AS h ON h."DDBH" = o.huanyu_order_no
     WHERE o.source = ${'taikang'}
       AND o.huanyu_order_no IS NOT NULL
       AND NULLIF(BTRIM(h."BDQD_FWXM"), '') IS NOT NULL
     ORDER BY o.id
  `

  const productCache = new Map<string, Promise<HuanyuChannelProductOption | null>>()
  const productOf = async (id: string): Promise<HuanyuChannelProductOption | null> => {
    if (!productCache.has(id)) productCache.set(id, findHuanyuChannelProductById(id))
    return productCache.get(id) ?? null
  }

  const candidates: Candidate[] = []
  const alreadyFilled: Skipped[] = []
  const unresolved: Skipped[] = []
  const unchanged: Skipped[] = []
  for (const row of rows) {
    const currentAmount = row.current_amount?.toString() ?? null
    let targetAmount: number | null = null
    let serviceProjectName = ''
    let reason = ''

    // 与实时初始化保持一致：取消订单金额始终为 0，优先于服务项目价格。
    if (isCancelledOrder(row.order_status)) {
      targetAmount = 0
      reason = '泰康订单已取消/无责取消，金额固定为 0'
    } else {
      const product = await productOf(row.service_project_id)
      if (!product) {
        unresolved.push({
          orderId: row.order_id,
          sourceOrderNo: row.source_order_no,
          huanyuOrderNo: row.huanyu_order_no,
          serviceProjectId: row.service_project_id,
          currentAmount,
          reason: '远端 dim_hy_qd_cp 未找到该 B端渠道服务项目，未修改金额'
        })
        continue
      }
      serviceProjectName = product.name
      targetAmount = numericPrice(product.price)
      if (targetAmount === null) {
        unresolved.push({
          orderId: row.order_id,
          sourceOrderNo: row.source_order_no,
          huanyuOrderNo: row.huanyu_order_no,
          serviceProjectId: row.service_project_id,
          currentAmount,
          reason: 'B端渠道服务项目的 CPJG 为空或不是有效数字，未修改金额'
        })
        continue
      }
      reason = '按当前 B端渠道服务项目的 CPJG 回填订单金额'
    }

    if (equalAmount(row.current_amount, targetAmount)) {
      unchanged.push({
        orderId: row.order_id,
        sourceOrderNo: row.source_order_no,
        huanyuOrderNo: row.huanyu_order_no,
        serviceProjectId: row.service_project_id,
        currentAmount,
        reason: '当前订单金额已与目标价格一致'
      })
      continue
    }
    if (row.current_amount !== null && !force) {
      alreadyFilled.push({
        orderId: row.order_id,
        sourceOrderNo: row.source_order_no,
        huanyuOrderNo: row.huanyu_order_no,
        serviceProjectId: row.service_project_id,
        currentAmount,
        reason: '订单金额已有值，默认保护；如确认需按 CPJG 覆盖，请使用 --force'
      })
      continue
    }
    candidates.push({
      orderId: row.order_id,
      sourceOrderNo: row.source_order_no,
      huanyuOrderNo: row.huanyu_order_no,
      serviceProjectId: row.service_project_id,
      serviceProjectName,
      currentAmount,
      targetAmount,
      reason
    })
  }

  let backupTable: string | null = null
  let updated = 0
  if (apply && candidates.length > 0) {
    backupTable = backupTableName()
    const backupIdentifier = Prisma.raw(`"${backupTable}"`)
    await prisma.$transaction(async (tx) => {
      // 只备份这次变动的金额和服务项目码值，便于精确恢复；不包含客户信息。
      await tx.$executeRaw`
        CREATE TABLE ${backupIdentifier} AS
        SELECT h."DDBH", h."BDQD_FWXM", h."DDJE", now() AS backed_up_at
          FROM "HY_FACT_DDCX_NEW" AS h
         WHERE h."DDBH" IN (${Prisma.join(candidates.map((candidate) => candidate.huanyuOrderNo))})
      `
      for (const candidate of candidates) {
        const count = await tx.$executeRaw`
          UPDATE "HY_FACT_DDCX_NEW"
             SET "DDJE" = ${candidate.targetAmount}
           WHERE "DDBH" = ${candidate.huanyuOrderNo}
        `
        updated += Number(count)
      }
    })
  }

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    force,
    scope: '仅 orders.source=taikang 且 HY_FACT_DDCX_NEW.BDQD_FWXM 非空的订单',
    fieldRule: 'HY_FACT_DDCX_NEW.DDJE = dim_hy_qd_cp.CPJG（按 BDQD_FWXM 精确查询）',
    totalWithServiceProject: rows.length,
    candidateCount: candidates.length,
    alreadyFilledCount: alreadyFilled.length,
    unchangedCount: unchanged.length,
    unresolvedCount: unresolved.length,
    updated,
    backupTable,
    candidates,
    alreadyFilled,
    unchanged,
    unresolved
  }
  const reportPath = resolve(process.cwd(), `huanyu-order-amount-backfill-${timestampTag()}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({
    ...report,
    candidates: candidates.slice(0, 20),
    alreadyFilled: alreadyFilled.slice(0, 20),
    unchanged: unchanged.slice(0, 20),
    unresolved: unresolved.slice(0, 20),
    reportPath,
    note: '控制台仅展示各类前 20 条；完整结果见 reportPath。本脚本只更新本地 PostgreSQL，不会推送 MySQL，也不会修改渠道、备用订单号或订单步骤。'
  }, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
