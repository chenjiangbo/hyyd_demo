import { Prisma, type PrismaClient } from '@prisma/client'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { getHuanyuWriterPool } from '../huanyuMysqlPush.js'
import { shanghaiDateKey } from '../time/shanghaiTime.js'

const DAY_STATE = '全程门诊服务中'
type RemoteRow = { source: string; id: string; created: string; status: string }
type Task = { source_order_no: string; huanyu_order_no: string; created_key: string; lease_id: string }

export function creationKey(value: unknown): string | null {
  const v = String(value ?? '').trim()
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(v) ?? /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(v)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== mo || date.getUTCDate() !== d || date.getUTCHours() !== h || date.getUTCMinutes() !== mi || date.getUTCSeconds() !== s) return null
  return m.slice(1).join('')
}

/** 首诊必须在所有关联记录中唯一且可确定，不能先按状态过滤。 */
export function selectFirstOutpatient(rows: RemoteRow[]): RemoteRow | null {
  if (!rows.length || rows.some(r => !r.id || !creationKey(r.created))) return null
  const ordered = [...rows].sort((a, b) => creationKey(a.created)!.localeCompare(creationKey(b.created)!))
  if (ordered.length > 1 && creationKey(ordered[0].created) === creationKey(ordered[1].created)) return null
  return ordered[0].status === DAY_STATE ? ordered[0] : null
}

export const completionTableSql = [
  `CREATE TABLE IF NOT EXISTS outpatient_completion_runs (run_day DATE PRIMARY KEY, status VARCHAR(16) NOT NULL, lease_id VARCHAR(80), lease_until TIMESTAMP(3) WITHOUT TIME ZONE, updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS outpatient_completion_tasks (run_day DATE NOT NULL, source_order_no VARCHAR(100) NOT NULL, huanyu_order_no VARCHAR(100) NOT NULL, created_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL, state VARCHAR(20) NOT NULL DEFAULT 'pending', lease_account VARCHAR(100), lease_id VARCHAR(80), lease_until TIMESTAMP(3) WITHOUT TIME ZONE, updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (run_day, source_order_no))`,
  `CREATE TABLE IF NOT EXISTS outpatient_completion_attempts (run_day DATE NOT NULL, source_order_no VARCHAR(100) NOT NULL, account VARCHAR(100) NOT NULL, result VARCHAR(20) NOT NULL, remote_state VARCHAR(40), remote_state_name VARCHAR(100), sync_result VARCHAR(20), retry_after TIMESTAMP(3) WITHOUT TIME ZONE, updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (run_day, source_order_no, account))`,
  `CREATE TABLE IF NOT EXISTS outpatient_completion_preferred (source_order_no VARCHAR(100) PRIMARY KEY, account VARCHAR(100) NOT NULL, updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP)`
]
export async function ensureOutpatientCompletionTables(prisma: PrismaClient): Promise<void> {
  for (const sql of completionTableSql) await prisma.$executeRawUnsafe(sql)
}

/** 每天北京时间 5 点切换清单日期，5 点前继续上一轮。 */
export function completionRunDay(now = new Date()): string {
  return shanghaiDateKey(new Date(now.getTime() - 5 * 60 * 60 * 1000))
}

