/**
 * 寰宇系统订单自动提醒调度任务。
 * 负责扫描并自动生成以下业务提醒（写入 order_reminders 表推送给订单责任客户经理）：
 * 1. 【约住院】：每 3 天上午 09:00 提醒一次跟进排队；
 * 2.1 【陪诊未指派】：前置步骤完成满 1 小时未指派陪诊人；
 * 2.2 【陪诊前一天未反馈】：前一天 11:00 发短信，13:00 未反馈提醒客户经理；
 * 2.3 【陪诊当天出工未反馈】：当天 07:00 发短信，07:20 未反馈报警客户经理；
 * 3.1 【住院陪护确认护工开始时间】：入院后未定护工时间，每 2 天上午 09:00 提醒；
 * 3.2 【住院陪护结束前提醒】：护工结束日前 2 个工作日（排除周末与节假日）上午 09:00 提醒。
 */

import type { PrismaClient } from '@prisma/client'
import { formatYmd, subtractWorkdays } from '../lib/chineseWorkdays.js'
import { sendAliyunSms, getSmsConfig } from '../services/aliyunSmsService.js'
import { listHuanyuEscorts } from '../db/remoteDictionary.js'
import { normalizeReminderDate, shouldAdvancePeriodicReminder } from './orderReminderRules.js'

// 每条正式陪诊明细独立处理；陪诊人、服务日期和 ZJ 始终来自同一行。
const FORMAL_ESCORT_JOINS = `
  LEFT JOIN LATERAL (
    SELECT "ZJ", "PZR", "BBQ_FW" FROM "fact_hy_pzrxx" p
    WHERE (p."DDBH" = o.huanyu_order_no OR p."DDBH" = o.source_order_no)
      AND NULLIF(TRIM(p."PZR"), '') IS NOT NULL
  ) p ON true
`
const FORMAL_ESCORT_DATE_YMD = `
  CASE WHEN TRIM(p."BBQ_FW") ~ '^[0-9]{4}[-/.]?[0-9]{1,2}[-/.]?[0-9]{1,2}'
    THEN substring(TRIM(p."BBQ_FW") from '^([0-9]{4})') || '-' ||
      lpad(substring(TRIM(p."BBQ_FW") from '^[0-9]{4}[-/.]?([0-9]{1,2})'), 2, '0') || '-' ||
      lpad(substring(TRIM(p."BBQ_FW") from '^[0-9]{4}[-/.]?[0-9]{1,2}[-/.]?([0-9]{1,2})'), 2, '0')
    ELSE NULL END
`

export interface LoggerLike {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string, err?: unknown) => void
}

const CHECK_INTERVAL_MS = 15_000 // 其他提醒每 15 秒轮询一次；短信另用定点定时器
let timer: NodeJS.Timeout | null = null
const smsTimers: Partial<Record<'pre_day' | 'same_day', NodeJS.Timeout>> = {}
let smsScheduleGeneration = 0
let isRunning = false

async function queryInPages(prisma: PrismaClient, sql: string, ...params: any[]): Promise<any[]> {
  const baseSql = sql.trim().replace(/;\s*$/, '')
  const rows: any[] = []
  let offset = 0
  while (true) {
    const page = await prisma.$queryRawUnsafe<any[]>(
      `${baseSql} LIMIT 200 OFFSET $${params.length + 1}`,
      ...params,
      offset
    )
    rows.push(...page)
    if (page.length < 200) return rows
    offset += page.length
  }
}

function nextShanghaiTime(hour: number): Date {
  const now = new Date()
  const { ymd } = shanghaiNowParts(now)
  let target = new Date(`${ymd}T${String(hour).padStart(2, '0')}:00:00+08:00`)
  if (target.getTime() <= now.getTime()) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000)
  }
  return target
}

function scheduleSmsRun(
  prisma: PrismaClient,
  logger: LoggerLike | undefined,
  batchType: 'pre_day' | 'same_day',
  hour: number,
  generation: number
): void {
  if (generation !== smsScheduleGeneration) return
  const target = nextShanghaiTime(hour)
  const delay = Math.max(0, target.getTime() - Date.now())
  logger?.info(`[orderReminderSchedule] ${batchType} 短信下次触发时间: ${target.toISOString()}`)
  smsTimers[batchType] = setTimeout(async () => {
    delete smsTimers[batchType]
    try {
      if (batchType === 'pre_day') await sendPreDayEscortSms(prisma, logger)
      else await sendSameDayEscortSms(prisma, logger)
    } catch (err) {
      logger?.error(`[orderReminderSchedule] ${batchType} 短信定点任务异常:`, err)
    } finally {
      if (generation === smsScheduleGeneration) {
        scheduleSmsRun(prisma, logger, batchType, hour, generation)
      }
    }
  }, delay)
}

function shanghaiNowParts(now = new Date()): { ymd: string; time: string; hours: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now)

  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  const ymd = `${part('year')}-${part('month')}-${part('day')}`
  const time = `${part('hour')}:${part('minute')}`
  return {
    ymd,
    time,
    hours: Number(part('hour')),
    minutes: Number(part('minute'))
  }
}

function formatDateDisplay(date: Date | string | null | undefined): string {
  if (!date) return ''
  const d = typeof date === 'string' ? new Date(date) : date
  if (isNaN(d.getTime())) return String(date)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(d)
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`
}

function normalizeYmdValue(value: unknown): string | null {
  return normalizeReminderDate(value)
}

function addShanghaiCalendarDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split('-').map(Number)
  return formatYmd(new Date(Date.UTC(year, month - 1, day + days, 1)))
}

function shanghaiCalendarDayDiff(from: Date | string, toYmd: string): number {
  const fromYmd = formatYmd(new Date(from))
  const fromParts = fromYmd.split('-').map(Number)
  const toParts = toYmd.split('-').map(Number)
  const fromUtc = Date.UTC(fromParts[0], fromParts[1] - 1, fromParts[2])
  const toUtc = Date.UTC(toParts[0], toParts[1] - 1, toParts[2])
  return Math.floor((toUtc - fromUtc) / (24 * 3600 * 1000))
}

/**
 * 插入提醒记录（基于 dedupe_key 幂等去重）
 */
async function createReminderIfAbsent(
  prisma: PrismaClient,
  params: {
    orderNo: string
    employeeId: number
    type: 'hospital_booking' | 'escort' | 'hospital_care' | 'system' | 'upload_recording'
    content: string
    dedupeKey: string
    logger?: LoggerLike
    extra?: Record<string, unknown>
  }
): Promise<boolean> {
  try {
    const existing = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, extra_data->>'pzr' AS pzr, extra_data->>'serviceDate' AS service_date FROM order_reminders WHERE extra_data->>'dedupe_key' = $1 ORDER BY id DESC LIMIT 1;`,
      params.dedupeKey
    )
    if (existing && existing.length > 0) {
      const current = existing[0]
      const nextPzr = String(params.extra?.pzr ?? '').trim()
      const nextDate = String(params.extra?.serviceDate ?? '').trim()
      if (nextPzr && nextDate && (current.pzr !== nextPzr || current.service_date !== nextDate)) {
        await prisma.$executeRawUnsafe(`
          UPDATE order_reminders SET order_no = $1, employee_id = $2, type = $3, content = $4,
            remind_time = NOW(), status = 'pending', notification_generation = notification_generation + 1,
            extra_data = $5::jsonb, updated_at = NOW()
          WHERE id = $6;
        `, params.orderNo, params.employeeId, params.type, params.content,
        JSON.stringify({ dedupe_key: params.dedupeKey, ...(params.extra ?? {}) }), current.id)
        return true
      }
      return false
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO order_reminders (
        order_no, employee_id, type, content, remind_time, status, extra_data, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, NOW(), 'pending', $5::jsonb, NOW(), NOW());`,
      params.orderNo,
      params.employeeId,
      params.type,
      params.content,
      JSON.stringify({ dedupe_key: params.dedupeKey, ...(params.extra ?? {}) })
    )

    params.logger?.info(`[orderReminderSchedule] 已为员工 ${params.employeeId} 生成提醒: ${params.dedupeKey}`)
    return true
  } catch (err) {
    params.logger?.error(`[orderReminderSchedule] 创建提醒失败 (${params.dedupeKey}):`, err)
    return false
  }
}

interface EscortRejectReminderRow {
  order_id?: number
  source_order_no: string
  huanyu_order_no?: string | null
  order_created_at?: Date | string | null
  assigned_employee_id: number
  pzr?: string | null
  pzr_detail_id?: string | null
  service_date?: string | null
}

/** 使用同一文案和去重键创建陪诊拒单提醒，供即时反馈和定时扫描共用。 */
async function createEscortRejectReminder(
  prisma: PrismaClient,
  row: EscortRejectReminderRow,
  params: { feedbackType: 'pre_day' | 'same_day'; ymd: string; serviceDate?: string; remark?: string | null; time?: string; logger?: LoggerLike }
): Promise<void> {
  const isPreDay = params.feedbackType === 'pre_day'
  const detailId = row.pzr_detail_id || 'unknown-detail'
  const dedupeKey = `auto:escort_${params.feedbackType}_reject:${row.source_order_no}:${detailId}:${params.ymd}`
  const reasonText = params.remark ? `（原因：${params.remark}）` : ''
  const timingText = isPreDay ? '' : '当天'
  const urgencyText = isPreDay ? '请立即处理！' : '请紧急处理！'

  await createReminderIfAbsent(prisma, {
    orderNo: row.source_order_no,
    employeeId: row.assigned_employee_id,
    type: 'escort',
    content: `订单号: ${row.source_order_no}\n陪诊明细: ${detailId}\n陪诊人员: ${row.pzr || '未填写'}\n服务日期: ${params.serviceDate || ''}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 陪诊人员${timingText}反馈【无法出工】${reasonText}，${urgencyText}`,
    dedupeKey,
    logger: params.logger,
    extra: {
      serviceDate: params.serviceDate ?? (isPreDay ? addShanghaiCalendarDays(params.ymd, 1) : params.ymd),
      ...(params.time ? { triggerTime: params.time } : {}),
      pzr: row.pzr,
      pzrDetailId: row.pzr_detail_id,
      willAttend: false,
      remark: params.remark
    }
  })
}

/**
 * 陪诊反馈接口写入“无法出工”后立即建立提醒。资格规则与周期扫描保持一致：
 * 只处理有效订单、指定服务类型、存在陪诊步骤、已有正式陪诊人且日期匹配的订单。
 */
export async function createEscortRejectReminderForFeedback(
  prisma: PrismaClient,
  params: { orderNo: string; pzrDetailId: string; feedbackType: 'pre_day' | 'same_day'; pzrId: string; serviceDate: string; remark?: string | null; logger?: LoggerLike }
): Promise<boolean> {
  const { ymd } = shanghaiNowParts()
  const expectedDate = params.feedbackType === 'pre_day' ? addShanghaiCalendarDays(ymd, 1) : ymd
  const rows = await prisma.$queryRawUnsafe<EscortRejectReminderRow[]>(`
    SELECT o.id AS order_id, o.source_order_no, o.huanyu_order_no, o.created_at AS order_created_at,
           o.assigned_employee_id, p."ZJ" AS pzr_detail_id, NULLIF(TRIM(p."PZR"), '') AS pzr,
           ${FORMAL_ESCORT_DATE_YMD} AS service_date
    FROM orders o
    JOIN b_order_operations op ON op.order_id = o.id
    ${FORMAL_ESCORT_JOINS}
    WHERE (o.source_order_no = $1 OR o.huanyu_order_no = $1)
      AND o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
      AND op.service_type IN ('全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '检查加急', '住院')
      AND EXISTS (
        SELECT 1 FROM b_order_service_steps cstep
        WHERE cstep.operation_id = op.id
          AND cstep.step_code IN ('escort', 'check_companion', 'hospital_companion', 'revisit_escort')
          AND cstep.step_status IN ('pending', 'in_progress')
      )
      AND NULLIF(TRIM(p."PZR"), '') IS NOT NULL
      AND ${FORMAL_ESCORT_DATE_YMD} = $2
      AND NULLIF(TRIM(p."PZR"), '') = $3
      AND p."ZJ" = $4
    ORDER BY o.created_at ASC, o.id ASC, p."ZJ" ASC
    LIMIT 1;
  `, params.orderNo, expectedDate, params.pzrId, params.pzrDetailId)

  const row = rows[0]
  if (!row?.source_order_no || !row.assigned_employee_id || normalizeYmdValue(row.service_date) !== params.serviceDate) return false

  await createEscortRejectReminder(prisma, row, {
    feedbackType: params.feedbackType,
    ymd,
    serviceDate: params.serviceDate,
    remark: params.remark,
    logger: params.logger
  })
  return true
}

/**
 * 周期性跟进只保留一条记录。每到新周期更新并重新打开该记录，避免每个周期都堆一条历史待办。
 */
async function upsertPeriodicReminder(
  prisma: PrismaClient,
  params: {
    orderNo: string
    employeeId: number
    type: 'hospital_booking' | 'hospital_care'
    content: string
    dedupeKey: string
    occurrence: number
    logger?: LoggerLike
    extra?: Record<string, unknown>
  }
): Promise<boolean> {
  try {
    const existing = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, status, notification_generation, extra_data->>'occurrence' AS occurrence, extra_data->>'cycleIdentity' AS cycle_identity FROM order_reminders WHERE extra_data->>'dedupe_key' = $1 ORDER BY id DESC LIMIT 1;`,
      params.dedupeKey
    )
    const occurrence = existing?.[0] ? Number(existing[0].occurrence ?? 0) : null
    const cycleIdentity = String(params.extra?.cycleIdentity ?? '')
    if (existing?.[0] && !shouldAdvancePeriodicReminder(occurrence, existing[0].cycle_identity, params.occurrence, cycleIdentity)) return false

    const extraData = JSON.stringify({
      dedupe_key: params.dedupeKey,
      occurrence: params.occurrence,
      ...(params.extra ?? {})
    })
    if (existing?.[0]) {
      const generation = Math.max(params.occurrence, Number(existing[0].notification_generation || 1) + 1)
      await prisma.$executeRawUnsafe(
        `UPDATE order_reminders SET order_no = $1, employee_id = $2, type = $3, content = $4, remind_time = NOW(), status = 'pending', notification_generation = $7, extra_data = $5::jsonb, updated_at = NOW() WHERE id = $6;`,
        params.orderNo,
        params.employeeId,
        params.type,
        params.content,
        extraData,
        existing[0].id,
        generation
      )
    } else {
      await prisma.$executeRawUnsafe(
        `INSERT INTO order_reminders (order_no, employee_id, type, content, remind_time, status, notification_generation, extra_data, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), 'pending', $6, $5::jsonb, NOW(), NOW());`,
        params.orderNo,
        params.employeeId,
        params.type,
        params.content,
        extraData,
        Math.max(params.occurrence, 1)
      )
    }
    params.logger?.info(`[orderReminderSchedule] 已更新周期提醒: ${params.dedupeKey}, occurrence=${params.occurrence}`)
    return true
  } catch (err) {
    params.logger?.error(`[orderReminderSchedule] 更新周期提醒失败 (${params.dedupeKey}):`, err)
    return false
  }
}

