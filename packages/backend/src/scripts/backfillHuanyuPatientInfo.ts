import * as dotenv from 'dotenv'
import { Prisma, PrismaClient } from '@prisma/client'
import { syncHuanyuOrderFromTaikang } from '../huanyuOrderSync.js'

// 兼容从仓库根目录直接执行，以及由 packages/backend 的 npm script 执行两种方式。
dotenv.config({ path: `${process.cwd()}/.env`, override: true })
dotenv.config({ path: `${process.cwd()}/../../.env`, override: true })

const prisma = new PrismaClient()

async function main() {
  const requestedBatchSize = Number(process.env.HUANYU_PATIENT_BACKFILL_BATCH_SIZE ?? 100)
  const batchSize = Number.isInteger(requestedBatchSize)
    ? Math.min(Math.max(requestedBatchSize, 1), 300)
    : 100
  // 以证件类型为空作为“尚未完成详情客户信息初始化”的标识。泰康详情均有 cardType，
  // 因此每次运行都会推进到下一批，不会重复扫描已经完成的订单。
  const pending = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT o.id
      FROM "orders" AS o
      LEFT JOIN "HY_FACT_DDCX_NEW" AS h ON h."DDBH" = o."huanyu_order_no"
     WHERE o."source" = ${'taikang'}
       AND o."detail_json" IS NOT NULL
       AND (h."DDBH" IS NULL OR h."JZR_ZJLX" IS NULL)
     ORDER BY o.id
     LIMIT ${batchSize}
  `
  const orders = await prisma.order.findMany({
    where: { id: { in: pending.map((row) => row.id) }, detailJson: { not: Prisma.DbNull } },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      sourceOrderNo: true,
      customerName: true,
      createdAt: true,
      rawJson: true,
      detailJson: true,
      huanyuOrderNo: true,
      assignedEmployee: { select: { name: true } }
    }
  })

  let processed = 0
  // 并发受限于 10，减少历史初始化时对订单与渠道字典查询造成的瞬时压力。
  for (let index = 0; index < orders.length; index += 10) {
    const group = orders.slice(index, index + 10)
    await Promise.all(group.map(async (order) => {
      await syncHuanyuOrderFromTaikang(
        prisma,
        order,
        order.assignedEmployee?.name
      )
      processed += 1
    }))
  }
  console.log(JSON.stringify({ batchSize, processed }))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