async function readCandidates(): Promise<RemoteRow[]> {
  const connection = await getHuanyuWriterPool().getConnection()
  try {
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT TRIM(h.BDQD_DDBH) AS source, h.DDBH AS id, h.xtsj_ AS created, h.DD_state AS status
      FROM HY_FACT_DDCX_NEW h JOIN (SELECT DISTINCT BDQD_DDBH FROM HY_FACT_DDCX_NEW
        WHERE DD_state = ? AND BDQD_DDBH IS NOT NULL AND TRIM(BDQD_DDBH) <> '') candidate ON h.BDQD_DDBH = candidate.BDQD_DDBH`, [DAY_STATE])
    const result: RemoteRow[] = []
    const bySource = new Map<string, RemoteRow[]>()
    for (const r of rows) {
      const row = { source: String(r.source ?? '').trim(), id: String(r.id ?? '').trim(), created: String(r.created ?? '').trim(), status: String(r.status ?? '').trim() }
      if (!row.source || row.source.length > 100) continue
      const group = bySource.get(row.source) ?? []; group.push(row); bySource.set(row.source, group)
    }
    for (const group of bySource.values()) { const first = selectFirstOutpatient(group); if (first && first.id.length <= 100) result.push(first) }
    return result
  } finally { connection.release() }
}

export async function generateDailyOutpatientList(prisma: PrismaClient, now = new Date(), getCandidates = readCandidates): Promise<boolean> {
  const day = completionRunDay(now)
  const owner = randomUUID()
  const acquired = await prisma.$queryRawUnsafe<Array<{ run_day: Date }>>(`INSERT INTO outpatient_completion_runs (run_day,status,lease_id,lease_until) VALUES ($1::date,'running',$2,CURRENT_TIMESTAMP + INTERVAL '10 minutes') ON CONFLICT (run_day) DO UPDATE SET status='running',lease_id=$2,lease_until=CURRENT_TIMESTAMP + INTERVAL '10 minutes',updated_at=CURRENT_TIMESTAMP WHERE outpatient_completion_runs.status <> 'ready' AND (outpatient_completion_runs.lease_until IS NULL OR outpatient_completion_runs.lease_until < CURRENT_TIMESTAMP) RETURNING run_day`, day, owner)
  if (!acquired.length) return false
  const heartbeat = setInterval(() => { void prisma.$executeRawUnsafe(`UPDATE outpatient_completion_runs SET lease_until=CURRENT_TIMESTAMP + INTERVAL '10 minutes',updated_at=CURRENT_TIMESTAMP WHERE run_day=$1::date AND lease_id=$2 AND status='running'`, day, owner).catch(() => {}) }, 60_000)
  heartbeat.unref()
  try {
    const candidates = await getCandidates()
    await prisma.$transaction(async tx => {
      const owned = await tx.$queryRawUnsafe<Array<{ lease_id: string }>>(`SELECT lease_id FROM outpatient_completion_runs WHERE run_day=$1::date AND lease_id=$2 AND status='running' FOR UPDATE`, day, owner)
      if (!owned.length) throw new Error('待查清单生成任务已失效')
      for (let i = 0; i < candidates.length; i += 500) {
        const tuples = candidates.slice(i, i + 500).map(row => {
          const key = creationKey(row.created)!
          const created = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)} ${key.slice(8, 10)}:${key.slice(10, 12)}:${key.slice(12, 14)}`
          return Prisma.sql`(${day}::date,${row.source},${row.id},${created}::timestamp)`
        })
        await tx.$executeRaw(Prisma.sql`INSERT INTO outpatient_completion_tasks (run_day,source_order_no,huanyu_order_no,created_at) VALUES ${Prisma.join(tuples)} ON CONFLICT (run_day,source_order_no) DO NOTHING`)
      }
      await tx.$executeRawUnsafe(`UPDATE outpatient_completion_runs SET status='ready',lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE run_day=$1::date AND lease_id=$2`, day, owner)
    }, { timeout: 120_000 })
    return true
  } catch (error) {
    await prisma.$executeRawUnsafe(`UPDATE outpatient_completion_runs SET status='error',lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE run_day=$1::date AND lease_id=$2`, day, owner).catch(() => {})
    throw error
  } finally { clearInterval(heartbeat) }
}

export function startOutpatientCompletionSchedule(prisma: PrismaClient, log: { error: (obj: unknown, message?: string) => void }): () => void {
  let running = false
  let retryAt = 0
  const tick = () => {
    if (running || Date.now() < retryAt) return
    running = true
    void generateDailyOutpatientList(prisma).then(() => { retryAt = 0 }).catch(e => {
      retryAt = Date.now() + 5 * 60_000
      log.error(e, '生成全程门诊待查清单失败')
    }).finally(() => { running = false })
  }
  tick()
  const timer = setInterval(tick, 60_000); timer.unref()
  return () => clearInterval(timer)
}