async function closeReminderByKey(prisma: PrismaClient, dedupeKey: string, status: 'resolved' | 'expired' = 'resolved'): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE order_reminders SET status = $1, updated_at = NOW() WHERE extra_data->>'dedupe_key' = $2 AND status IN ('pending', 'unread');`,
    status,
    dedupeKey
  )
}

async function closeReminderKeysExcept(prisma: PrismaClient, prefix: string, activeKey: string | null, status: 'resolved' | 'expired' | 'superseded'): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE order_reminders SET status = $1, updated_at = NOW() WHERE extra_data->>'dedupe_key' LIKE $2 AND ($3::text IS NULL OR extra_data->>'dedupe_key' != $3) AND status IN ('pending', 'unread');`,
    status,
    `${prefix}%`,
    activeKey
  )
}

async function closeStalePeriodicCycle(prisma: PrismaClient, dedupeKey: string, cycleIdentity: string): Promise<void> {
  await prisma.$executeRawUnsafe(`
    UPDATE order_reminders SET status = 'superseded', updated_at = NOW()
    WHERE extra_data->>'dedupe_key' = $1 AND status IN ('pending', 'unread')
      AND extra_data->>'cycleIdentity' IS DISTINCT FROM $2;
  `, dedupeKey, cycleIdentity)
}

