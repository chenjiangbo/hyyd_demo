import * as dotenv from 'dotenv'
import { Prisma, PrismaClient } from '@prisma/client'
import { syncHuanyuOrderFromTaikang } from '../huanyuOrderSync.js'

// 仅用于一次性修复：将泰康详情中的联系人/第二联系人电话按寰宇字段规则重新映射。
// 同步函数会严格比对旧映射后才更新，因此不会覆盖已在寰宇页面人工修改过的电话。
dotenv.config({ path: `${process.cwd()}/.env`, override: true })
dotenv.config({ path: `${process.cwd()}/../../.env`, override: true })

const prisma = new PrismaClient()

async function main() {
  const orders = await prisma.order.findMany({
    where: { source: 'taikang', detailJson: { not: Prisma.DbNull }, huanyuOrderNo: { not: null } },
    orderBy: { id: 'asc' },
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
    const group = orders.slice(index, index + 10)
    await Promise.all(group.map(async (order) => {
      await syncHuanyuOrderFromTaikang(
        prisma,
        order,
        order.assignedEmployee?.taikangAccount,
        order.assignedEmployee?.name,
        { repairPatientContactMapping: true }
      )
      processed += 1
    }))
  }

  console.log(JSON.stringify({ processed }))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