/** 一次仅租用一笔，保证中断后可恢复；优先在线的已知账号。 */
export async function leaseOutpatientTask(prisma: PrismaClient, account: string, onlineAccounts: string[]): Promise<Task | null> {
  const day = completionRunDay()
  const leaseId = randomUUID()
  const rows = await prisma.$queryRawUnsafe<Task[]>(`WITH candidate AS (
    SELECT t.run_day,t.source_order_no FROM outpatient_completion_tasks t
      JOIN outpatient_completion_runs r ON r.run_day=t.run_day AND r.status='ready'
      LEFT JOIN outpatient_completion_attempts a ON a.run_day=t.run_day AND a.source_order_no=t.source_order_no AND a.account=$2
      LEFT JOIN outpatient_completion_preferred p ON p.source_order_no=t.source_order_no
     WHERE t.run_day=$1::date AND t.state='pending' AND (t.lease_until IS NULL OR t.lease_until < CURRENT_TIMESTAMP)
       AND (a.account IS NULL OR (a.result='error' AND a.retry_after <= CURRENT_TIMESTAMP))
       AND (p.account IS NULL OR p.account=$2 OR NOT (p.account = ANY($3::text[])) OR EXISTS (
         SELECT 1 FROM outpatient_completion_attempts preferred_attempt WHERE preferred_attempt.run_day=t.run_day
         AND preferred_attempt.source_order_no=t.source_order_no AND preferred_attempt.account=p.account
         AND preferred_attempt.result IN ('not_found','error')
       ) OR (r.updated_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes' AND NOT EXISTS (
         SELECT 1 FROM outpatient_completion_attempts recent WHERE recent.run_day=t.run_day AND recent.account=p.account
         AND recent.updated_at >= CURRENT_TIMESTAMP - INTERVAL '15 minutes'
       ) AND NOT EXISTS (
         SELECT 1 FROM outpatient_completion_tasks in_progress WHERE in_progress.run_day=t.run_day
         AND in_progress.lease_account=p.account AND in_progress.lease_until >= CURRENT_TIMESTAMP
       )))
     ORDER BY CASE WHEN p.account=$2 THEN 0 ELSE 1 END,t.source_order_no
     FOR UPDATE OF t SKIP LOCKED LIMIT 1
  ) UPDATE outpatient_completion_tasks t SET lease_account=$2,lease_id=$4,lease_until=CURRENT_TIMESTAMP + INTERVAL '15 minutes',updated_at=CURRENT_TIMESTAMP
    FROM candidate c WHERE t.run_day=c.run_day AND t.source_order_no=c.source_order_no
    RETURNING t.source_order_no,t.huanyu_order_no,to_char(t.created_at,'YYYYMMDDHH24MISS') AS created_key,t.lease_id`, day, account, onlineAccounts, leaseId)
  return rows[0] ?? null
}