async function reconcileReminderLifecycle(prisma: PrismaClient, logger?: LoggerLike): Promise<void> {
  // 清理旧版本按日期生成的周期提醒，避免部署后历史重复项继续集中弹出。
  await prisma.$executeRawUnsafe(`
    UPDATE order_reminders
       SET status = 'superseded', updated_at = NOW()
     WHERE status IN ('pending', 'unread')
       AND (
         (type = 'hospital_booking' AND extra_data->>'dedupe_key' ~ '^auto:hospital_booking:.+:[0-9]{4}-[0-9]{2}-[0-9]{2}$')
         OR (type = 'hospital_care' AND extra_data->>'dedupe_key' ~ '^auto:care_start_unassigned:.+:[0-9]{4}-[0-9]{2}-[0-9]{2}$')
       );
  `)

  // 住院预约步骤已结束或订单已取消/完结时，关闭其周期跟进提醒。
  await prisma.$executeRawUnsafe(`
    UPDATE order_reminders r
       SET status = 'resolved', updated_at = NOW()
     WHERE r.type = 'hospital_booking'
       AND r.status IN ('pending', 'unread')
       AND r.extra_data->>'dedupe_key' LIKE 'auto:hospital_booking:%'
       AND NOT EXISTS (
         SELECT 1
           FROM b_order_service_steps s
           JOIN b_order_operations op ON op.id = s.operation_id
           JOIN orders o ON o.id = op.order_id
          WHERE s.step_code = 'hospital_booking'
            AND s.step_status IN ('pending', 'in_progress')
            AND op.service_type IN ('全流程', '住院')
            AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
            AND r.extra_data->>'dedupe_key' = 'auto:hospital_booking:' || o.source_order_no
       );
  `)

  // 陪诊未落实提醒以业务条件关闭：陪诊人员正式落实、前置步骤/陪诊步骤失效，或订单结束。
  await prisma.$executeRawUnsafe(`
    UPDATE order_reminders r
       SET status = 'resolved', updated_at = NOW()
     WHERE r.type = 'escort'
       AND r.status IN ('pending', 'unread')
       AND r.extra_data->>'dedupe_key' LIKE 'auto:escort_unassigned:%'
       AND r.extra_data->>'pzrDetailId' IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM orders o
           JOIN b_order_operations op ON op.order_id = o.id
          WHERE o.source_order_no = r.order_no
            AND o.assigned_employee_id IS NOT NULL
            AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
            AND EXISTS (
              SELECT 1 FROM b_order_service_steps s
               WHERE s.operation_id = op.id AND s.step_status = 'completed'
                 AND (
                   (s.step_code = 'registration' AND op.service_type IN ('全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务'))
                   OR (s.step_code = 'check_booking' AND op.service_type IN ('全流程', '检查加急'))
                   OR (s.step_code = 'hospital_booking' AND op.service_type IN ('全流程', '住院'))
                   OR (s.step_code = 'revisit' AND op.service_type IN ('全流程', '全程门诊'))
                 )
            )
            AND EXISTS (
              SELECT 1 FROM b_order_service_steps cstep
               WHERE cstep.operation_id = op.id
                 AND cstep.step_code IN ('escort', 'check_companion', 'hospital_companion', 'revisit_escort')
                 AND cstep.step_status IN ('pending', 'in_progress')
            )
            AND NOT EXISTS (
              SELECT 1 FROM "fact_hy_pzrxx" p
               WHERE (p."DDBH" = o.source_order_no OR (o.huanyu_order_no IS NOT NULL AND p."DDBH" = o.huanyu_order_no))
                 AND p."PZR" IS NOT NULL AND TRIM(p."PZR") != ''
            )
       );
  `)

  await prisma.$executeRawUnsafe(`
    UPDATE order_reminders r
       SET status = 'resolved', updated_at = NOW()
     WHERE r.type = 'escort'
       AND r.status IN ('pending', 'unread')
       AND r.extra_data->>'pzrDetailId' IS NOT NULL
       AND r.extra_data->>'dedupe_key' LIKE 'auto:escort_unassigned:%'
       AND NOT EXISTS (
         SELECT 1
           FROM orders o
           JOIN b_order_operations op ON op.order_id = o.id
           JOIN fact_hy_pzrxx p ON p."ZJ" = r.extra_data->>'pzrDetailId'
          WHERE o.source_order_no = r.order_no
            AND (p."DDBH" = o.source_order_no OR (o.huanyu_order_no IS NOT NULL AND p."DDBH" = o.huanyu_order_no))
            AND NULLIF(TRIM(p."PZR"), '') IS NULL
            AND o.assigned_employee_id IS NOT NULL
            AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
            AND EXISTS (
              SELECT 1 FROM b_order_service_steps s
               WHERE s.operation_id = op.id AND s.step_status = 'completed'
                 AND (
                   (s.step_code = 'registration' AND op.service_type IN ('全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务'))
                   OR (s.step_code = 'check_booking' AND op.service_type IN ('全流程', '检查加急'))
                   OR (s.step_code = 'hospital_booking' AND op.service_type IN ('全流程', '住院'))
                   OR (s.step_code = 'revisit' AND op.service_type IN ('全流程', '全程门诊'))
                 )
            )
            AND EXISTS (
              SELECT 1 FROM b_order_service_steps cstep
               WHERE cstep.operation_id = op.id
                 AND cstep.step_code IN ('escort', 'check_companion', 'hospital_companion', 'revisit_escort')
                 AND cstep.step_status IN ('pending', 'in_progress')
            )
       );
  `)

  // 护工开始时间已补齐或订单结束时，关闭其周期跟进提醒。
  await prisma.$executeRawUnsafe(`
    UPDATE order_reminders r
       SET status = 'resolved', updated_at = NOW()
     WHERE r.type = 'hospital_care'
       AND r.status IN ('pending', 'unread')
       AND r.extra_data->>'dedupe_key' LIKE 'auto:care_start_unassigned:%'
       AND NOT EXISTS (
         SELECT 1
           FROM orders o
           JOIN b_order_operations op ON op.order_id = o.id AND op.service_type = '住院护工协助'
           JOIN b_order_service_steps s ON s.operation_id = op.id AND s.step_code = 'hospital_care' AND s.step_status IN ('pending', 'in_progress')
           LEFT JOIN "HY_FACT_DDCX_NEW" h ON (h."BDQD_DDBH" = o.source_order_no OR (o.huanyu_order_no IS NOT NULL AND h."DDBH" = o.huanyu_order_no))
          WHERE (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
            AND COALESCE(NULLIF(TRIM(h."BBQ_FW"), ''), NULLIF(TRIM(h."DATE_FW"), '')) IS NULL
            AND r.extra_data->>'dedupe_key' = 'auto:care_start_unassigned:' || o.source_order_no
       );
  `)

  // 陪诊提醒只属于创建时的人员和日期。换人、改期、取消步骤后旧提醒失效。
  await prisma.$executeRawUnsafe(`
    UPDATE order_reminders r SET status = 'superseded', updated_at = NOW()
    WHERE r.type = 'escort' AND r.status IN ('pending', 'unread')
      AND (r.extra_data->>'dedupe_key' ~ '^auto:escort_(pre_day|same_day)_(unack|reject):'
           OR (r.extra_data->>'dedupe_key' LIKE 'auto:escort_sms_failed:%' AND r.extra_data->>'pzr' IS NOT NULL))
      AND r.extra_data->>'serviceDate' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM orders o
        JOIN b_order_operations op ON op.order_id = o.id
        ${FORMAL_ESCORT_JOINS}
        WHERE o.source_order_no = r.order_no
          AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
          AND op.service_type IN ('全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '检查加急', '住院')
          AND EXISTS (
            SELECT 1 FROM b_order_service_steps s WHERE s.operation_id = op.id
              AND s.step_code IN ('escort', 'check_companion', 'hospital_companion', 'revisit_escort')
              AND s.step_status IN ('pending', 'in_progress')
          )
          AND r.extra_data->>'pzr' = NULLIF(TRIM(p."PZR"), '')
          AND r.extra_data->>'pzrDetailId' = p."ZJ"
          AND r.extra_data->>'serviceDate' = ${FORMAL_ESCORT_DATE_YMD}
      );
  `)

  // 护工结束日发生变动、步骤结束或订单完结时立即关闭旧提醒。
  await prisma.$executeRawUnsafe(`
    UPDATE order_reminders r SET status = 'superseded', updated_at = NOW()
    WHERE r.type = 'hospital_care' AND r.status IN ('pending', 'unread')
      AND r.extra_data->>'dedupe_key' LIKE 'auto:care_end_notify:%'
      AND (
        r.extra_data->>'careEndDate' < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text
        OR NOT EXISTS (
          SELECT 1 FROM orders o
          JOIN b_order_operations op ON op.order_id = o.id AND op.service_type = '住院护工协助'
          JOIN b_order_service_steps s ON s.operation_id = op.id AND s.step_code = 'hospital_care' AND s.step_status IN ('pending', 'in_progress')
          LEFT JOIN "HY_FACT_DDCX_NEW" h ON (h."BDQD_DDBH" = o.source_order_no OR (o.huanyu_order_no IS NOT NULL AND h."DDBH" = o.huanyu_order_no))
          WHERE o.source_order_no = r.order_no
            AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
            AND r.extra_data->>'careEndDate' = replace(replace(LEFT(TRIM(COALESCE(NULLIF(TRIM(h."BBQ_QDFW"), ''), NULLIF(TRIM(h."DATE_QDFW"), ''))), 10), '/', '-'), '.', '-')
        )
      );
  `)

  await prisma.$executeRawUnsafe(`
    UPDATE order_reminders
       SET status = 'expired', updated_at = NOW()
     WHERE type = 'escort'
       AND status IN ('pending', 'unread')
       AND extra_data->>'dedupe_key' LIKE 'auto:escort_unassigned:%'
       AND extra_data->>'serviceDate' ~ '^\\d{4}-\\d{2}-\\d{2}'
       AND LEFT(extra_data->>'serviceDate', 10) < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text;
  `)

  await prisma.$executeRawUnsafe(`
    UPDATE order_reminders
       SET status = 'expired', updated_at = NOW()
     WHERE type = 'escort'
       AND status IN ('pending', 'unread')
       AND extra_data->>'dedupe_key' ~ '^auto:escort_(pre_day|same_day):.+:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       AND RIGHT(extra_data->>'dedupe_key', 10) < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text;
  `)

  // 短信发送失败提醒的去重日期是发送日；有效期应以服务日为准（前一天批次需要保留到次日）。
  await prisma.$executeRawUnsafe(`
    UPDATE order_reminders
       SET status = 'expired', updated_at = NOW()
     WHERE type = 'escort'
       AND status IN ('pending', 'unread')
       AND extra_data->>'dedupe_key' ~ '^auto:escort_sms_failed:.+:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       AND (extra_data->>'serviceDate' IS NULL OR extra_data->>'serviceDate' !~ '^\\d{4}-\\d{2}-\\d{2}')
       AND RIGHT(extra_data->>'dedupe_key', 10) < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text;
  `)

  // 有服务日期的一次性陪诊异常，在服务日结束后失效，不再次日弹出。
  const expired = await prisma.$executeRawUnsafe(`
    UPDATE order_reminders
       SET status = 'expired', updated_at = NOW()
     WHERE type = 'escort'
       AND status IN ('pending', 'unread')
       AND extra_data->>'serviceDate' ~ '^\\d{4}-\\d{2}-\\d{2}'
       AND LEFT(extra_data->>'serviceDate', 10) < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text;
  `)
  if (Number(expired) > 0) logger?.info(`[orderReminderSchedule] 已关闭 ${Number(expired)} 条已过服务日期的陪诊提醒`)
}

async function reconcileStaleSmsClaims(prisma: PrismaClient, logger?: LoggerLike): Promise<void> {
  const { ymd: today } = shanghaiNowParts()
  const claims = await prisma.$queryRawUnsafe<any[]>(`
    SELECT c.order_no, c.batch_type, c.send_ymd, c.pzr_detail_id, c.pzr_id, c.service_date, c.claimed_at, c.error_message,
           o.created_at AS order_created_at, o.assigned_employee_id
      FROM "fact_hy_pz_sms_send_claims" c
      LEFT JOIN orders o ON o.source_order_no = c.order_no
     WHERE c.status = 'sending' AND c.claimed_at < NOW() - INTERVAL '5 minutes'
     ORDER BY c.claimed_at ASC
     LIMIT 500;
  `)

  for (const claim of claims) {
    const serviceDate = claim.batch_type === 'pre_day'
      ? addShanghaiCalendarDays(String(claim.send_ymd), 1)
      : String(claim.send_ymd)
    const logs = await prisma.$queryRawUnsafe<any[]>(`
      SELECT status, error_message FROM "fact_hy_pz_sms_logs"
       WHERE order_no = $1 AND batch_type = $2 AND send_ymd = $3
         AND params_json->>'pzrDetailId' = $4
       ORDER BY id DESC LIMIT 1;
    `, claim.order_no, claim.batch_type, claim.send_ymd, claim.pzr_detail_id)
    const log = logs[0]
    if (log) {
      await finishEscortSmsClaim(
        prisma,
        claim.order_no,
        claim.batch_type,
        claim.send_ymd,
        log.status === 'success' ? 'sent' : 'failed',
        log.error_message || null,
        claim.pzr_detail_id
      )
      if (log.status === 'success') {
        await closeReminderByKey(prisma, `auto:escort_sms_failed:${claim.order_no}:${claim.batch_type}:${claim.pzr_detail_id}:${claim.send_ymd}`)
      }
      if (log.status !== 'success' && serviceDate >= today && claim.assigned_employee_id) {
        const batchLabel = claim.batch_type === 'pre_day' ? '前一天确认' : '当天打卡'
        const failureReason = log.error_message || '短信流水记录失败状态，但提醒创建可能中断'
        await createReminderIfAbsent(prisma, {
          orderNo: claim.order_no,
          employeeId: claim.assigned_employee_id,
          type: 'escort',
          content: `订单号: ${claim.order_no}\n申请时间: ${formatDateDisplay(claim.order_created_at)}\n提醒内容: 陪诊${batchLabel}短信未成功（${failureReason}），不会补发，请及时人工联系陪诊人员！`,
          dedupeKey: `auto:escort_sms_failed:${claim.order_no}:${claim.batch_type}:${claim.pzr_detail_id}:${claim.send_ymd}`,
          logger,
          extra: { failureReason, batchType: claim.batch_type, pzr: claim.pzr_id, pzrDetailId: claim.pzr_detail_id, serviceDate }
        })
      }
      continue
    }
    await finishEscortSmsClaim(prisma, claim.order_no, claim.batch_type, claim.send_ymd, 'unknown', '发送任务中断，供应商结果未知', claim.pzr_detail_id)

    // 不重发结果未知的短信；只在服务日尚未结束且当前仍有责任人时通知人工确认。
    if (serviceDate < today || !claim.assigned_employee_id) continue
    const batchLabel = claim.batch_type === 'pre_day' ? '前一天确认' : '当天打卡'
    await createReminderIfAbsent(prisma, {
      orderNo: claim.order_no,
      employeeId: claim.assigned_employee_id,
      type: 'escort',
      content: `订单号: ${claim.order_no}\n申请时间: ${formatDateDisplay(claim.order_created_at)}\n提醒内容: 陪诊${batchLabel}短信发送结果未知（任务中断），系统不会补发，请人工确认是否需要联系陪诊人员。`,
      dedupeKey: `auto:escort_sms_failed:${claim.order_no}:${claim.batch_type}:${claim.pzr_detail_id}:${claim.send_ymd}`,
      logger,
      extra: { failureReason: '发送任务中断，供应商结果未知', batchType: claim.batch_type, pzr: claim.pzr_id, pzrDetailId: claim.pzr_detail_id, serviceDate }
    })
  }
}

