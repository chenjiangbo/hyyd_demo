import type { PrismaClient } from '@prisma/client'

/**
 * 订单跟进提醒与通知中心表结构自动检测与创建（幂等）。
 */
const CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS order_reminders (
    id SERIAL PRIMARY KEY,
    order_no VARCHAR(64),
    huanyu_order_no VARCHAR(64),
    employee_id INTEGER NOT NULL,
    type VARCHAR(32) NOT NULL DEFAULT 'manual',
    content TEXT NOT NULL DEFAULT '',
    remind_time TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    extra_data JSONB,
    created_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE INDEX IF NOT EXISTS idx_order_reminders_emp_status_time 
   ON order_reminders (employee_id, status, remind_time);`,
  `CREATE INDEX IF NOT EXISTS idx_order_reminders_order_no 
   ON order_reminders (order_no);`,
  `ALTER TABLE order_reminders ALTER COLUMN order_no DROP NOT NULL;`,
  `ALTER TABLE order_reminders ADD COLUMN IF NOT EXISTS huanyu_order_no VARCHAR(64);`,
  `ALTER TABLE order_reminders ADD COLUMN IF NOT EXISTS notification_generation INTEGER NOT NULL DEFAULT 1;`,
  `CREATE INDEX IF NOT EXISTS idx_order_reminders_huanyu_order_no
   ON order_reminders (huanyu_order_no);`,
  `CREATE TABLE IF NOT EXISTS order_reminder_popup_dismissals (
    employee_id INTEGER NOT NULL,
    reminder_id INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    dismissed_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (employee_id, reminder_id, generation)
  );`,
  `CREATE INDEX IF NOT EXISTS idx_order_reminder_popup_dismissals_reminder
   ON order_reminder_popup_dismissals (reminder_id);`,
  `WITH ranked_active AS (
     SELECT id, ROW_NUMBER() OVER (PARTITION BY extra_data->>'dedupe_key' ORDER BY id DESC) AS rn
       FROM order_reminders
      WHERE status IN ('pending', 'unread')
        AND extra_data->>'dedupe_key' IS NOT NULL
   )
   UPDATE order_reminders r SET status = 'superseded', updated_at = NOW()
    FROM ranked_active d WHERE d.id = r.id AND d.rn > 1;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_order_reminders_active_dedupe
   ON order_reminders ((extra_data->>'dedupe_key'))
   WHERE status IN ('pending', 'unread') AND extra_data->>'dedupe_key' IS NOT NULL;`
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