export async function completeRemoteFirstOrder(source: string, expectedId: string, expectedCreated: string, supplied?: PoolConnection): Promise<'updated' | 'changed'> {
  const connection = supplied ?? await getHuanyuWriterPool().getConnection()
  try {
    const [tables] = await connection.query<RowDataPacket[]>("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'HY_FACT_DDCX_NEW'")
    if (String(tables[0]?.ENGINE ?? '').toLowerCase() !== 'innodb') throw new Error('ABI 订单表不支持所需的事务保护')
    // 防止检查首诊后，同一 B 端订单号又插入更早的记录。
    await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
    await connection.beginTransaction()
    const [records] = await connection.execute<RowDataPacket[]>('SELECT TRIM(BDQD_DDBH) AS source,DDBH AS id,xtsj_ AS created,DD_state AS status FROM HY_FACT_DDCX_NEW WHERE BDQD_DDBH = ? FOR UPDATE', [source])
    const rows = records.map(r => ({ source: String(r.source ?? '').trim(), id: String(r.id ?? '').trim(), created: String(r.created ?? '').trim(), status: String(r.status ?? '').trim() }))
    const first = selectFirstOutpatient(rows)
    if (!first || first.id !== expectedId || creationKey(first.created) !== expectedCreated) { await connection.rollback(); return 'changed' }
    const [result] = await connection.execute('UPDATE HY_FACT_DDCX_NEW SET DD_state = ? WHERE DDBH = ? AND BDQD_DDBH = ? AND DD_state = ? AND xtsj_ = ?', ['已完成', expectedId, source, DAY_STATE, first.created])
    if (!('affectedRows' in result) || result.affectedRows !== 1) { await connection.rollback(); return 'changed' }
    await connection.commit()
    return 'updated'
  } catch (e) { await connection.rollback().catch(() => {}); throw e } finally { if (!supplied) connection.release() }
}

export async function recordOutpatientResult(prisma: PrismaClient, account: string, input: { sourceOrderNo: string; leaseId: string; outcome: 'found' | 'not_found' | 'error'; state?: string; stateName?: string }, complete = completeRemoteFirstOrder): Promise<void> {
  const day = completionRunDay()
  if (input.outcome === 'found' && (!input.state || !input.stateName)) throw new Error('泰康订单状态不完整')
  await prisma.$transaction(async tx => {
    const tasks = await tx.$queryRawUnsafe<Task[]>(`SELECT source_order_no,huanyu_order_no,to_char(created_at,'YYYYMMDDHH24MISS') AS created_key,lease_id FROM outpatient_completion_tasks WHERE run_day=$1::date AND source_order_no=$2 AND lease_account=$3 AND lease_id=$4 AND lease_until >= CURRENT_TIMESTAMP AND state='pending' FOR UPDATE`, day, input.sourceOrderNo, account, input.leaseId)
    const task = tasks[0]
    if (!task) throw new Error('订单查询任务已过期')
    // 只有编码与名称都明确表示完成，才允许写远程订单。
    const syncResult = input.outcome === 'found' && input.state === '2007' && input.stateName === '已完成'
      ? await complete(task.source_order_no, task.huanyu_order_no, task.created_key) : null
    if (input.outcome === 'found') await tx.$executeRawUnsafe(`INSERT INTO outpatient_completion_preferred (source_order_no,account) VALUES ($1,$2) ON CONFLICT (source_order_no) DO UPDATE SET account=EXCLUDED.account,updated_at=CURRENT_TIMESTAMP`, input.sourceOrderNo, account)
    await tx.$executeRawUnsafe(`INSERT INTO outpatient_completion_attempts (run_day,source_order_no,account,result,remote_state,remote_state_name,sync_result,retry_after) VALUES ($1::date,$2,$3,$4,$5,$6,$7,CASE WHEN $4='error' THEN CURRENT_TIMESTAMP + INTERVAL '30 minutes' ELSE NULL END) ON CONFLICT (run_day,source_order_no,account) DO UPDATE SET result=EXCLUDED.result,remote_state=EXCLUDED.remote_state,remote_state_name=EXCLUDED.remote_state_name,sync_result=EXCLUDED.sync_result,retry_after=EXCLUDED.retry_after,updated_at=CURRENT_TIMESTAMP`, day, input.sourceOrderNo, account, input.outcome, input.state ?? null, input.stateName ?? null, syncResult)
    await tx.$executeRawUnsafe(`UPDATE outpatient_completion_tasks SET state=CASE WHEN $5='found' THEN 'observed' ELSE 'pending' END,lease_account=NULL,lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE run_day=$1::date AND source_order_no=$2 AND lease_account=$3 AND lease_id=$4`, day, input.sourceOrderNo, account, input.leaseId, input.outcome)
  }, { timeout: 45_000 })
}