/**
 * 场景 1：【约住院】排队跟进提醒（每 3 天上午 09:00 一次）
 */
export async function scanHospitalBookingReminders(prisma: PrismaClient, logger?: LoggerLike, now = new Date()): Promise<void> {
  const { ymd, hours } = shanghaiNowParts(now)

  const steps = await queryInPages(prisma, `
    SELECT 
      s.id, s.occurrence_no, s.activated_at, s.started_at, s.created_at AS step_created_at,
      o.id AS order_id, o.source_order_no, o.created_at AS order_created_at, o.assigned_employee_id, o.status AS order_status,
      op.service_type
    FROM b_order_service_steps s
    JOIN b_order_operations op ON s.operation_id = op.id
    JOIN orders o ON op.order_id = o.id
    WHERE s.step_code = 'hospital_booking'
      AND op.service_type IN ('全流程', '住院')
      AND s.step_status IN ('pending', 'in_progress')
      AND o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
    ORDER BY o.id ASC, s.occurrence_no DESC NULLS LAST, s.id DESC
  `)

  const seenOrders = new Set<string>()
  for (const row of steps) {
    if (!row.assigned_employee_id || !row.source_order_no) continue
    if (seenOrders.has(row.source_order_no)) continue
    seenOrders.add(row.source_order_no)

    const baseTime = row.activated_at || row.started_at || row.step_created_at || row.order_created_at
    if (!baseTime) continue
    const cycleIdentity = `${row.id}:${row.occurrence_no ?? 0}:${new Date(baseTime).toISOString()}`
    const dedupeKey = `auto:hospital_booking:${row.source_order_no}`
    await closeStalePeriodicCycle(prisma, dedupeKey, cycleIdentity)

    const diffDays = shanghaiCalendarDayDiff(baseTime, ymd)

    if (hours >= 9 && diffDays >= 3 && diffDays % 3 === 0) {
      const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 客户意向的住院时间前还没有预约成功，请关注！`

      await upsertPeriodicReminder(prisma, {
        orderNo: row.source_order_no,
        employeeId: row.assigned_employee_id,
        type: 'hospital_booking',
        content,
        dedupeKey,
        occurrence: Math.floor(diffDays / 3),
        logger,
        extra: { diffDays, stage: 'hospital_booking', cycleIdentity }
      })
    }
  }
}

/**
 * 场景 2.1：【陪诊】派单超时预警（前置完成满 1 小时未抓取到陪诊人）
 * 逻辑：
 * 1. 彻底不取 HY_FACT_DDCX_NEW.PZR
 * 2. 优先查正式表 fact_hy_pzrxx（有值则直接视为已落实）
 * 3. 未确认的 AI 候选不视为陪诊人员已落实
 * 4. 仅当正式表中无陪诊人员，且前置完成满 1 小时，才写入超时未落实预警
 * 5. 不向数据库做任何回写
 */
async function scanEscortUnassignedReminders(prisma: PrismaClient, logger?: LoggerLike): Promise<void> {
  const completedPreSteps = await queryInPages(prisma, `
    SELECT 
      s.id, s.step_code, s.completed_at,
      o.id AS order_id, o.source_order_no, o.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id, o.status AS order_status,
      op.service_type,
      COALESCE(NULLIF(TRIM(p."BBQ_FW"), ''), NULLIF(TRIM(h."BBQ_FW"), ''), NULLIF(TRIM(h."DATE_FW"), '')) AS service_date,
      EXISTS(
        SELECT 1 FROM "fact_hy_pzrxx" p 
        WHERE (p."DDBH" = o.source_order_no OR (o.huanyu_order_no IS NOT NULL AND p."DDBH" = o.huanyu_order_no))
          AND p."PZR" IS NOT NULL AND TRIM(p."PZR") != ''
      ) AS has_db_pzr
    FROM b_order_service_steps s
    JOIN b_order_operations op ON s.operation_id = op.id
    JOIN orders o ON op.order_id = o.id
    LEFT JOIN "HY_FACT_DDCX_NEW" h ON (h."BDQD_DDBH" = o.source_order_no OR (o.huanyu_order_no IS NOT NULL AND h."DDBH" = o.huanyu_order_no))
    LEFT JOIN LATERAL (
      SELECT "PZR", "BBQ_FW" FROM "fact_hy_pzrxx" p
      WHERE (p."DDBH" = o.source_order_no OR (o.huanyu_order_no IS NOT NULL AND p."DDBH" = o.huanyu_order_no))
        AND p."PZR" IS NOT NULL AND TRIM(p."PZR") != ''
      ORDER BY "xtsj" DESC NULLS LAST, "ZJ" DESC
      LIMIT 1
    ) p ON true
    WHERE (
      (s.step_code = 'registration' AND op.service_type IN ('全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务'))
      OR (s.step_code = 'check_booking' AND op.service_type IN ('全流程', '检查加急'))
      OR (s.step_code = 'hospital_booking' AND op.service_type IN ('全流程', '住院'))
      OR (s.step_code = 'revisit' AND op.service_type IN ('全流程', '全程门诊'))
    )
      AND s.step_status = 'completed'
      AND s.completed_at IS NOT NULL
      AND s.completed_at <= NOW() - INTERVAL '1 hour'
      AND o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
      AND EXISTS (
        SELECT 1 FROM b_order_service_steps cstep
        WHERE cstep.operation_id = op.id
          AND cstep.step_code IN ('escort', 'check_companion', 'hospital_companion', 'revisit_escort')
          AND cstep.step_status IN ('pending', 'in_progress')
      )
    ORDER BY s.completed_at ASC, s.id ASC
  `)

  for (const row of completedPreSteps) {
    if (!row.assigned_employee_id || !row.source_order_no) continue

    const dedupeKey = `auto:escort_unassigned:${row.source_order_no}:${row.step_code}`

    // 同一订单可能有多条陪诊明细；逐条检查空陪诊人明细，不能用“任意一条已指派”代替整单判断。
    const formalDetails = await prisma.$queryRawUnsafe<any[]>(`
      SELECT "ZJ" AS pzr_detail_id, NULLIF(TRIM("PZR"), '') AS pzr, NULLIF(TRIM("BBQ_FW"), '') AS service_date
      FROM "fact_hy_pzrxx"
      WHERE "DDBH" = $1 OR "DDBH" = $2
      ORDER BY "ZJ" ASC;
    `, row.source_order_no, row.huanyu_order_no || row.source_order_no)

    if (formalDetails.length > 0) {
      await closeReminderByKey(prisma, dedupeKey)
      for (const detail of formalDetails) {
        const detailId = String(detail.pzr_detail_id || '')
        const detailKey = `${dedupeKey}:${detailId}`
        if (detail.pzr) {
          await closeReminderByKey(prisma, detailKey)
          continue
        }
        const serviceDate = normalizeYmdValue(detail.service_date)
        await createReminderIfAbsent(prisma, {
          orderNo: row.source_order_no,
          employeeId: row.assigned_employee_id,
          type: 'escort',
          content: `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 陪诊明细 ${detailId} 尚未落实陪诊人员，请关注！`,
          dedupeKey: detailKey,
          logger,
          extra: {
            preStepCode: row.step_code,
            completedAt: row.completed_at,
            pzrDetailId: detailId,
            ...(serviceDate ? { serviceDate } : {})
          }
        })
      }
      continue
    }

    const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 陪诊人员没有落实，请关注！`

    await createReminderIfAbsent(prisma, {
      orderNo: row.source_order_no,
      employeeId: row.assigned_employee_id,
      type: 'escort',
      content,
      dedupeKey,
      logger,
      extra: {
        preStepCode: row.step_code,
        completedAt: row.completed_at,
        ...(normalizeYmdValue(row.service_date) ? { serviceDate: normalizeYmdValue(row.service_date) } : {})
      }
    })
    const serviceDate = normalizeYmdValue(row.service_date)
    if (serviceDate) {
      await prisma.$executeRawUnsafe(`
        UPDATE order_reminders
           SET extra_data = jsonb_set(COALESCE(extra_data, '{}'::jsonb), '{serviceDate}', to_jsonb($2::text), true),
               updated_at = NOW()
         WHERE extra_data->>'dedupe_key' = $1 AND status IN ('pending', 'unread');
      `, dedupeKey, serviceDate)
    } else {
      await prisma.$executeRawUnsafe(`
        UPDATE order_reminders
           SET extra_data = COALESCE(extra_data, '{}'::jsonb) - 'serviceDate', updated_at = NOW()
         WHERE extra_data->>'dedupe_key' = $1 AND status IN ('pending', 'unread');
      `, dedupeKey)
    }
  }
}

/**
 * 辅助方法：按已确认的陪诊人员姓名查询字典手机号，不回退到 AI 字段候选。
 */
async function resolveEscortPhone(
  prisma: PrismaClient,
  pzrName: string | null | undefined
): Promise<string | null> {
  const cleanName = (pzrName || '').trim()
  if (cleanName) {
    try {
      const escorts = await listHuanyuEscorts(cleanName)
      const exactMatches = escorts.filter((e) => e.id === cleanName || e.name === cleanName)
      const matched = exactMatches.length === 1 ? exactMatches[0] : null
      if (matched && matched.phone && String(matched.phone).trim()) {
        return String(matched.phone).trim()
      }
    } catch {
      // 忽略远端异常
    }
  }

  return null
}

async function claimEscortSmsSend(
  prisma: PrismaClient,
  orderNo: string,
  batchType: 'pre_day' | 'same_day',
  sendYmd: string,
  pzrId: string,
  serviceDate: string,
  pzrDetailId: string
): Promise<boolean> {
  const legacyClaims = await prisma.$queryRawUnsafe<any[]>(`
    SELECT 1 FROM "fact_hy_pz_sms_send_claims"
    WHERE order_no = $1 AND batch_type = $2 AND send_ymd = $3
      AND pzr_detail_id = '' AND pzr_id = $4 AND service_date = $5
    LIMIT 1;
  `, orderNo, batchType, sendYmd, pzrId, serviceDate)
  if (legacyClaims.length > 0) return false

  const rows = await prisma.$queryRawUnsafe<any[]>(`
    INSERT INTO "fact_hy_pz_sms_send_claims" ("order_no", "batch_type", "send_ymd", "pzr_id", "service_date", "pzr_detail_id")
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT ("order_no", "batch_type", "send_ymd", "pzr_detail_id") DO NOTHING
    RETURNING "order_no";
  `, orderNo, batchType, sendYmd, pzrId, serviceDate, pzrDetailId)
  return rows.length > 0
}

async function finishEscortSmsClaim(
  prisma: PrismaClient,
  orderNo: string,
  batchType: 'pre_day' | 'same_day',
  sendYmd: string,
  status: 'sent' | 'failed' | 'skipped' | 'unknown',
  errorMessage: string | null = null,
  pzrDetailId = ''
): Promise<void> {
  await prisma.$executeRawUnsafe(`
    UPDATE "fact_hy_pz_sms_send_claims"
       SET status = $4, error_message = $5, completed_at = NOW()
     WHERE order_no = $1 AND batch_type = $2 AND send_ymd = $3 AND pzr_detail_id = $6;
  `, orderNo, batchType, sendYmd, status, errorMessage, pzrDetailId)
}

async function recordSkippedEscortSms(
  prisma: PrismaClient,
  row: any,
  batchType: 'pre_day' | 'same_day',
  sendYmd: string,
  serviceDate: string,
  templateCode: string,
  signName: string,
  reason: string,
  logger?: LoggerLike
): Promise<void> {
  await prisma.$executeRawUnsafe(`
    INSERT INTO "fact_hy_pz_sms_logs" (
      order_no, batch_type, pzr_name, service_date, template_code, sign_name,
      params_json, status, error_code, error_message, send_ymd, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'failed', 'NOT_SENT', $8, $9, NOW());
  `, row.source_order_no, batchType, row.pzr, serviceDate, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no, pzrDetailId: row.pzr_detail_id }), reason, sendYmd)
  await finishEscortSmsClaim(prisma, row.source_order_no, batchType, sendYmd, 'skipped', reason, row.pzr_detail_id)
  if (!row.assigned_employee_id) return

  const batchLabel = batchType === 'pre_day' ? '前一天确认' : '当天打卡'
  await createReminderIfAbsent(prisma, {
    orderNo: row.source_order_no,
    employeeId: row.assigned_employee_id,
    type: 'escort',
    content: `订单号: ${row.source_order_no}\n陪诊明细: ${row.pzr_detail_id}\n陪诊人员: ${row.pzr || '未填写'}\n服务日期: ${serviceDate}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 陪诊${batchLabel}短信未按时发送（${reason}），系统不会补发，请及时人工联系陪诊人员！`,
    dedupeKey: `auto:escort_sms_failed:${row.source_order_no}:${batchType}:${row.pzr_detail_id}:${sendYmd}`,
    logger,
    extra: { failureReason: reason, batchType, pzr: row.pzr, pzrDetailId: row.pzr_detail_id, serviceDate, smsNotSent: true }
  })
}

