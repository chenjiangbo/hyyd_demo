import * as dotenv from 'dotenv'
import { PrismaClient } from '@prisma/client'
import { resolve } from 'node:path'
import { syncHuanyuOrderFromTaikang } from '../huanyuOrderSync.js'
import { ensureHuanyuTables } from '../db/ensureHuanyuTables.js'

// 兼容从仓库根目录直接执行，以及由 packages/backend 的 npm script 执行两种方式。
dotenv.config({ path: resolve(process.cwd(), '.env'), override: false })
dotenv.config({ path: resolve(process.cwd(), '../../.env'), override: false })

const prisma = new PrismaClient()

async function main() {
  await ensureHuanyuTables(prisma)
  // 泰康子订单号是寰宇渠道订单编号（BDQD_DDBH）。历史回填仅更新这一项映射，
  // 不重置人工维护的订单字段。
  const channelOrderNoUpdated = await prisma.$executeRaw`
    UPDATE "HY_FACT_DDCX_NEW" AS h
       SET "BDQD_DDBH" = o."source_order_no"
      FROM "orders" AS o
     WHERE h."DDBH" = o."huanyu_order_no"
       AND o."source" = ${'taikang'}
       AND h."BDQD_DDBH" IS DISTINCT FROM o."source_order_no"
  `
  // 历史订单中，优先用订单所属申请员工的显示姓名补齐当前为空的客户经理；
  // 不改写已有值，也不触碰其他寰宇订单字段。
  const managerUpdated = await prisma.$executeRaw`
    UPDATE "HY_FACT_DDCX_NEW" AS h
       SET "KHJL" = e."name"
      FROM "orders" AS o
      JOIN "employees" AS e ON e."id" = o."assigned_employee_id"
     WHERE h."DDBH" = o."huanyu_order_no"
       AND o."source" = ${'taikang'}
       AND h."KHJL" IS NULL
       AND BTRIM(e."name") <> ''
  `
  await prisma.$executeRaw`
    UPDATE "HY_FACT_DDCX_NEW"
       SET "KHJL" = '唐晓艳'
     WHERE "KHJL" = 'tangxy'
  `
  const requestedBatchSize = Number(process.env.HUANYU_BACKFILL_BATCH_SIZE ?? 300)
  const batchSize = Number.isInteger(requestedBatchSize)
    ? Math.min(Math.max(requestedBatchSize, 1), 1000)
    : 300
  // 只挑还没有对应主表数据的订单：不反复扫描已完成的历史订单，且会补上
  // "已有 huanyu_order_no、但上次写主表中断" 的极少数情况。
  const missing = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT o.id
      FROM "orders" AS o
      LEFT JOIN "HY_FACT_DDCX_NEW" AS h ON h."DDBH" = o."huanyu_order_no"
     WHERE o."source" = ${'taikang'}
       AND h."DDBH" IS NULL
     ORDER BY o.id
     LIMIT ${batchSize}
  `
  const orders = await prisma.order.findMany({
    where: { id: { in: missing.map((row) => row.id) } },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      sourceOrderNo: true,
      customerName: true,
      createdAt: true,
      rawJson: true,
      huanyuOrderNo: true,
      assignedEmployee: { select: { taikangAccount: true, name: true } }
    }
  })

  let created = 0
  let alreadyPresent = 0
  let channelMissing = 0
  let productMissing = 0
  let managerMissing = 0
  for (const order of orders) {
    const result = await syncHuanyuOrderFromTaikang(
      prisma,
      order,
      order.assignedEmployee?.taikangAccount,
      order.assignedEmployee?.name
    )
    if (result.created) created += 1
    else alreadyPresent += 1
    if (!result.channelFound) channelMissing += 1
    if (!result.productFound) productMissing += 1
    if (!result.managerFound) managerMissing += 1
  }

  console.log(JSON.stringify({
    batchSize,
    channelOrderNoUpdated,
    managerUpdated,
    processed: orders.length,
    created,
    alreadyPresent,
    channelMissing,
    productMissing,
    managerMissing
  }))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
