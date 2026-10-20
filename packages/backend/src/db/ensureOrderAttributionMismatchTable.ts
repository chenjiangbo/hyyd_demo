import type { PrismaClient } from '@prisma/client'

/** 后端启动时幂等创建泰康个人池归属不一致记录表。 */
export async function ensureOrderAttributionMismatchTable(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS order_attribution_mismatches (
      id SERIAL PRIMARY KEY,
      source_order_no TEXT NOT NULL,
      stored_employee_id INTEGER NOT NULL,
      observed_employee_id INTEGER NOT NULL,
      observed_taikang_account TEXT NOT NULL,
      observed_taikang_user_id INTEGER NOT NULL,
      batch_id TEXT NOT NULL,
      observed_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS order_attribution_mismatches_batch_id_source_order_no_key
    ON order_attribution_mismatches (batch_id, source_order_no);
  `)
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS order_attribution_mismatches_observed_at_idx
    ON order_attribution_mismatches (observed_at DESC);
  `)
}
