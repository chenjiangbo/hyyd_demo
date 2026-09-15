import type { PrismaClient } from '@prisma/client'

/**
 * 订单跟进提醒与通知中心表结构自动检测与创建（幂等）。
 */
const CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS order_reminders (
    id SERIAL PRIMARY KEY,
    order_no VARCHAR(64) NOT NULL,
    employee_id INTEGER NOT NULL,
    type VARCHAR(32) NOT NULL DEFAULT 'manual',
    content TEXT NOT NULL DEFAULT '',
    remind_time TIMESTAMPTZ(3) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    extra_data JSONB,
    created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE INDEX IF NOT EXISTS idx_order_reminders_emp_status_time 
   ON order_reminders (employee_id, status, remind_time);`,
  `CREATE INDEX IF NOT EXISTS idx_order_reminders_order_no 
   ON order_reminders (order_no);`
]

export async function ensureReminderTables(prisma: PrismaClient, logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string, err?: unknown) => void }): Promise<void> {
  for (const sql of CREATE_STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql)
    } catch (err) {
      logger?.error('创建/校验 order_reminders 提醒表失败:', err)
      throw err
    }
  }
  logger?.info('提醒通知表 (order_reminders) 结构校验完成')
}
