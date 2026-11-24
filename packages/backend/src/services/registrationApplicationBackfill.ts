import type { PrismaClient } from '@prisma/client'
import type { RowDataPacket, ResultSetHeader, PoolConnection } from 'mysql2/promise'
import { getHuanyuWriterPool } from '../huanyuMysqlPush.js'
import { findTaikangHuanyuChannelMapping } from '../taikangHuanyuChannelMapping.js'
import { randomUUID } from 'node:crypto'

type ObjectValue = Record<string, unknown>
const record = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

/** 仅使用 crmApplyNo，冲突时不自动选取。 */
export function registrationApplicationNumbers(raw: unknown, detail: unknown): string[] {
  const list = record(raw), original = record(list.taikangRawJson), recommendations = record(record(detail).recommendations)
  return [...new Set([list.crmApplyNo, original.crmApplyNo, recommendations.crmApplyNo].map(clean).filter(Boolean))]
}

export type RegistrationApplicationCandidate = {
  orderNo: string
  sourceOrderNo: string
  applicationNo: string | null
  state: 'matched' | 'missing' | 'conflict' | 'invalid'
}

export async function ensureRegistrationApplicationTables(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS registration_application_lookup (
    source_order_no VARCHAR(50) PRIMARY KEY, run_day DATE, status VARCHAR(20) NOT NULL DEFAULT 'pending', application_no VARCHAR(50),
    source VARCHAR(20), last_error TEXT, lease_account VARCHAR(100), lease_id VARCHAR(36), lease_until TIMESTAMP(3) WITHOUT TIME ZONE,
    updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
  await prisma.$executeRawUnsafe('ALTER TABLE registration_application_lookup ADD COLUMN IF NOT EXISTS last_error TEXT')
  await prisma.$executeRawUnsafe('ALTER TABLE registration_application_lookup ADD COLUMN IF NOT EXISTS run_day DATE')
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS registration_application_lookup_attempts (
    source_order_no VARCHAR(50) NOT NULL, account VARCHAR(100) NOT NULL, outcome VARCHAR(20) NOT NULL, error_message TEXT,
    updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (source_order_no,account))`)
  await prisma.$executeRawUnsafe('ALTER TABLE registration_application_lookup_attempts ADD COLUMN IF NOT EXISTS error_message TEXT')
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS registration_application_runs (
    run_hour TIMESTAMP(0) WITHOUT TIME ZONE PRIMARY KEY, status VARCHAR(20) NOT NULL, version INTEGER NOT NULL DEFAULT 2, lease_id VARCHAR(36),
    lease_until TIMESTAMP(3) WITHOUT TIME ZONE, updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
  await prisma.$executeRawUnsafe('ALTER TABLE registration_application_runs ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1')
}

export async function leaseRegistrationApplication(prisma: PrismaClient, account: string, onlineAccounts: string[] = []): Promise<{ source_order_no: string; lease_id: string } | null> {
  const lease = randomUUID()
  const rows = await prisma.$queryRaw<Array<{ source_order_no: string; lease_id: string }>>`
    WITH candidate AS (
      SELECT t.source_order_no FROM registration_application_lookup t
      JOIN registration_application_runs r ON r.run_hour=t.run_day::timestamp AND r.status='ready' AND r.version=2
      LEFT JOIN registration_application_lookup_attempts a ON a.source_order_no=t.source_order_no AND a.account=${account}
      LEFT JOIN orders o ON o.source='taikang' AND o.source_order_no=t.source_order_no
      LEFT JOIN employees e ON e.id=o.assigned_employee_id
      LEFT JOIN registration_application_lookup_attempts preferred ON preferred.source_order_no=t.source_order_no AND preferred.account=e.taikang_account
      WHERE t.status='pending' AND t.run_day=(CURRENT_TIMESTAMP::timestamp - INTERVAL '5 hours')::date AND (t.lease_until IS NULL OR t.lease_until < CURRENT_TIMESTAMP)
        AND (a.account IS NULL OR a.updated_at < date_trunc('day', CURRENT_TIMESTAMP::timestamp - INTERVAL '5 hours') + INTERVAL '5 hours' OR (a.outcome='error' AND a.updated_at < CURRENT_TIMESTAMP - INTERVAL '10 minutes'))
        AND (e.taikang_account IS NULL OR e.taikang_account=${account} OR NOT (e.taikang_account = ANY(${onlineAccounts}::text[]))
          OR (preferred.outcome IN ('not_found','error') AND preferred.updated_at >= date_trunc('day', CURRENT_TIMESTAMP::timestamp - INTERVAL '5 hours') + INTERVAL '5 hours')
          OR t.updated_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes')
      ORDER BY CASE WHEN e.taikang_account=${account} THEN 0 ELSE 1 END,t.source_order_no FOR UPDATE OF t SKIP LOCKED LIMIT 1
    )
    UPDATE registration_application_lookup t SET lease_account=${account},lease_id=${lease},
      lease_until=CURRENT_TIMESTAMP + INTERVAL '15 minutes',updated_at=CURRENT_TIMESTAMP
    FROM candidate c WHERE t.source_order_no=c.source_order_no RETURNING t.source_order_no,t.lease_id`
  return rows[0] ?? null
}

/** 区分当天清单尚未就绪、仍有可能接力的任务和当前账号当天已查完。 */
export async function registrationApplicationAvailability(prisma: PrismaClient, account: string): Promise<'waiting' | 'retry' | 'done'> {
  const rows = await prisma.$queryRaw<Array<{ ready: boolean; pending: boolean }>>`
    SELECT
      EXISTS (SELECT 1 FROM registration_application_runs r WHERE r.run_hour=date_trunc('day',CURRENT_TIMESTAMP::timestamp - INTERVAL '5 hours') AND r.status='ready' AND r.version=2) AS ready,
      EXISTS (SELECT 1 FROM registration_application_lookup t
        LEFT JOIN registration_application_lookup_attempts a ON a.source_order_no=t.source_order_no AND a.account=${account}
        WHERE t.status='pending' AND t.run_day=(CURRENT_TIMESTAMP::timestamp - INTERVAL '5 hours')::date
          AND (a.account IS NULL OR a.updated_at < date_trunc('day',CURRENT_TIMESTAMP::timestamp - INTERVAL '5 hours') + INTERVAL '5 hours' OR a.outcome='error')) AS pending`
  return !rows[0]?.ready ? 'waiting' : rows[0].pending ? 'retry' : 'done'
}

export async function recordRegistrationApplication(prisma: PrismaClient, account: string, result: { sourceOrderNo: string; leaseId: string; status: 'found' | 'not_found' | 'conflict' | 'error'; applicationNo?: string; source?: 'personal' | 'tracking'; errorMessage?: string }): Promise<void> {
  if (result.status === 'found' && (!result.applicationNo?.trim() || result.applicationNo.trim().length > 50 || !['personal', 'tracking'].includes(result.source ?? ''))) throw new Error('挂号协助申请号结果无效')
  await prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ source_order_no: string }>>`SELECT source_order_no FROM registration_application_lookup
      WHERE source_order_no=${result.sourceOrderNo} AND lease_account=${account} AND lease_id=${result.leaseId} AND lease_until >= CURRENT_TIMESTAMP AND status='pending'
        AND run_day=(CURRENT_TIMESTAMP::timestamp - INTERVAL '5 hours')::date FOR UPDATE`
    if (rows.length !== 1) throw new Error('挂号协助查询任务已过期')
    await tx.$executeRaw`INSERT INTO registration_application_lookup_attempts (source_order_no,account,outcome,error_message) VALUES (${result.sourceOrderNo},${account},${result.status},${result.status === 'error' ? result.errorMessage?.slice(0, 500) ?? null : null})
      ON CONFLICT (source_order_no,account) DO UPDATE SET outcome=EXCLUDED.outcome,error_message=EXCLUDED.error_message,updated_at=CURRENT_TIMESTAMP`
    await tx.$executeRaw`UPDATE registration_application_lookup SET status=${result.status === 'found' ? 'matched' : result.status === 'conflict' ? 'conflict' : 'pending'},
      application_no=${result.applicationNo?.trim() || null},source=${result.source || null},lease_account=NULL,lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE source_order_no=${result.sourceOrderNo}`
  })
  if (result.status === 'found') {
    try { await applyRegistrationSource(prisma, result.sourceOrderNo) }
    catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'ABI 更新失败'
      await prisma.$executeRaw`UPDATE registration_application_lookup SET last_error=${message},updated_at=CURRENT_TIMESTAMP WHERE source_order_no=${result.sourceOrderNo}`
    }
  }
}

/** 仅在订单号、渠道和原空值均未变化时补写，保留已由其他人填写的值。 */
export async function fillRegistrationApplication(candidate: RegistrationApplicationCandidate, channelId: string, supplied?: PoolConnection): Promise<'updated' | 'changed'> {
  const applicationNo = candidate.applicationNo?.trim() ?? ''
  if (candidate.state !== 'matched' || !candidate.orderNo || !candidate.sourceOrderNo || !channelId || !applicationNo || applicationNo.length > 50) throw new Error('申请号候选数据无效')
  const connection = supplied ?? await getHuanyuWriterPool().getConnection()
  try {
    const [result] = await connection.execute<ResultSetHeader>(
      "UPDATE HY_FACT_DDCX_NEW SET BDQD_DDBH2 = ? WHERE BINARY DDBH = BINARY ? AND BINARY BDQD_DDBH = BINARY ? AND BDQD = ? AND (BDQD_DDBH2 IS NULL OR TRIM(BDQD_DDBH2) = '')",
      [applicationNo, candidate.orderNo, candidate.sourceOrderNo, channelId]
    )
    return result.affectedRows === 1 ? 'updated' : 'changed'
  } finally { if (!supplied) connection.release() }
}

/** 只读预览；只扫描当前启用的挂号协助渠道，不修改远端订单。 */
export async function previewRegistrationApplicationBackfill(prisma: PrismaClient, sourceFilter?: string): Promise<RegistrationApplicationCandidate[]> {
  const mapping = await findTaikangHuanyuChannelMapping(prisma, 'register_assist')
  if (!mapping?.huanyuChannelId) throw new Error('泰康挂号协助渠道未配置或未启用')
  const connection = await getHuanyuWriterPool().getConnection()
  try {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT DDBH, BDQD_DDBH FROM HY_FACT_DDCX_NEW WHERE BDQD = ? AND (BDQD_DDBH2 IS NULL OR TRIM(BDQD_DDBH2) = '')${sourceFilter ? ' AND BINARY BDQD_DDBH = BINARY ?' : ''} ORDER BY DDBH`,
      sourceFilter ? [mapping.huanyuChannelId, sourceFilter] : [mapping.huanyuChannelId]
    )
    const ids = [...new Set(rows.map(row => clean(row.BDQD_DDBH)).filter(Boolean))]
    const orders = await prisma.order.findMany({ where: { source: 'taikang', sourceOrderNo: { in: ids } }, select: { sourceOrderNo: true, rawJson: true, detailJson: true } })
    const bySource = new Map(orders.map(order => [order.sourceOrderNo, order]))
    return rows.map(row => {
      const orderNo = clean(row.DDBH), sourceOrderNo = clean(row.BDQD_DDBH)
      if (!orderNo || !sourceOrderNo) return { orderNo, sourceOrderNo, applicationNo: null, state: 'invalid' as const }
      const order = bySource.get(sourceOrderNo)
      const values = order ? registrationApplicationNumbers(order.rawJson, order.detailJson) : []
      if (values.length > 1) return { orderNo, sourceOrderNo, applicationNo: null, state: 'conflict' as const }
      if (values[0] && values[0].length <= 50) return { orderNo, sourceOrderNo, applicationNo: values[0], state: 'matched' as const }
      return { orderNo, sourceOrderNo, applicationNo: null, state: values.length ? 'invalid' as const : 'missing' as const }
    })
  } finally { connection.release() }
}