/**
 * 场景 2.2-A：【陪诊】前一天 11:00 使用已配置模板发送出工确认短信
 * 逻辑：
 * 1. 每天 11:00 定点扫描明日出工的陪诊订单（白名单服务类型）；
 * 2. 解析陪诊人员手机号，调用阿里云 SendSms 接口下发短信，参数为 { orderNo: source_order_no }；
 * 3. 发送成功：记录流水表 fact_hy_pz_sms_logs (status = 'success')，静默等待反馈，不打扰客户经理；
 * 4. 发送失败（或未找到手机号）：记录流水表 (status = 'failed')，并【立即向责任客户经理报警】，通知人工及时介入！
 */
async function sendPreDayEscortSms(prisma: PrismaClient, logger?: LoggerLike, allowSend = true): Promise<void> {
  const { ymd, hours, minutes } = shanghaiNowParts()
  if (hours < 11) return // 11:00 前不执行

  const smsConfig = await getSmsConfig(prisma)
  const inSendWindow = hours === 11 && minutes === 0
  const templateCode = smsConfig.templatePreDay.trim()
  const canSend = allowSend && inSendWindow && smsConfig.enabled && smsConfig.templatesConfigured && Boolean(smsConfig.accessKeyId && smsConfig.accessKeySecret && templateCode)

  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000)
  const tomorrowYmd = formatYmd(tomorrow)
  const signName = smsConfig.signName || '寰宇医道'

  const preDayOrders = await queryInPages(prisma, `
    SELECT 
      o.id AS order_id, o.source_order_no, o.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id,
      op.service_type,
      p."ZJ" AS pzr_detail_id, NULLIF(TRIM(p."PZR"), '') AS pzr,
      ${FORMAL_ESCORT_DATE_YMD} AS service_date
    FROM orders o
    JOIN b_order_operations op ON op.order_id = o.id
    ${FORMAL_ESCORT_JOINS}
    WHERE o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
      AND op.service_type IN ('全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '检查加急', '住院')
      AND EXISTS (
        SELECT 1 FROM b_order_service_steps cstep
        WHERE cstep.operation_id = op.id
          AND cstep.step_code IN ('escort', 'check_companion', 'hospital_companion', 'revisit_escort')
          AND cstep.step_status IN ('pending', 'in_progress')
      )
      AND ${FORMAL_ESCORT_DATE_YMD} = $1
      AND NULLIF(TRIM(p."PZR"), '') IS NOT NULL
    ORDER BY o.created_at ASC, o.id ASC, p."ZJ" ASC
  `, tomorrowYmd)

  for (const row of preDayOrders) {
    try {
    if (!row.assigned_employee_id || !row.source_order_no) continue

    if (!(await claimEscortSmsSend(prisma, row.source_order_no, 'pre_day', ymd, row.pzr, tomorrowYmd, row.pzr_detail_id))) {
      continue
    }

    if (!canSend) {
      const reason = !allowSend || !inSendWindow
        ? '已错过前一天 11:00 发送时点'
        : !smsConfig.templatesConfigured ? '前一天和当天短信模板未配置完整' : '短信功能未启用或密钥未配置'
      await recordSkippedEscortSms(prisma, row, 'pre_day', ymd, tomorrowYmd, templateCode, signName, reason, logger)
      continue
    }

    const phone = await resolveEscortPhone(prisma, row.pzr)
    const cleanPhone = (phone || '').replace(/\D/g, '')

    if (cleanPhone && cleanPhone.length === 11) {
      const result = await sendAliyunSms({
        phoneNumbers: cleanPhone,
        signName,
        templateCode,
        templateParam: { orderNo: row.source_order_no }
      }, smsConfig)

      if (result.success) {
        await prisma.$executeRawUnsafe(`
          INSERT INTO "fact_hy_pz_sms_logs" (
            order_no, batch_type, phone, pzr_name, service_date, template_code, sign_name,
            params_json, biz_id, request_id, status, send_ymd, created_at
          ) VALUES ($1, 'pre_day', $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'success', $10, NOW());
        `, row.source_order_no, cleanPhone, row.pzr, tomorrowYmd, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no, pzrDetailId: row.pzr_detail_id }), result.bizId, result.requestId, ymd)
        await finishEscortSmsClaim(prisma, row.source_order_no, 'pre_day', ymd, 'sent', null, row.pzr_detail_id)
        await closeReminderByKey(prisma, `auto:escort_sms_failed:${row.source_order_no}:pre_day:${row.pzr_detail_id}:${ymd}`)

        logger?.info(`[orderReminderSchedule] 前一天出工确认短信发送成功: 订单 ${row.source_order_no}, 手机 ${cleanPhone}, bizId=${result.bizId}`)
      } else {
        await prisma.$executeRawUnsafe(`
          INSERT INTO "fact_hy_pz_sms_logs" (
            order_no, batch_type, phone, pzr_name, service_date, template_code, sign_name,
            params_json, request_id, status, error_code, error_message, send_ymd, created_at
          ) VALUES ($1, 'pre_day', $2, $3, $4, $5, $6, $7::jsonb, $8, 'failed', $9, $10, $11, NOW());
        `, row.source_order_no, cleanPhone, row.pzr, tomorrowYmd, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no, pzrDetailId: row.pzr_detail_id }), result.requestId, result.code, result.message, ymd)
        await finishEscortSmsClaim(prisma, row.source_order_no, 'pre_day', ymd, 'failed', result.message, row.pzr_detail_id)

        logger?.warn(`[orderReminderSchedule] 前一天出工确认短信发送失败: 订单 ${row.source_order_no}, 错误: ${result.message}`)

        const dedupeKey = `auto:escort_sms_failed:${row.source_order_no}:pre_day:${row.pzr_detail_id}:${ymd}`
        const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 陪诊出工确认短信发送失败（原因：${result.message}），请及时人工联系陪诊人员！`

        await createReminderIfAbsent(prisma, {
          orderNo: row.source_order_no,
          employeeId: row.assigned_employee_id,
          type: 'escort',
          content,
          dedupeKey,
          logger,
          extra: { failureReason: result.message, phone: cleanPhone, pzr: row.pzr, pzrDetailId: row.pzr_detail_id, batchType: 'pre_day', serviceDate: tomorrowYmd }
        })
      }
    } else {
      await prisma.$executeRawUnsafe(`
        INSERT INTO "fact_hy_pz_sms_logs" (
          order_no, batch_type, pzr_name, service_date, template_code, sign_name,
          params_json, status, error_code, error_message, send_ymd, created_at
        ) VALUES ($1, 'pre_day', $2, $3, $4, $5, $6::jsonb, 'failed', 'NO_PHONE', '未配置有效陪诊人员手机号', $7, NOW());
      `, row.source_order_no, row.pzr, tomorrowYmd, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no, pzrDetailId: row.pzr_detail_id }), ymd)
      await finishEscortSmsClaim(prisma, row.source_order_no, 'pre_day', ymd, 'failed', '未配置有效陪诊人员手机号', row.pzr_detail_id)

      logger?.warn(`[orderReminderSchedule] 前一天出工短信未发送：未找到陪诊人手机号: 订单 ${row.source_order_no}, 陪诊人 ${row.pzr}`)

      const dedupeKey = `auto:escort_sms_failed:${row.source_order_no}:pre_day:${row.pzr_detail_id}:${ymd}`
      const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 未找到陪诊人员有效手机号，出工确认短信无法发送，请及时人工联系陪诊人员！`

      await createReminderIfAbsent(prisma, {
        orderNo: row.source_order_no,
        employeeId: row.assigned_employee_id,
        type: 'escort',
        content,
        dedupeKey,
        logger,
        extra: { failureReason: '未配置有效陪诊人员手机号', pzr: row.pzr, pzrDetailId: row.pzr_detail_id, batchType: 'pre_day', serviceDate: tomorrowYmd }
      })
    }
    } catch (err: any) {
      const reason = String(err?.message || err || '短信任务异常')
      logger?.error(`[orderReminderSchedule] 前一天短信订单处理异常: ${row.source_order_no}`, err)
      const logged = await prisma.$queryRawUnsafe<any[]>(`SELECT status FROM "fact_hy_pz_sms_logs" WHERE order_no = $1 AND batch_type = 'pre_day' AND send_ymd = $2 AND params_json->>'pzrDetailId' = $3 ORDER BY id DESC LIMIT 1;`, row.source_order_no, ymd, row.pzr_detail_id).catch(() => [])
      if (logged[0]?.status === 'success') {
        await finishEscortSmsClaim(prisma, row.source_order_no, 'pre_day', ymd, 'sent', null, row.pzr_detail_id).catch(() => {})
        continue
      }
      await finishEscortSmsClaim(prisma, row.source_order_no, 'pre_day', ymd, 'unknown', reason, row.pzr_detail_id).catch(() => {})
      if (row.assigned_employee_id && row.source_order_no) {
        await createReminderIfAbsent(prisma, {
          orderNo: row.source_order_no,
          employeeId: row.assigned_employee_id,
          type: 'escort',
          content: `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 前一天陪诊短信任务异常，发送结果可能未知，系统不会补发，请人工确认是否需要联系陪诊人员。`,
          dedupeKey: `auto:escort_sms_failed:${row.source_order_no}:pre_day:${row.pzr_detail_id}:${ymd}`,
          logger,
          extra: { failureReason: reason, batchType: 'pre_day', pzr: row.pzr, pzrDetailId: row.pzr_detail_id, serviceDate: tomorrowYmd }
        })
      }
    }
  }
}

