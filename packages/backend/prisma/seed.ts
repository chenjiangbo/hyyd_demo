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
      name: '寰宇测试员工',
      phone: '13800138000',
      wechatId: 'wechat_test_emp1',
      taikangAccount: 'tk_account_emp1',
      token: 'huanyu_test_token_123'
    }
  })
  console.log(`已创建员工: ${employee.name} (Token: ${employee.token})`)

  console.log('注入初始候选及已分配订单...')
  
  // 1. 泰康挂号单 (候选)
  await prisma.order.create({
    data: {
      source: 'taikang',
      sourceOrderNo: 'TK202605260001',
      customerName: '张三',
      customerPhone: '18888888888',
      hospital: '北京协和医院',
      dept: '心内科',
      doctor: '张教授',
      status: '候选',
      rawJson: {
        remark: '患者最近胸闷，需要挂心内科专家号',
        insuranceLevel: '泰康私钻高客'
      }
    }
  })

  // 2. 泰康绿通单 (候选)
  await prisma.order.create({
    data: {
      source: 'taikang',
      sourceOrderNo: 'TK202605260002',
      customerName: '李四',
      customerPhone: '17777777777',
      hospital: '北京大学第一医院',
      dept: '肾脏内科',
      doctor: null,
      status: '候选',
      rawJson: {
        remark: '需要入院接送以及住院安排',
        servicesRequested: ['入院接送', '住院协调']
      }
    }
  })

  // 3. 已经由本测试员工申领的订单 (已申领)
  await prisma.order.create({
    data: {
      source: 'taikang',
      sourceOrderNo: 'TK202605260003',
      customerName: '王五',
      customerPhone: '16666666666',
      hospital: '北京同仁医院',
      dept: '眼科',
      doctor: '魏主任',
      status: '已申领',
      assignedEmployeeId: employee.id,
      rawJson: {
        remark: '患者视力模糊，需要专家门诊',
        insuranceLevel: '泰康私钻高客'
      }
    }
  })

  // 4. 平安挂号单 (候选)
  await prisma.order.create({
    data: {
      source: 'pingan',
      sourceOrderNo: 'PA202605269999',
      customerName: '赵六',
      customerPhone: '15555555555',
      hospital: '上海华山医院',
      dept: '皮肤科',
      doctor: '项教授',
      status: '候选',
      rawJson: {
        remark: '面部湿疹严重',
        insuranceLevel: '黄金VIP'
      }
    }
  })

  console.log('数据注入完成!')
}

main()
  .catch((e) => {
    console.error('种子数据注入出错:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