/** 每次重新读取 ABI 和本地订单，避免覆盖后续人工修改或使用过期快照。 */
export async function applyRegistrationSource(prisma: PrismaClient, sourceOrderNo: string, snapshot?: RegistrationApplicationCandidate[]): Promise<number> {
  const mapping = await findTaikangHuanyuChannelMapping(prisma, 'register_assist')
  if (!mapping?.huanyuChannelId) throw new Error('泰康挂号协助渠道未配置或未启用')
  const items = (snapshot ?? await previewRegistrationApplicationBackfill(prisma, sourceOrderNo)).filter(item => item.sourceOrderNo === sourceOrderNo)
  const lookup = await prisma.$queryRaw<Array<{ status: string; application_no: string | null }>>`SELECT status,application_no FROM registration_application_lookup WHERE source_order_no=${sourceOrderNo}`
  const pool = lookup[0]
  let updated = 0
  for (const item of items) {
    if (item.state === 'invalid' || item.state === 'conflict') continue
    const applicationNo = item.applicationNo || (pool?.status === 'matched' ? pool.application_no : null)
    if (!applicationNo) continue
    if (await fillRegistrationApplication({ ...item, applicationNo, state: 'matched' }, mapping.huanyuChannelId) === 'updated') updated++
  }
  return updated
}

