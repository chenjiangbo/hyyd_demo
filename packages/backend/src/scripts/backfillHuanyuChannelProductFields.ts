import * as dotenv from 'dotenv'
import { PrismaClient } from '@prisma/client'
import { syncHuanyuOrderFromTaikang } from '../huanyuOrderSync.js'

dotenv.config({ path: `${process.cwd()}/.env`, override: true })
dotenv.config({ path: `${process.cwd()}/../../.env`, override: true })

const prisma = new PrismaClient()

async function main() {
  const requestedBatchSize = Number(process.env.HUANYU_PRODUCT_BACKFILL_BATCH_SIZE ?? 200)
  const batchSize = Number.isInteger(requestedBatchSize)
    ? Math.min(Math.max(requestedBatchSize, 1), 300)
    : 200
  // 仅处理已经精确匹配到 B 端渠道服务项目、但尚未带出金额的订单。
  const pending = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT o.id
      FROM "orders" AS o
      JOIN "HY_FACT_DDCX_NEW" AS h ON h."DDBH" = o."huanyu_order_no"
     WHERE o."source" = ${'taikang'}
       AND h."BDQD_FWXM" IS NOT NULL
       AND h."DDJE" IS NULL
     ORDER BY o.id
     LIMIT ${batchSize}
  `
  const orders = await prisma.order.findMany({
    where: { id: { in: pending.map((row) => row.id) } },
    select: {
      id: true,
      sourceOrderNo: true,
      customerName: true,
      status: true,
      createdAt: true,
      rawJson: true,
      detailJson: true,
      huanyuOrderNo: true,
      assignedEmployee: { select: { taikangAccount: true, name: true } }
    }
  })

  let processed = 0
  for (let index = 0; index < orders.length; index += 10) {
    await Promise.all(orders.slice(index, index + 10).map(async (order) => {
      await syncHuanyuOrderFromTaikang(
        prisma,
        order,
        order.assignedEmployee?.taikangAccount,
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
