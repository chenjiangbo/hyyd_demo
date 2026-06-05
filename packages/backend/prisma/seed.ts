import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('开始清除旧数据...')
  await prisma.aiSummary.deleteMany()
  await prisma.message.deleteMany()
  await prisma.call.deleteMany()
  await prisma.command.deleteMany()
  await prisma.order.deleteMany()
  await prisma.employee.deleteMany()

  console.log('注入测试员工...')
  const employee = await prisma.employee.create({
    data: {
      name: 'huanyu-field-1',
      phone: '13800138000',
      wechatId: 'wechat_test_emp1',
      taikangAccount: 'tk_account_emp1',
      token: 'huanyu-field-1'
    }
  })
  console.log(`已创建员工: ${employee.name} (EmployeeCode: ${employee.token})`)

  // 订单数据全部来自 Chrome 插件实时采集泰康追踪池，不再 seed 假数据
  console.log('数据注入完成!')
  void employee
}

main()
  .catch((e) => {
    console.error('种子数据注入出错:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
