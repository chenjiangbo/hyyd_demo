import type { PrismaClient } from '@prisma/client'

/**
 * 系统通用设置表 (sys_settings) 结构自动检测与默认数据初始化（幂等）。
 */
const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS sys_settings (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`

const INIT_ORDER_AI_SCHEDULE_SQL = `
  INSERT INTO sys_settings (key, value, updated_at)
  VALUES (
    'order_ai_schedule',
    '{"enabled": true, "startTime": "09:00", "endTime": "21:00", "intervalMinutes": 30}'::jsonb,
    NOW()
  )
  ON CONFLICT (key) DO NOTHING;
`

export async function ensureSysSettingsTable(
  prisma: PrismaClient,
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string, err?: unknown) => void }
): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(CREATE_TABLE_SQL)
    await prisma.$executeRawUnsafe(INIT_ORDER_AI_SCHEDULE_SQL)
    logger?.info('系统设置表 (sys_settings) 结构与默认值校验完成')
  } catch (err) {
    logger?.error('创建/校验 sys_settings 系统设置表失败:', err)
    throw err
  }
}