/**
 * 场景 2.3-A：【陪诊】当天 07:00 使用已配置模板发送出工打卡短信
 * 逻辑：
 * 1. 每天 07:00 定点扫描当天出工的陪诊订单（白名单服务类型）；
 * 2. 下发打卡短信；成功记录流水，失败立即报警通知客户经理。
 */
async function sendSameDayEscortSms(prisma: PrismaClient, logger?: LoggerLike, allowSend = true): Promise<void> {
  const { ymd, hours, minutes } = shanghaiNowParts()
  if (hours < 7) return // 07:00 前不执行

  const smsConfig = await getSmsConfig(prisma)
  const inSendWindow = hours === 7 && minutes === 0
  const templateCode = smsConfig.templateSameDay.trim()
  const canSend = allowSend && inSendWindow && smsConfig.enabled && smsConfig.templatesConfigured && Boolean(smsConfig.accessKeyId && smsConfig.accessKeySecret && templateCode)

  const signName = smsConfig.signName || '寰宇医道'

  const sameDayOrders = await queryInPages(prisma, `
    SELECT 
      o.id AS order_id, o.source_order_no, o.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id,
      op.service_type,
      p."ZJ" AS pzr_detail_id, NULLIF(TRIM(p."PZR"), '') AS pzr,
      ${FORMAL_ESCORT_DATE_YMD} AS service_date
    FROM orders o
    JOIN b_order_operations op ON op.order_id = o.id
    ${FORMAL_ESCORT_JOINS}
    WHERE o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
      AND op.service_type IN ('全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '检查加急', '住院')
      AND EXISTS (
        SELECT 1 FROM b_order_service_steps cstep
        WHERE cstep.operation_id = op.id
          AND cstep.step_code IN ('escort', 'check_companion', 'hospital_companion', 'revisit_escort')
          AND cstep.step_status IN ('pending', 'in_progress')
      )
      AND ${FORMAL_ESCORT_DATE_YMD} = $1
      AND NULLIF(TRIM(p."PZR"), '') IS NOT NULL
    ORDER BY o.created_at ASC, o.id ASC, p."ZJ" ASC
  `, ymd)

  for (const row of sameDayOrders) {
    try {
    if (!row.assigned_employee_id || !row.source_order_no) continue

    if (!(await claimEscortSmsSend(prisma, row.source_order_no, 'same_day', ymd, row.pzr, ymd, row.pzr_detail_id))) {
      continue
    }

    if (!canSend) {
      const reason = !allowSend || !inSendWindow
        ? '已错过当天 07:00 发送时点'
        : !smsConfig.templatesConfigured ? '前一天和当天短信模板未配置完整' : '短信功能未启用或密钥未配置'
      await recordSkippedEscortSms(prisma, row, 'same_day', ymd, ymd, templateCode, signName, reason, logger)
      continue
    }

    const phone = await resolveEscortPhone(prisma, row.pzr)
    const cleanPhone = (phone || '').replace(/\D/g, '')

    if (cleanPhone && cleanPhone.length === 11) {
      const result = await sendAliyunSms({
        phoneNumbers: cleanPhone,
        signName,
        templateCode,
        templateParam: { orderNo: row.source_order_no }
      }, smsConfig)

      if (result.success) {
        await prisma.$executeRawUnsafe(`
          INSERT INTO "fact_hy_pz_sms_logs" (
            order_no, batch_type, phone, pzr_name, service_date, template_code, sign_name,
            params_json, biz_id, request_id, status, send_ymd, created_at
          ) VALUES ($1, 'same_day', $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'success', $10, NOW());
        `, row.source_order_no, cleanPhone, row.pzr, ymd, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no, pzrDetailId: row.pzr_detail_id }), result.bizId, result.requestId, ymd)
        await finishEscortSmsClaim(prisma, row.source_order_no, 'same_day', ymd, 'sent', null, row.pzr_detail_id)
        await closeReminderByKey(prisma, `auto:escort_sms_failed:${row.source_order_no}:same_day:${row.pzr_detail_id}:${ymd}`)

        logger?.info(`[orderReminderSchedule] 当日出工打卡短信发送成功: 订单 ${row.source_order_no}, 手机 ${cleanPhone}, bizId=${result.bizId}`)
      } else {
        await prisma.$executeRawUnsafe(`
          INSERT INTO "fact_hy_pz_sms_logs" (
            order_no, batch_type, phone, pzr_name, service_date, template_code, sign_name,
            params_json, request_id, status, error_code, error_message, send_ymd, created_at
          ) VALUES ($1, 'same_day', $2, $3, $4, $5, $6, $7::jsonb, $8, 'failed', $9, $10, $11, NOW());
        `, row.source_order_no, cleanPhone, row.pzr, ymd, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no, pzrDetailId: row.pzr_detail_id }), result.requestId, result.code, result.message, ymd)
        await finishEscortSmsClaim(prisma, row.source_order_no, 'same_day', ymd, 'failed', result.message, row.pzr_detail_id)

        logger?.warn(`[orderReminderSchedule] 当日出工打卡短信发送失败: 订单 ${row.source_order_no}, 错误: ${result.message}`)

        const dedupeKey = `auto:escort_sms_failed:${row.source_order_no}:same_day:${row.pzr_detail_id}:${ymd}`
        const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 陪诊当日出工打卡短信发送失败（原因：${result.message}），请紧急人工联系陪诊人员！`

        await createReminderIfAbsent(prisma, {
          orderNo: row.source_order_no,
          employeeId: row.assigned_employee_id,
          type: 'escort',
          content,
          dedupeKey,
          logger,
          extra: { failureReason: result.message, phone: cleanPhone, pzr: row.pzr, pzrDetailId: row.pzr_detail_id, batchType: 'same_day', serviceDate: ymd }
        })
      }
    } else {
      await prisma.$executeRawUnsafe(`
        INSERT INTO "fact_hy_pz_sms_logs" (
          order_no, batch_type, pzr_name, service_date, template_code, sign_name,
          params_json, status, error_code, error_message, send_ymd, created_at
        ) VALUES ($1, 'same_day', $2, $3, $4, $5, $6::jsonb, 'failed', 'NO_PHONE', '未配置有效陪诊人员手机号', $7, NOW());
      `, row.source_order_no, row.pzr, ymd, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no, pzrDetailId: row.pzr_detail_id }), ymd)
      await finishEscortSmsClaim(prisma, row.source_order_no, 'same_day', ymd, 'failed', '未配置有效陪诊人员手机号', row.pzr_detail_id)

      logger?.warn(`[orderReminderSchedule] 当日出工短信未发送：未找到陪诊人手机号: 订单 ${row.source_order_no}, 陪诊人 ${row.pzr}`)

      const dedupeKey = `auto:escort_sms_failed:${row.source_order_no}:same_day:${row.pzr_detail_id}:${ymd}`
      const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 未找到陪诊人员有效手机号，当日出工打卡短信无法发送，请紧急人工联系陪诊人员！`

      await createReminderIfAbsent(prisma, {
        orderNo: row.source_order_no,
        employeeId: row.assigned_employee_id,
        type: 'escort',
        content,
        dedupeKey,
        logger,
        extra: { failureReason: '未配置有效陪诊人员手机号', pzr: row.pzr, pzrDetailId: row.pzr_detail_id, batchType: 'same_day', serviceDate: ymd }
      })
    }
    } catch (err: any) {
      const reason = String(err?.message || err || '短信任务异常')
      logger?.error(`[orderReminderSchedule] 当天短信订单处理异常: ${row.source_order_no}`, err)
      const logged = await prisma.$queryRawUnsafe<any[]>(`SELECT status FROM "fact_hy_pz_sms_logs" WHERE order_no = $1 AND batch_type = 'same_day' AND send_ymd = $2 AND params_json->>'pzrDetailId' = $3 ORDER BY id DESC LIMIT 1;`, row.source_order_no, ymd, row.pzr_detail_id).catch(() => [])
      if (logged[0]?.status === 'success') {
        await finishEscortSmsClaim(prisma, row.source_order_no, 'same_day', ymd, 'sent', null, row.pzr_detail_id).catch(() => {})
        continue
      }
      await finishEscortSmsClaim(prisma, row.source_order_no, 'same_day', ymd, 'unknown', reason, row.pzr_detail_id).catch(() => {})
      if (row.assigned_employee_id && row.source_order_no) {
        await createReminderIfAbsent(prisma, {
          orderNo: row.source_order_no,
          employeeId: row.assigned_employee_id,
          type: 'escort',
          content: `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 当天陪诊短信任务异常，发送结果可能未知，系统不会补发，请人工确认是否需要联系陪诊人员。`,
          dedupeKey: `auto:escort_sms_failed:${row.source_order_no}:same_day:${row.pzr_detail_id}:${ymd}`,
          logger,
          extra: { failureReason: reason, batchType: 'same_day', pzr: row.pzr, pzrDetailId: row.pzr_detail_id, serviceDate: ymd }
        })
      }
    }
  }
}

