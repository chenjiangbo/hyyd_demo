import * as dotenv from 'dotenv'
import { Prisma, PrismaClient } from '@prisma/client'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ensureHuanyuTables } from '../db/ensureHuanyuTables.js'

// 支持 Linux 服务器从仓库根目录执行，也支持从 packages/backend 目录执行。
dotenv.config({ path: resolve(process.cwd(), '.env'), override: false })
dotenv.config({ path: resolve(process.cwd(), '../../.env'), override: false })

const prisma = new PrismaClient()
const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const confirmed = args.has('--confirm=FILL_HUANYU_BACKUP_ORDER_NOS')

type HistoryRow = {
  order_id: number
  source_order_no: string
  huanyu_order_no: string
  application_no: string | null
  current_backup_order_no: string | null
}

type Candidate = {
  orderId: number
  sourceOrderNo: string
  huanyuOrderNo: string
  applicationNo: string
}

type Skipped = {
  orderId: number
  sourceOrderNo: string
  huanyuOrderNo: string
  currentBackupOrderNo: string | null
  reason: string
}

function timestampTag(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_')
}

function backupTableName(): string {
  // 表名完全由本程序生成，符合 PostgreSQL 标识符规则。
  return `hy_backup_order_no_${timestampTag()}`
}

async function main(): Promise<void> {
  if (apply && !confirmed) {
    throw new Error('实际写入必须同时传入 --apply --confirm=FILL_HUANYU_BACKUP_ORDER_NOS；仅预演请不传参数或传 --dry-run')
  }
  if (!apply && confirmed) {
    throw new Error('--confirm 只能与 --apply 同时使用')
  }

  await ensureHuanyuTables(prisma)

  // crmApplyNo 是当前系统认定的泰康“申请号”：消息、通话和 AI 均以它关联订单。
  // 兼容旧数据：优先扁平字段，再读取保留的泰康原始对象；不使用另一个 applyNo 字段。
  const rows = await prisma.$queryRaw<HistoryRow[]>`
    SELECT o.id AS order_id,
           o.source_order_no,
           o.huanyu_order_no,
           COALESCE(
             NULLIF(BTRIM(o.raw_json->>'crmApplyNo'), ''),
             NULLIF(BTRIM(o.raw_json->'taikangRawJson'->>'crmApplyNo'), '')
           ) AS application_no,
           h."BDQD_DDBH2" AS current_backup_order_no
      FROM orders AS o
      JOIN "HY_FACT_DDCX_NEW" AS h ON h."DDBH" = o.huanyu_order_no
     WHERE o.source = ${'taikang'}
       AND o.huanyu_order_no IS NOT NULL
     ORDER BY o.id
  `

  const candidates: Candidate[] = []
  const alreadyFilled: Skipped[] = []
  const missingApplicationNo: Skipped[] = []
  for (const row of rows) {
    const current = row.current_backup_order_no?.trim() || null
    if (current) {
      alreadyFilled.push({
        orderId: row.order_id,
        sourceOrderNo: row.source_order_no,
        huanyuOrderNo: row.huanyu_order_no,
        currentBackupOrderNo: current,
        reason: '备用订单号已有值，保留人工或历史数据'
      })
      continue
    }
    const applicationNo = row.application_no?.trim() || null
    if (!applicationNo) {
      missingApplicationNo.push({
        orderId: row.order_id,
        sourceOrderNo: row.source_order_no,
        huanyuOrderNo: row.huanyu_order_no,
        currentBackupOrderNo: null,
        reason: '泰康订单缺少 crmApplyNo，按规则不猜测、不写入'
      })
      continue
    }
    candidates.push({
      orderId: row.order_id,
      sourceOrderNo: row.source_order_no,
      huanyuOrderNo: row.huanyu_order_no,
      applicationNo
    })
  }

  let backupTable: string | null = null
  let updated = 0
  if (apply && candidates.length > 0) {
    backupTable = backupTableName()
    const backupIdentifier = Prisma.raw(`"${backupTable}"`)
    await prisma.$transaction(async (tx) => {
      // 只备份本次将要改动的字段，便于精确回滚；不包含客户信息。
      await tx.$executeRaw`
        CREATE TABLE ${backupIdentifier} AS
        SELECT h."DDBH", h."BDQD_DDBH2", now() AS backed_up_at
          FROM "HY_FACT_DDCX_NEW" AS h
         WHERE h."DDBH" IN (${Prisma.join(candidates.map((candidate) => candidate.huanyuOrderNo))})
      `
      updated = Number(await tx.$executeRaw`
        UPDATE "HY_FACT_DDCX_NEW" AS h
           SET "BDQD_DDBH2" = COALESCE(
             NULLIF(BTRIM(o.raw_json->>'crmApplyNo'), ''),
             NULLIF(BTRIM(o.raw_json->'taikangRawJson'->>'crmApplyNo'), '')
           )
          FROM orders AS o
         WHERE h."DDBH" = o.huanyu_order_no
           AND o.source = ${'taikang'}
           AND NULLIF(BTRIM(h."BDQD_DDBH2"), '') IS NULL
           AND COALESCE(
             NULLIF(BTRIM(o.raw_json->>'crmApplyNo'), ''),
             NULLIF(BTRIM(o.raw_json->'taikangRawJson'->>'crmApplyNo'), '')
           ) IS NOT NULL
      `)
    })
  }

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    source: 'taikang',
    fieldRule: 'HY_FACT_DDCX_NEW.BDQD_DDBH2 = orders.raw_json.crmApplyNo',
    totalLinkedHuanyuOrders: rows.length,
    candidateCount: candidates.length,
    alreadyFilledCount: alreadyFilled.length,
    missingApplicationNoCount: missingApplicationNo.length,
    updated,
    backupTable,
    candidates,
    alreadyFilled,
    missingApplicationNo
  }
  const reportPath = resolve(process.cwd(), `huanyu-backup-order-no-backfill-${timestampTag()}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({
    ...report,
    candidates: candidates.slice(0, 20),
    alreadyFilled: alreadyFilled.slice(0, 20),
    missingApplicationNo: missingApplicationNo.slice(0, 20),
    reportPath,
    note: '控制台仅展示各类前 20 条；完整结果见 reportPath。本脚本只更新本地 PostgreSQL，不会推送 MySQL，也不会修改订单步骤、渠道、金额。'
  }, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
