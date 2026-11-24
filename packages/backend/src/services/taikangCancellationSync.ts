import type { PrismaClient } from '@prisma/client'
import { cancelTaikangRemoteOrders } from './taikangCancellationRemote.js'

export async function ensureTaikangCancellationTable(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS taikang_cancellation_sync (
    source_order_no VARCHAR(50) PRIMARY KEY,
    state VARCHAR(16) NOT NULL DEFAULT 'pending',
    last_error TEXT,
    updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP(3) WITHOUT TIME ZONE
  )`)
}

export async function syncTaikangCancellation(prisma: PrismaClient, source: string, cancelRemote = cancelTaikangRemoteOrders): Promise<'success' | 'skipped' | 'failed'> {
  try {
    return await prisma.$transaction(async tx => {
      await tx.$executeRaw`INSERT INTO taikang_cancellation_sync (source_order_no) VALUES (${source}) ON CONFLICT DO NOTHING`
      const rows = await tx.$queryRaw<Array<{ state: string }>>`SELECT state FROM taikang_cancellation_sync WHERE source_order_no=${source} FOR UPDATE`
      if (rows[0]?.state === 'completed') return 'skipped'
      try {
        await cancelRemote(source)
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : '同步失败'
        await tx.$executeRaw`UPDATE taikang_cancellation_sync SET state='pending',last_error=${message},updated_at=CURRENT_TIMESTAMP WHERE source_order_no=${source}`
        return 'failed'
      }
      await tx.$executeRaw`UPDATE taikang_cancellation_sync SET state='completed',last_error=NULL,updated_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP WHERE source_order_no=${source}`
      return 'success'
    }, { timeout: 45000 })
  } catch { return 'failed' }
}