/**
 * 场景 2.2-B & 2.3-B：【陪诊】前一天出工反馈监控（13:00）与当天防迟到出工监控（07:20）
 * 核心门禁：
 * 1. 绝不取 HY_FACT_DDCX_NEW.PZR
 * 2. 仅使用正式陪诊信息；未确认的 AI 候选不作为短信对象或反馈监控对象
 * 3. 严格限定白名单服务类型，排除住院护工协助等非陪诊订单
 * 4. 【关键门禁】：未反馈提醒仅在今天成功发送过对应批次短信的前提下才触发！未发短信或发送失败（已报警）绝不重复误报！
 */
export async function scanEscortDailyCheckReminders(prisma: PrismaClient, logger?: LoggerLike, now = new Date()): Promise<void> {
  const { ymd, time, hours, minutes } = shanghaiNowParts(now)
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000)
  const tomorrowYmd = formatYmd(tomorrow)

  // 1. 场景 2.2：前一天出工确认（11:00 发短信，13:00 检查未反馈或异常反馈）
  const preDayOrders = await queryInPages(prisma, `
    SELECT 
      o.id AS order_id, o.source_order_no, o.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id,
      op.service_type,
      p."ZJ" AS pzr_detail_id, NULLIF(TRIM(p."PZR"), '') AS pzr,
      ${FORMAL_ESCORT_DATE_YMD} AS service_date
    FROM orders o
    JOIN b_order_operations op ON op.order_id = o.id
    ${FORMAL_ESCORT_JOINS}
    WHERE o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
      AND op.service_type IN ('全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '检查加急', '住院')
      AND EXISTS (
        SELECT 1 FROM b_order_service_steps cstep
        WHERE cstep.operation_id = op.id
          AND cstep.step_code IN ('escort', 'check_companion', 'hospital_companion', 'revisit_escort')
          AND cstep.step_status IN ('pending', 'in_progress')
      )
      AND ${FORMAL_ESCORT_DATE_YMD} = $1
      AND NULLIF(TRIM(p."PZR"), '') IS NOT NULL
    ORDER BY o.created_at ASC, o.id ASC, p."ZJ" ASC
  `, tomorrowYmd)

  for (const row of preDayOrders) {
    // 检查 fact_hy_pzfk 表中的前一天反馈
    const feedbackList = await prisma.$queryRawUnsafe<any[]>(`
      SELECT will_attend, remark, created_at
      FROM "fact_hy_pzfk" 
      WHERE (ddbh = $1 OR ddbh = $2) 
        AND feedback_type = 'pre_day' 
        AND pzr_id = $3 AND service_date = $4 AND pzr_detail_id = $5
        AND created_at >= ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::timestamp AT TIME ZONE 'Asia/Shanghai')
      ORDER BY created_at DESC 
      LIMIT 1;
    `, row.source_order_no, row.huanyu_order_no || '', row.pzr, tomorrowYmd, row.pzr_detail_id)

    const feedback = feedbackList[0]

    // 情况 A：已提交但反馈【无法出工（不去）】，立即报警
    if (feedback && feedback.will_attend === false) {
      await closeReminderByKey(prisma, `auto:escort_pre_day_unack:${row.source_order_no}:${row.pzr_detail_id}:${ymd}`)
      await createEscortRejectReminder(prisma, row, {
        feedbackType: 'pre_day',
        ymd,
        serviceDate: tomorrowYmd,
        remark: feedback.remark,
        logger
      })
      continue
    }

    // 情况 B：已提交且确认出工，正常通过，无需提醒
    if (feedback && feedback.will_attend === true) {
      await closeReminderByKey(prisma, `auto:escort_pre_day_unack:${row.source_order_no}:${row.pzr_detail_id}:${ymd}`)
      await closeReminderByKey(prisma, `auto:escort_pre_day_reject:${row.source_order_no}:${row.pzr_detail_id}:${ymd}`)
      continue
    }

    // 旧快照的反馈没有陪诊人和服务日期，不能抵消当前批次的未反馈提醒。
    if (hours >= 13) {
      // 强前置门禁：必须检查今天是否向该陪诊员成功发送过前一天出工短信！
      const smsLog = await prisma.$queryRawUnsafe<any[]>(`
        SELECT 1 FROM "fact_hy_pz_sms_send_claims"
        WHERE order_no = $1 AND batch_type = 'pre_day' AND send_ymd = $2 AND status = 'sent'
          AND pzr_id = $3 AND service_date = $4 AND pzr_detail_id = $5
        LIMIT 1;
      `, row.source_order_no, ymd, row.pzr, tomorrowYmd, row.pzr_detail_id)

      if (!smsLog || smsLog.length === 0) {
        // 未发送短信或发送失败（发送失败已在 11:00 报警过），绝不报未反馈假提醒
        continue
      }

      const dedupeKey = `auto:escort_pre_day_unack:${row.source_order_no}:${row.pzr_detail_id}:${ymd}`
      const content = `订单号: ${row.source_order_no}\n陪诊明细: ${row.pzr_detail_id}\n陪诊人员: ${row.pzr}\n服务日期: ${tomorrowYmd}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 陪诊人员没有第一次反馈信息，请关注！`

      await createReminderIfAbsent(prisma, {
        orderNo: row.source_order_no,
        employeeId: row.assigned_employee_id,
        type: 'escort',
        content,
        dedupeKey,
        logger,
        extra: { serviceDate: tomorrowYmd, pzr: row.pzr, pzrDetailId: row.pzr_detail_id }
      })
    }
  }

  // 2. 场景 2.3：当天防迟到出工（07:00 发短信，07:20 检查未反馈或异常反馈）
  const isAfter720 = hours > 7 || (hours === 7 && minutes >= 20)
  const sameDayOrders = await queryInPages(prisma, `
    SELECT 
      o.id AS order_id, o.source_order_no, o.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id,
      op.service_type,
      p."ZJ" AS pzr_detail_id, NULLIF(TRIM(p."PZR"), '') AS pzr,
      ${FORMAL_ESCORT_DATE_YMD} AS service_date
    FROM orders o
    JOIN b_order_operations op ON op.order_id = o.id
    ${FORMAL_ESCORT_JOINS}
    WHERE o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
      AND op.service_type IN ('全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '检查加急', '住院')
      AND EXISTS (
        SELECT 1 FROM b_order_service_steps cstep
        WHERE cstep.operation_id = op.id
          AND cstep.step_code IN ('escort', 'check_companion', 'hospital_companion', 'revisit_escort')
          AND cstep.step_status IN ('pending', 'in_progress')
      )
      AND ${FORMAL_ESCORT_DATE_YMD} = $1
      AND NULLIF(TRIM(p."PZR"), '') IS NOT NULL
    ORDER BY o.created_at ASC, o.id ASC, p."ZJ" ASC
  `, ymd)

  for (const row of sameDayOrders) {
    const feedbackList = await prisma.$queryRawUnsafe<any[]>(`
      SELECT will_attend, remark, created_at 
      FROM "fact_hy_pzfk" 
      WHERE (ddbh = $1 OR ddbh = $2) 
        AND feedback_type = 'same_day' 
        AND pzr_id = $3 AND service_date = $4 AND pzr_detail_id = $5
        AND created_at >= ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::timestamp AT TIME ZONE 'Asia/Shanghai')
      ORDER BY created_at DESC 
      LIMIT 1;
    `, row.source_order_no, row.huanyu_order_no || '', row.pzr, ymd, row.pzr_detail_id)

    const feedback = feedbackList[0]

    // 情况 A：当天反馈【无法出工（不去）】，立即报警
    if (feedback && feedback.will_attend === false) {
      await closeReminderByKey(prisma, `auto:escort_same_day_unack:${row.source_order_no}:${row.pzr_detail_id}:${ymd}`)
      await createEscortRejectReminder(prisma, row, {
        feedbackType: 'same_day',
        ymd,
        serviceDate: ymd,
        remark: feedback.remark,
        time,
        logger
      })
      continue
    }

    // 情况 B：已反馈确认出工，正常通过
    if (feedback && feedback.will_attend === true) {
      await closeReminderByKey(prisma, `auto:escort_same_day_unack:${row.source_order_no}:${row.pzr_detail_id}:${ymd}`)
      await closeReminderByKey(prisma, `auto:escort_same_day_reject:${row.source_order_no}:${row.pzr_detail_id}:${ymd}`)
      continue
    }

    // 情况 C：07:20 后未收到当天反馈
    if (isAfter720) {
      // 强前置门禁：必须检查今天是否向该陪诊员成功发送过当日出工打卡短信！
      const smsLog = await prisma.$queryRawUnsafe<any[]>(`
        SELECT 1 FROM "fact_hy_pz_sms_send_claims"
        WHERE order_no = $1 AND batch_type = 'same_day' AND send_ymd = $2 AND status = 'sent'
          AND pzr_id = $3 AND service_date = $4 AND pzr_detail_id = $5
        LIMIT 1;
      `, row.source_order_no, ymd, row.pzr, ymd, row.pzr_detail_id)

      if (!smsLog || smsLog.length === 0) {
        continue
      }

      const dedupeKey = `auto:escort_same_day_unack:${row.source_order_no}:${row.pzr_detail_id}:${ymd}`
      const content = `订单号: ${row.source_order_no}\n陪诊明细: ${row.pzr_detail_id}\n陪诊人员: ${row.pzr}\n服务日期: ${ymd}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 陪诊人员没有第一次反馈信息，请关注！`

      await createReminderIfAbsent(prisma, {
        orderNo: row.source_order_no,
        employeeId: row.assigned_employee_id,
        type: 'escort',
        content,
        dedupeKey,
        logger,
        extra: { serviceDate: ymd, triggerTime: time, pzr: row.pzr, pzrDetailId: row.pzr_detail_id }
      })
    }
  }
}

