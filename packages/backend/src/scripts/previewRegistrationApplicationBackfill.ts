import * as dotenv from 'dotenv'
import { resolve } from 'node:path'
import { createShanghaiPrismaClient } from '../db/shanghaiPrisma.js'
import { closeHuanyuMysqlPushPool } from '../huanyuMysqlPush.js'
import { previewRegistrationApplicationBackfill } from '../services/registrationApplicationBackfill.js'

dotenv.config({ path: resolve(process.cwd(), '.env') })
dotenv.config({ path: resolve(process.cwd(), '../../.env') })

const prisma = createShanghaiPrismaClient()
async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error('此脚本仅支持只读预览，不接受执行参数')
  const items = await previewRegistrationApplicationBackfill(prisma)
  const sources = [...new Set(items.map(item => item.sourceOrderNo).filter(Boolean))]
  const poolResults = sources.length ? await prisma.$queryRaw<Array<{ source_order_no: string; application_no: string | null; source: string | null; status: string }>>`
    SELECT source_order_no,application_no,source,status FROM registration_application_lookup` : []
  const bySource = new Map(poolResults.map(row => [row.source_order_no, row]))
  const resolved = items.map(item => {
    const pool = bySource.get(item.sourceOrderNo)
    if (item.state === 'missing' && pool?.status === 'conflict') return { ...item, state: 'conflict' as const, applicationNo: null, source: 'conflict', lookupStatus: pool.status }
    if (item.state === 'missing' && pool?.status === 'matched' && pool.application_no) return { ...item, state: 'matched' as const, applicationNo: pool.application_no, source: pool.source ?? '', lookupStatus: pool.status }
    return { ...item, source: item.state === 'matched' ? 'orders' : '', lookupStatus: pool?.status ?? 'not_prepared' }
  })
  console.log(JSON.stringify({ total: resolved.length, matched: resolved.filter(item => item.state === 'matched').length,
    missing: resolved.filter(item => item.state === 'missing').length, conflict: resolved.filter(item => item.state === 'conflict').length,
    invalid: resolved.filter(item => item.state === 'invalid').length, items: resolved }, null, 2))
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}).finally(async () => {
  await prisma.$disconnect()
  await closeHuanyuMysqlPushPool()
})