/** 北京时间每天 5 点切换一轮，允许实例故障后接管；只为本地无法匹配的订单创建池查询任务。 */
export async function runDailyRegistrationBackfill(prisma: PrismaClient, deps: { preview: typeof previewRegistrationApplicationBackfill; apply: typeof applyRegistrationSource } = { preview: previewRegistrationApplicationBackfill, apply: applyRegistrationSource }): Promise<boolean> {
  const lease = randomUUID()
  const rows = await prisma.$queryRaw<Array<{ run_hour: Date }>>`
    INSERT INTO registration_application_runs (run_hour,status,version,lease_id,lease_until)
    VALUES (date_trunc('day',CURRENT_TIMESTAMP::timestamp - INTERVAL '5 hours'),'running',2,${lease},CURRENT_TIMESTAMP + INTERVAL '10 minutes')
    ON CONFLICT (run_hour) DO UPDATE SET status='running',version=2,lease_id=EXCLUDED.lease_id,lease_until=EXCLUDED.lease_until,updated_at=CURRENT_TIMESTAMP
    WHERE (registration_application_runs.status <> 'ready' OR registration_application_runs.version < 2) AND (registration_application_runs.lease_until IS NULL OR registration_application_runs.lease_until < CURRENT_TIMESTAMP)
    RETURNING run_hour`
  if (!rows.length) return false
  const heartbeat = setInterval(() => { void prisma.$executeRaw`UPDATE registration_application_runs SET lease_until=CURRENT_TIMESTAMP + INTERVAL '10 minutes',updated_at=CURRENT_TIMESTAMP WHERE lease_id=${lease} AND status='running'`.catch(() => {}) }, 60_000)
  heartbeat.unref()
  try {
    const items = await deps.preview(prisma)
    for (const source of new Set(items.filter(item => item.sourceOrderNo && item.state !== 'invalid' && item.state !== 'conflict').map(item => item.sourceOrderNo))) {
      const group = items.filter(item => item.sourceOrderNo === source)
      if (group.some(item => item.state === 'matched')) {
        try { await deps.apply(prisma, source, items) }
        catch (error) {
          const message = error instanceof Error ? error.message.slice(0, 500) : 'ABI 更新失败'
          await prisma.$executeRaw`INSERT INTO registration_application_lookup (source_order_no,status,last_error) VALUES (${source},'local_error',${message})
            ON CONFLICT (source_order_no) DO UPDATE SET status='local_error',last_error=EXCLUDED.last_error,
              lease_account=NULL,lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP`
        }
      } else {
        await prisma.$executeRaw`INSERT INTO registration_application_lookup (source_order_no,run_day,status)
          VALUES (${source},(CURRENT_TIMESTAMP::timestamp - INTERVAL '5 hours')::date,'pending')
          ON CONFLICT (source_order_no) DO UPDATE SET run_day=EXCLUDED.run_day,status='pending',application_no=NULL,source=NULL,last_error=NULL,
            lease_account=NULL,lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP
          WHERE registration_application_lookup.run_day IS DISTINCT FROM EXCLUDED.run_day`
      }
    }
    await prisma.$executeRaw`UPDATE registration_application_runs SET status='ready',lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE lease_id=${lease} AND status='running'`
    return true
  } catch (error) {
    await prisma.$executeRaw`UPDATE registration_application_runs SET status='error',lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE lease_id=${lease} AND status='running'`.catch(() => {})
    throw error
  } finally { clearInterval(heartbeat) }
}