/**
 * 场景 3.1 & 3.2：【住院陪护】确认护工开始时间与结束前提醒
 */
export async function scanHospitalCareReminders(prisma: PrismaClient, logger?: LoggerLike, now = new Date()): Promise<void> {
  const { ymd, hours } = shanghaiNowParts(now)

  const careOrders = await queryInPages(prisma, `
    SELECT 
      o.id AS order_id, o.source_order_no, o.created_at AS order_created_at, o.assigned_employee_id, o.status AS order_status,
      op.service_type,
      h."BBQ_FW" AS care_start_time, h."DATE_FW" AS care_start_date,
      h."BBQ_QDFW" AS care_end_time, h."DATE_QDFW" AS care_end_date,
      s.id AS care_step_id, s.occurrence_no, s.activated_at AS care_activated_at
    FROM orders o
    JOIN b_order_operations op ON op.order_id = o.id
    JOIN b_order_service_steps s ON s.operation_id = op.id AND s.step_code = 'hospital_care' AND s.step_status IN ('pending', 'in_progress')
    LEFT JOIN "HY_FACT_DDCX_NEW" h ON (h."BDQD_DDBH" = o.source_order_no OR (o.huanyu_order_no IS NOT NULL AND h."DDBH" = o.huanyu_order_no))
    WHERE op.service_type = '住院护工协助'
      AND o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
    ORDER BY o.id ASC, s.occurrence_no DESC NULLS LAST, s.id DESC
  `)

  const seenCareOrders = new Set<string>()
  for (const row of careOrders) {
    if (!row.assigned_employee_id || !row.source_order_no) continue
    if (seenCareOrders.has(row.source_order_no)) continue
    seenCareOrders.add(row.source_order_no)

    const hasStartTime = Boolean(
      (row.care_start_time && String(row.care_start_time).trim()) ||
      (row.care_start_date && String(row.care_start_date).trim())
    )

    // 3.1 尚未确定护工开始时间：每 2 天上午 09:00 提醒
    if (!hasStartTime) {
      const baseTime = row.care_activated_at || row.order_created_at
      if (baseTime) {
        const cycleIdentity = `${row.care_step_id}:${row.occurrence_no ?? 0}:${new Date(baseTime).toISOString()}`
        const dedupeKey = `auto:care_start_unassigned:${row.source_order_no}`
        await closeStalePeriodicCycle(prisma, dedupeKey, cycleIdentity)
        const diffDays = shanghaiCalendarDayDiff(baseTime, ymd)

        if (hours >= 9 && diffDays >= 2 && diffDays % 2 === 0) {
          const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 护工开始时间尚未确定，请跟进确认！`

          await upsertPeriodicReminder(prisma, {
            orderNo: row.source_order_no,
            employeeId: row.assigned_employee_id,
            type: 'hospital_care',
            content,
            dedupeKey,
            occurrence: Math.floor(diffDays / 2),
            logger,
            extra: { diffDays, cycleIdentity }
          })
        }
      }
    }

    // 3.2 护工结束前 2 个工作日提醒（扣除节假日）
    const endTimeRaw = row.care_end_time || row.care_end_date
    const serviceYmd = normalizeYmdValue(endTimeRaw)
    if (serviceYmd) {
        const [year, month, day] = serviceYmd.split('-').map(Number)
        const endDate = new Date(year, month - 1, day)
        const { ymd: targetRemindYmd } = subtractWorkdays(endDate, 2)
        const dedupeKey = `auto:care_end_notify:${row.source_order_no}:${serviceYmd}`
        await closeReminderKeysExcept(prisma, `auto:care_end_notify:${row.source_order_no}:`, dedupeKey, 'superseded')

        if (hours >= 9 && ymd === targetRemindYmd && ymd <= serviceYmd) {
          const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 客户出院时间到了，请关注客户后续行程！`

          await createReminderIfAbsent(prisma, {
            orderNo: row.source_order_no,
            employeeId: row.assigned_employee_id,
            type: 'hospital_care',
            content,
            dedupeKey,
            logger,
            extra: { careEndDate: serviceYmd, serviceDate: serviceYmd }
          })
        }
    } else {
      await closeReminderKeysExcept(prisma, `auto:care_end_notify:${row.source_order_no}:`, null, 'expired')
    }
  }
}

/**
 * 场景 0：【通话录音与通话记录上传提醒】（默认每天 11:30 和 17:30 提醒所有在职员工）
 */
async function scanDailyCallUploadReminders(prisma: PrismaClient, logger?: LoggerLike): Promise<void> {
  const { ymd, hours, minutes } = shanghaiNowParts()
  let slot: string | null = null

  // 11:30 触发上午时段批次
  if (hours === 11 && minutes >= 30) {
    slot = '1130'
  } else if (hours === 17 && minutes >= 30) {
    // 17:30 触发下午时段批次
    slot = '1730'
  }

  if (!slot) return

  try {
    const employees = await prisma.employee.findMany({
      where: { enabled: 1 },
      select: { id: true, name: true }
    })

    const content = '请打开手机app上传通话录音和通话记录'

    for (const emp of employees) {
      const dedupeKey = `auto:call_upload_reminder:${emp.id}:${ymd}:${slot}`
      await createReminderIfAbsent(prisma, {
        orderNo: 'SYSTEM',
        employeeId: emp.id,
        type: 'upload_recording',
        content,
        dedupeKey,
        logger,
        extra: { slot, reminderType: 'call_upload_reminder', employeeName: emp.name }
      })
    }
  } catch (err) {
    logger?.error('[orderReminderSchedule] 通话录音上传提醒扫描异常:', err)
  }
}

/**
 * 清理过期的日常录音上传提醒：每个批次只在自己的有效时段内有效，错过后不补弹。
 */
async function expirePastDailyUploadReminders(prisma: PrismaClient, logger?: LoggerLike): Promise<void> {
  try {
    const expiredCount = await (prisma as any).$executeRawUnsafe(`
      UPDATE order_reminders
         SET status = 'expired', updated_at = NOW()
       WHERE type = 'upload_recording'
         AND status IN ('pending', 'unread')
         AND (
           remind_time < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
           OR (
             COALESCE(extra_data->>'snoozed', 'false') != 'true'
             AND (
               (extra_data->>'slot' = '1130'
                 AND (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::time >= TIME '12:00')
               OR (extra_data->>'slot' = '1730'
                 AND (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::time >= TIME '18:00')
             )
           )
         );
    `)
    if (expiredCount > 0) {
      logger?.info(`[orderReminderSchedule] 已自动失效 ${expiredCount} 条过期的日常录音上传提醒`)
    }
  } catch (err) {
    logger?.error('[orderReminderSchedule] 跨天日常提醒失效处理异常:', err)
  }
}

/**
 * 单次扫描总入口
 */
export async function runOrderReminderCycle(prisma: PrismaClient, logger?: LoggerLike): Promise<void> {
  if (isRunning) return
  isRunning = true
  try {
    const tasks: Array<[string, () => Promise<void>]> = [
      ['上传提醒过期清理', () => expirePastDailyUploadReminders(prisma, logger)],
      ['日常上传提醒', () => scanDailyCallUploadReminders(prisma, logger)],
      ['约住院提醒', () => scanHospitalBookingReminders(prisma, logger)],
      ['陪诊未落实提醒', () => scanEscortUnassignedReminders(prisma, logger)],
      ['陪诊反馈提醒', () => scanEscortDailyCheckReminders(prisma, logger)],
      ['住院护工提醒', () => scanHospitalCareReminders(prisma, logger)],
      ['提醒生命周期清理', () => reconcileReminderLifecycle(prisma, logger)],
      ['短信任务恢复检查', () => reconcileStaleSmsClaims(prisma, logger)]
    ]
    for (const [name, task] of tasks) {
      try {
        await task()
      } catch (err) {
        logger?.error(`[orderReminderSchedule] ${name}执行异常:`, err)
      }
    }
  } finally {
    isRunning = false
  }
}

/**
 * 启动后台常驻定时扫描
 */
export function startOrderReminderSchedule(prisma: PrismaClient, logger?: LoggerLike): void {
  if (timer) clearInterval(timer)
  for (const smsTimer of Object.values(smsTimers)) {
    if (smsTimer) clearTimeout(smsTimer)
  }
  smsScheduleGeneration += 1
  delete smsTimers.pre_day
  delete smsTimers.same_day

  logger?.info('[orderReminderSchedule] 订单自动提醒扫描任务已启动，轮询周期: 15秒；短信按每日定点单次触发')
  const now = shanghaiNowParts()
  // 定时点已过时只登记未按时执行并通知人工，不补发过期短信。
  if (now.hours === 11 && now.minutes === 0) {
    void sendPreDayEscortSms(prisma, logger, true).catch((err) =>
      logger?.error('[orderReminderSchedule] 执行前一天短信批次失败:', err)
    )
  } else if (now.hours > 11 || (now.hours === 11 && now.minutes > 0)) {
    void sendPreDayEscortSms(prisma, logger, false).catch((err) =>
      logger?.error('[orderReminderSchedule] 登记前一天短信错过批次失败:', err)
    )
  }
  if (now.hours === 7 && now.minutes === 0) {
    void sendSameDayEscortSms(prisma, logger, true).catch((err) =>
      logger?.error('[orderReminderSchedule] 执行当天短信批次失败:', err)
    )
  } else if (now.hours > 7 || (now.hours === 7 && now.minutes > 0)) {
    void sendSameDayEscortSms(prisma, logger, false).catch((err) =>
      logger?.error('[orderReminderSchedule] 登记当天短信错过批次失败:', err)
    )
  }
  scheduleSmsRun(prisma, logger, 'pre_day', 11, smsScheduleGeneration)
  scheduleSmsRun(prisma, logger, 'same_day', 7, smsScheduleGeneration)

  // 启动即执行一轮
  void runOrderReminderCycle(prisma, logger)

  timer = setInterval(() => {
    void runOrderReminderCycle(prisma, logger)
  }, CHECK_INTERVAL_MS)
}

export function stopOrderReminderSchedule(): void {
  smsScheduleGeneration += 1
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  for (const smsTimer of Object.values(smsTimers)) {
    if (smsTimer) clearTimeout(smsTimer)
  }
  delete smsTimers.pre_day
  delete smsTimers.same_day
}