/** 已取得申请号但 ABI 写入失败时，无需重新请求泰康，稍后重新尝试写入。 */
export async function retryRegistrationWrites(prisma: PrismaClient, apply = applyRegistrationSource): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ source_order_no: string }>>`
    SELECT source_order_no FROM registration_application_lookup
    WHERE status IN ('matched','local_error') AND last_error IS NOT NULL
      AND updated_at < CURRENT_TIMESTAMP - INTERVAL '10 minutes'
    ORDER BY updated_at LIMIT 50`
  for (const row of rows) {
    try {
      await apply(prisma, row.source_order_no)
      await prisma.$executeRaw`UPDATE registration_application_lookup SET last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE source_order_no=${row.source_order_no} AND status IN ('matched','local_error')`
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'ABI 更新失败'
      await prisma.$executeRaw`UPDATE registration_application_lookup SET last_error=${message},updated_at=CURRENT_TIMESTAMP WHERE source_order_no=${row.source_order_no} AND status IN ('matched','local_error')`
    }
  }
}

/** 启动后等待下一个北京时间 5 点，不因部署或重启补跑当天清单。 */
export function nextRegistrationSchedule(now = Date.now()): number {
  const shanghai = new Date(now + 8 * 60 * 60 * 1000)
  let next = Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate(), 5) - 8 * 60 * 60 * 1000
  if (next <= now) next += 24 * 60 * 60 * 1000
  return next
}

export function startRegistrationApplicationSchedule(prisma: PrismaClient, log: { error: (error: unknown, message: string) => void }): () => void {
  let running = false
  let retrying = false
  const firstRun = nextRegistrationSchedule()
  const tick = () => {
    if (running || Date.now() < firstRun) return
    running = true
    void runDailyRegistrationBackfill(prisma).catch(error => log.error(error, '挂号协助申请号同步失败')).finally(() => { running = false })
  }
  const timer = setInterval(tick, 60_000)
  timer.unref()
  const retryTimer = setInterval(() => {
    if (retrying) return
    retrying = true
    void retryRegistrationWrites(prisma).catch(error => log.error(error, '挂号协助申请号写入重试失败')).finally(() => { retrying = false })
  }, 10 * 60_000)
  retryTimer.unref()
  return () => { clearInterval(timer); clearInterval(retryTimer) }
}
