/**
 * 寰宇系统订单自动提醒调度任务。
 * 负责扫描订单待办与陪诊短信通知：
 * 1. 【约住院】：每 3 天上午 09:00 提醒一次跟进排队；
 * 2.1 【陪诊未指派】：前置步骤完成满 1 小时未指派陪诊人；
 * 2.2 【陪诊前一天未反馈】：前一天 11:00 发短信，13:00 未反馈短信通知客户经理；
 * 2.3 【陪诊当天出工未反馈】：当天 07:00 发短信，07:20 未反馈短信通知客户经理；
 * 3.1 【住院陪护确认护工开始时间】：入院后未定护工时间，每 2 天上午 09:00 提醒；
 * 3.2 【住院陪护结束前提醒】：护工结束日前 2 个工作日（排除周末与节假日）上午 09:00 提醒。
 */

import type { PrismaClient } from '@prisma/client'
import { formatYmd, parseYmdToShanghaiDate, subtractWorkdays } from '../lib/chineseWorkdays.js'
import { sendAliyunSms, getSmsConfig, isSmsTemplateEnabled } from '../services/aliyunSmsService.js'
import { findRemoteReminderOrder, listRemoteEscortReminderDetails } from '../db/remoteDictionary.js'
import { normalizeReminderDate, shouldAdvancePeriodicReminder } from './orderReminderRules.js'
import { parseShanghaiDateTime } from '../time/shanghaiTime.js'

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
  const d = parseShanghaiDateTime(date)
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
  const fromYmd = formatYmd(parseShanghaiDateTime(from))
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
    huanyuOrderNo?: string | null
    employeeId: number
    type: 'hospital_booking' | 'escort' | 'hospital_care' | 'system' | 'upload_recording'
    content: string
    dedupeKey: string
    logger?: LoggerLike
    extra?: Record<string, unknown>
  }
): Promise<boolean> {
  try {
    let huanyuOrderNo = params.huanyuOrderNo || String(params.extra?.huanyuOrderNo ?? '').trim() || null
    if (!huanyuOrderNo && params.orderNo && !['SYSTEM', 'ALL'].includes(params.orderNo)) {
      const linked = await prisma.$queryRawUnsafe<Array<{ huanyu_order_no: string | null }>>(
        `SELECT huanyu_order_no FROM orders WHERE source_order_no = $1 LIMIT 1`, params.orderNo
      )
      huanyuOrderNo = linked[0]?.huanyu_order_no || null
    }
    const dedupeKey = huanyuOrderNo ? `${params.dedupeKey}:hy:${huanyuOrderNo}` : params.dedupeKey
    const existing = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, extra_data->>'pzr' AS pzr, extra_data->>'serviceDate' AS service_date FROM order_reminders WHERE extra_data->>'dedupe_key' = $1 ORDER BY id DESC LIMIT 1;`,
      dedupeKey
    )
    if (existing && existing.length > 0) {
      const current = existing[0]
      const nextPzr = String(params.extra?.pzr ?? '').trim()
      const nextDate = String(params.extra?.serviceDate ?? '').trim()
      if (nextPzr && nextDate && (current.pzr !== nextPzr || current.service_date !== nextDate)) {
        await prisma.$executeRawUnsafe(`
          UPDATE order_reminders SET order_no = $1, huanyu_order_no = $2, employee_id = $3, type = $4, content = $5,
            remind_time = NOW(), status = 'pending', notification_generation = notification_generation + 1,
            extra_data = $6::jsonb, updated_at = NOW()
          WHERE id = $7;
        `, params.orderNo, huanyuOrderNo, params.employeeId, params.type, params.content,
        JSON.stringify({ dedupe_key: dedupeKey, ...(params.extra ?? {}), huanyuOrderNo }), current.id)
        return true
      }
      return false
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO order_reminders (
        order_no, huanyu_order_no, employee_id, type, content, remind_time, status, extra_data, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, NOW(), 'pending', $6::jsonb, NOW(), NOW());`,
      params.orderNo,
      huanyuOrderNo,
      params.employeeId,
      params.type,
      params.content,
      JSON.stringify({ dedupe_key: dedupeKey, ...(params.extra ?? {}), huanyuOrderNo })
    )

    params.logger?.info(`[orderReminderSchedule] 已为员工 ${params.employeeId} 生成提醒: ${dedupeKey}`)
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
  assigned_employee_id?: number | null
  pzr?: string | null
  pzr_detail_id?: string | null
  service_date?: string | null
}

/** 前一天拒单保留系统提醒；当天拒单才短信通知客户经理。 */
async function createEscortRejectReminder(
  prisma: PrismaClient,
  row: EscortRejectReminderRow,
  params: { feedbackType: 'pre_day' | 'same_day'; ymd: string; serviceDate?: string; remark?: string | null; time?: string; logger?: LoggerLike }
): Promise<void> {
  const isPreDay = params.feedbackType === 'pre_day'
  const serviceDate = params.serviceDate ?? (isPreDay ? addShanghaiCalendarDays(params.ymd, 1) : params.ymd)
  if (isPreDay) {
    if (!row.assigned_employee_id) return
    await createReminderIfAbsent(prisma, {
      orderNo: row.source_order_no,
      huanyuOrderNo: row.huanyu_order_no,
      employeeId: row.assigned_employee_id,
      type: 'escort',
      content: `订单号: ${row.source_order_no}\n陪诊人员: ${row.pzr || '未填写'}\n服务日期: ${serviceDate}\n提醒内容: 陪诊人员反馈无法出工，请及时处理！`,
      dedupeKey: `auto:escort_pre_day_reject:${row.source_order_no}:${row.pzr_detail_id || 'unknown'}:${params.ymd}`,
      logger: params.logger,
      extra: { serviceDate, pzr: row.pzr, pzrDetailId: row.pzr_detail_id, willAttend: false, remark: params.remark }
    })
    return
  }
  await notifyManagerEscortException(prisma, {
    orderNo: row.source_order_no,
    huanyuOrderNo: row.huanyu_order_no,
    employeeId: row.assigned_employee_id,
    pzr: row.pzr,
    pzrDetailId: row.pzr_detail_id,
    serviceDate,
    sendYmd: params.ymd,
    batchType: 'mgr_same_reject',
    alertType: '陪诊人员反馈无法出工',
    logger: params.logger,
  })
}

/** 陪诊反馈接口写入“无法出工”后，按对应寰宇订单触发客户经理异常通知。 */
export async function createEscortRejectReminderForFeedback(
  prisma: PrismaClient,
  params: { orderNo: string; pzrDetailId: string; feedbackType: 'pre_day' | 'same_day'; pzrId: string; serviceDate: string; remark?: string | null; logger?: LoggerLike }
): Promise<boolean> {
  const { ymd } = shanghaiNowParts()
  const expectedDate = params.feedbackType === 'pre_day' ? addShanghaiCalendarDays(ymd, 1) : ymd
  const rows = await prisma.$queryRawUnsafe<EscortRejectReminderRow[]>(`
    SELECT o.id AS order_id, o.source_order_no, hs.huanyu_order_no, o.created_at AS order_created_at,
           o.assigned_employee_id
    FROM orders o
    JOIN b_order_huanyu_services hs ON hs.order_id = o.id
    WHERE (o.source_order_no = $1 OR hs.huanyu_order_no = $1)
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
    ORDER BY o.created_at ASC, o.id ASC, hs.workflow_enabled DESC, hs.huanyu_order_no ASC;
  `, params.orderNo)

  for (const row of rows) {
    const remoteOrder = await findRemoteReminderOrder(row.source_order_no, row.huanyu_order_no || undefined)
    if (!remoteOrder) continue
    const detail = (await listRemoteEscortReminderDetails(remoteOrder.orderNo)).find((item) =>
      item.detailId === params.pzrDetailId &&
      item.pzrId === params.pzrId &&
      normalizeYmdValue(item.serviceDate) === expectedDate
    )
    if (!detail || normalizeYmdValue(detail.serviceDate) !== params.serviceDate) continue

    await createEscortRejectReminder(prisma, {
      ...row,
      pzr: detail.pzrId,
      pzr_detail_id: detail.detailId,
      service_date: detail.serviceDate
    }, {
      feedbackType: params.feedbackType,
      ymd,
      serviceDate: params.serviceDate,
      remark: params.remark,
      logger: params.logger
    })
    return true
  }
  return false
}

/**
 * 周期性跟进只保留一条记录。每到新周期更新并重新打开该记录，避免每个周期都堆一条历史待办。
 */
async function upsertPeriodicReminder(
  prisma: PrismaClient,
  params: {
    orderNo: string
    huanyuOrderNo?: string | null
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
    const dedupeKey = params.huanyuOrderNo ? `${params.dedupeKey}:hy:${params.huanyuOrderNo}` : params.dedupeKey
    const existing = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, status, notification_generation, extra_data->>'occurrence' AS occurrence, extra_data->>'cycleIdentity' AS cycle_identity FROM order_reminders WHERE extra_data->>'dedupe_key' = $1 ORDER BY id DESC LIMIT 1;`,
      dedupeKey
    )
    const occurrence = existing?.[0] ? Number(existing[0].occurrence ?? 0) : null
    const cycleIdentity = String(params.extra?.cycleIdentity ?? '')
    if (existing?.[0] && !shouldAdvancePeriodicReminder(occurrence, existing[0].cycle_identity, params.occurrence, cycleIdentity)) return false

    const extraData = JSON.stringify({
      dedupe_key: dedupeKey,
      occurrence: params.occurrence,
      ...(params.extra ?? {})
    })
    if (existing?.[0]) {
      const generation = Math.max(params.occurrence, Number(existing[0].notification_generation || 1) + 1)
      await prisma.$executeRawUnsafe(
        `UPDATE order_reminders SET order_no = $1, huanyu_order_no = $2, employee_id = $3, type = $4, content = $5, remind_time = NOW(), status = 'pending', notification_generation = $8, extra_data = $6::jsonb, updated_at = NOW() WHERE id = $7;`,
        params.orderNo,
        params.huanyuOrderNo ?? null,
        params.employeeId,
        params.type,
        params.content,
        extraData,
        existing[0].id,
        generation
      )
    } else {
      await prisma.$executeRawUnsafe(
        `INSERT INTO order_reminders (order_no, huanyu_order_no, employee_id, type, content, remind_time, status, notification_generation, extra_data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, NOW(), 'pending', $7, $6::jsonb, NOW(), NOW());`,
        params.orderNo,
        params.huanyuOrderNo ?? null,
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

async function closeReminderByKey(prisma: PrismaClient, dedupeKey: string, status: 'resolved' | 'expired' = 'resolved', huanyuOrderNo?: string | null): Promise<void> {
  const serviceDedupeKey = huanyuOrderNo ? `${dedupeKey}:hy:${huanyuOrderNo}` : dedupeKey
  await prisma.$executeRawUnsafe(
    `UPDATE order_reminders SET status = $1, updated_at = NOW() WHERE extra_data->>'dedupe_key' = $2 AND status IN ('pending', 'unread');`,
    status,
    serviceDedupeKey
  )
}

async function closeReminderKeysExcept(prisma: PrismaClient, prefix: string, activeKey: string | null, status: 'resolved' | 'expired' | 'superseded', huanyuOrderNo?: string | null): Promise<void> {
  const servicePrefix = huanyuOrderNo ? `${prefix}%:hy:${huanyuOrderNo}` : `${prefix}%`
  const serviceActiveKey = activeKey && huanyuOrderNo ? `${activeKey}:hy:${huanyuOrderNo}` : activeKey
  await prisma.$executeRawUnsafe(
    `UPDATE order_reminders SET status = $1, updated_at = NOW() WHERE extra_data->>'dedupe_key' LIKE $2 AND ($3::text IS NULL OR extra_data->>'dedupe_key' != $3) AND status IN ('pending', 'unread');`,
    status,
    servicePrefix,
    serviceActiveKey
  )
}

async function closeStalePeriodicCycle(prisma: PrismaClient, dedupeKey: string, cycleIdentity: string, huanyuOrderNo?: string | null): Promise<void> {
  const serviceDedupeKey = huanyuOrderNo ? `${dedupeKey}:hy:${huanyuOrderNo}` : dedupeKey
  await prisma.$executeRawUnsafe(`
    UPDATE order_reminders SET status = 'superseded', updated_at = NOW()
    WHERE extra_data->>'dedupe_key' = $1 AND status IN ('pending', 'unread')
      AND extra_data->>'cycleIdentity' IS DISTINCT FROM $2;
  `, serviceDedupeKey, cycleIdentity)
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

  // 陪诊未落实提醒由远程陪诊明细扫描负责关闭；这里仅关闭本地流程已失效的提醒。
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
       );
  `)

  // 护工开始时间已补齐时由远程订单扫描关闭；这里仅关闭流程已结束的提醒。
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
          WHERE (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
            AND r.extra_data->>'dedupe_key' = 'auto:care_start_unassigned:' || o.source_order_no
       );
  `)

  // 护工结束日变更由远程订单扫描关闭；流程结束或服务日期过去时关闭旧提醒。
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
          WHERE o.source_order_no = r.order_no
            AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
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
    SELECT c.order_no, c.huanyu_order_no, c.batch_type, c.send_ymd, c.pzr_detail_id, c.pzr_id, c.service_date, c.claimed_at, c.error_message,
           o.created_at AS order_created_at, o.assigned_employee_id
      FROM "fact_hy_pz_sms_send_claims" c
      LEFT JOIN orders o ON o.source_order_no = c.order_no
     WHERE c.status = 'sending'
       AND c.batch_type IN ('pre_day', 'same_day')
       AND c.claimed_at < NOW() - INTERVAL '5 minutes'
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
         AND COALESCE(params_json->>'huanyuOrderNo', '') = $5
       ORDER BY id DESC LIMIT 1;
    `, claim.order_no, claim.batch_type, claim.send_ymd, claim.pzr_detail_id, claim.huanyu_order_no || '')
    const log = logs[0]
    if (log) {
      await finishEscortSmsClaim(
        prisma,
        claim.order_no,
        claim.batch_type,
        claim.send_ymd,
        log.status === 'success' ? 'sent' : 'failed',
        log.error_message || null,
        claim.pzr_detail_id,
        claim.huanyu_order_no
      )
      if (log.status === 'success') {
        await closeReminderByKey(prisma, `auto:escort_sms_failed:${claim.order_no}:${claim.huanyu_order_no}:${claim.batch_type}:${claim.pzr_detail_id}:${claim.send_ymd}`)
      }
      if (log.status !== 'success' && serviceDate >= today) {
        await notifyManagerEscortException(prisma, {
          orderNo: claim.order_no,
          huanyuOrderNo: claim.huanyu_order_no,
          employeeId: claim.assigned_employee_id,
          pzr: claim.pzr_id,
          pzrDetailId: claim.pzr_detail_id,
          serviceDate,
          sendYmd: claim.send_ymd,
          batchType: claim.batch_type === 'pre_day' ? 'mgr_pre_failed' : 'mgr_same_failed',
          alertType: claim.batch_type === 'pre_day' ? '陪诊前一天确认短信发送失败' : '陪诊当天出工短信发送失败',
          logger,
        })
      }
      continue
    }
    await finishEscortSmsClaim(prisma, claim.order_no, claim.batch_type, claim.send_ymd, 'unknown', '发送任务中断，供应商结果未知', claim.pzr_detail_id, claim.huanyu_order_no)

    // 不重发结果未知的短信；只在服务日尚未结束且当前仍有责任人时通知人工确认。
    if (serviceDate < today) continue
    await notifyManagerEscortException(prisma, {
      orderNo: claim.order_no,
      huanyuOrderNo: claim.huanyu_order_no,
      employeeId: claim.assigned_employee_id,
      pzr: claim.pzr_id,
      pzrDetailId: claim.pzr_detail_id,
      serviceDate,
      sendYmd: claim.send_ymd,
      batchType: claim.batch_type === 'pre_day' ? 'mgr_pre_failed' : 'mgr_same_failed',
      alertType: claim.batch_type === 'pre_day' ? '陪诊前一天确认短信结果未知' : '陪诊当天反馈短信结果未知',
      logger,
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
      o.id AS order_id, o.source_order_no, op.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id, o.status AS order_status,
      op.service_type
    FROM b_order_service_steps s
    JOIN b_order_operations op ON s.operation_id = op.id
    JOIN orders o ON op.order_id = o.id
    WHERE s.step_code = 'hospital_booking'
      AND op.service_type IN ('全流程', '住院')
      AND s.step_status = 'in_progress'
      AND o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
    ORDER BY o.id ASC, s.occurrence_no DESC NULLS LAST, s.id DESC
  `)

  const seenOrders = new Set<string>()
  for (const row of steps) {
    if (!row.source_order_no) continue
    const serviceKey = `${row.source_order_no}:${row.huanyu_order_no || ''}`
    if (seenOrders.has(serviceKey)) continue
    seenOrders.add(serviceKey)

    // 约住院只按客户明确同意开始安排住院的业务时间计时，不能回退到步骤创建/激活时间。
    const baseTime = row.started_at
    if (!baseTime) continue
    const cycleIdentity = `${row.id}:${row.occurrence_no ?? 0}:${new Date(baseTime).toISOString()}`
    const dedupeKey = `auto:hospital_booking:${row.source_order_no}`
    await closeStalePeriodicCycle(prisma, dedupeKey, cycleIdentity, row.huanyu_order_no)

    const diffDays = shanghaiCalendarDayDiff(baseTime, ymd)

    if (hours >= 9 && diffDays >= 3 && diffDays % 3 === 0) {
      const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 客户意向的住院时间前还没有预约成功，请关注！`

      await upsertPeriodicReminder(prisma, {
        orderNo: row.source_order_no,
        huanyuOrderNo: row.huanyu_order_no,
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
 * 1. 陪诊明细和服务日期从远程寰宇库读取
 * 2. 任一远程陪诊明细有值即视为该明细已落实
 * 3. 未确认的 AI 候选不视为陪诊人员已落实
 * 4. 仅当正式表中无陪诊人员，且前置完成满 1 小时，才写入超时未落实预警
 * 5. 不向数据库做任何回写
 */
async function scanEscortUnassignedReminders(prisma: PrismaClient, logger?: LoggerLike): Promise<void> {
  const completedPreSteps = await queryInPages(prisma, `
    SELECT 
      s.id, s.step_code, s.completed_at,
      o.id AS order_id, o.source_order_no, op.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id, o.status AS order_status,
      op.service_type
    FROM b_order_service_steps s
    JOIN b_order_operations op ON s.operation_id = op.id
    JOIN orders o ON op.order_id = o.id
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

    const remoteOrder = await findRemoteReminderOrder(row.source_order_no, row.huanyu_order_no || undefined)
    if (!remoteOrder) continue
    // 同一订单可能有多条陪诊明细；逐条检查空陪诊人明细，不能用“任意一条已指派”代替整单判断。
    const formalDetails = await listRemoteEscortReminderDetails(remoteOrder.orderNo)

    if (formalDetails.length > 0) {
      await closeReminderByKey(prisma, dedupeKey, 'resolved', row.huanyu_order_no)
      for (const detail of formalDetails) {
        const detailId = String(detail.detailId || '')
        const detailKey = `${dedupeKey}:${detailId}`
        if (detail.pzrId) {
          await closeReminderByKey(prisma, detailKey, 'resolved', row.huanyu_order_no)
          continue
        }
        const serviceDate = normalizeYmdValue(detail.serviceDate)
        await createReminderIfAbsent(prisma, {
          orderNo: row.source_order_no,
          huanyuOrderNo: row.huanyu_order_no,
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
      huanyuOrderNo: row.huanyu_order_no,
      employeeId: row.assigned_employee_id,
      type: 'escort',
      content,
      dedupeKey,
      logger,
      extra: {
        preStepCode: row.step_code,
        completedAt: row.completed_at,
        ...(normalizeYmdValue(remoteOrder.serviceDate) ? { serviceDate: normalizeYmdValue(remoteOrder.serviceDate) } : {})
      }
    })
    const serviceDate = normalizeYmdValue(remoteOrder.serviceDate)
    if (serviceDate) {
      await prisma.$executeRawUnsafe(`
        UPDATE order_reminders
           SET extra_data = jsonb_set(COALESCE(extra_data, '{}'::jsonb), '{serviceDate}', to_jsonb($2::text), true),
               updated_at = NOW()
         WHERE extra_data->>'dedupe_key' = $1 AND status IN ('pending', 'unread');
      `, row.huanyu_order_no ? `${dedupeKey}:hy:${row.huanyu_order_no}` : dedupeKey, serviceDate)
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
  remoteOrderNo: string,
  pzrId: string | null | undefined
): Promise<string | null> {
  const details = await listRemoteEscortReminderDetails(remoteOrderNo)
  return details.find((detail) => detail.pzrId === String(pzrId || '').trim())?.phone || null
}

async function claimEscortSmsSend(
  prisma: PrismaClient,
  orderNo: string,
  batchType: string,
  sendYmd: string,
  pzrId: string,
  serviceDate: string,
  pzrDetailId: string,
  huanyuOrderNo = ''
): Promise<boolean> {
  const legacyClaims = await prisma.$queryRawUnsafe<any[]>(`
    SELECT 1 FROM "fact_hy_pz_sms_send_claims"
    WHERE order_no = $1 AND huanyu_order_no = $2 AND batch_type = $3 AND send_ymd = $4
      AND pzr_detail_id = '' AND pzr_id = $5 AND service_date = $6
    LIMIT 1;
  `, orderNo, huanyuOrderNo, batchType, sendYmd, pzrId, serviceDate)
  if (legacyClaims.length > 0) return false

  const rows = await prisma.$queryRawUnsafe<any[]>(`
    INSERT INTO "fact_hy_pz_sms_send_claims" ("order_no", "huanyu_order_no", "batch_type", "send_ymd", "pzr_id", "service_date", "pzr_detail_id")
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT ("order_no", "huanyu_order_no", "batch_type", "send_ymd", "pzr_detail_id") DO NOTHING
    RETURNING "order_no";
  `, orderNo, huanyuOrderNo, batchType, sendYmd, pzrId, serviceDate, pzrDetailId)
  return rows.length > 0
}

async function finishEscortSmsClaim(
  prisma: PrismaClient,
  orderNo: string,
  batchType: string,
  sendYmd: string,
  status: 'sent' | 'failed' | 'skipped' | 'unknown',
  errorMessage: string | null = null,
  pzrDetailId = '',
  huanyuOrderNo = ''
): Promise<void> {
  await prisma.$executeRawUnsafe(`
    UPDATE "fact_hy_pz_sms_send_claims"
       SET status = $4, error_message = $5, completed_at = NOW()
     WHERE order_no = $1 AND batch_type = $2 AND send_ymd = $3 AND pzr_detail_id = $6 AND huanyu_order_no = $7;
  `, orderNo, batchType, sendYmd, status, errorMessage, pzrDetailId, huanyuOrderNo)
}

type ManagerEscortAlertParams = {
  orderNo: string
  huanyuOrderNo?: string | null
  employeeId: number | null | undefined
  pzr: string | null | undefined
  pzrDetailId: string | null | undefined
  serviceDate: string
  sendYmd: string
  /** 以不同批次类型参与幂等，避免同一陪诊明细的不同异常互相覆盖。 */
  batchType: 'mgr_pre_missed' | 'mgr_same_missed' | 'mgr_pre_failed' | 'mgr_same_failed' | 'mgr_pre_reject' | 'mgr_same_reject' | 'mgr_pre_unack' | 'mgr_same_unack'
  alertType: string
  logger?: LoggerLike
}

/**
 * 客户经理陪诊异常短信的唯一出口。
 *
 * 总开关关闭、通道未配齐或异常模板留空时，代表该类短信未启用，静默跳过；
 * 只有短信功能已启用后遇到真实业务异常，才尝试发送并记录发送结果。
 */
async function notifyManagerEscortException(prisma: PrismaClient, params: ManagerEscortAlertParams): Promise<void> {
  // 前一天批次的异常保留为本地系统提醒，不能发送客户经理短信。
  if (params.batchType.startsWith('mgr_pre_')) {
    if (!params.employeeId) return
    await createReminderIfAbsent(prisma, {
      orderNo: params.orderNo,
      huanyuOrderNo: params.huanyuOrderNo,
      employeeId: params.employeeId,
      type: 'escort',
      content: `订单号: ${params.orderNo}\n陪诊人员: ${params.pzr || '未填写'}\n服务日期: ${params.serviceDate}\n提醒内容: ${params.alertType}，请及时处理！`,
      dedupeKey: `auto:escort_pre_day_exception:${params.orderNo}:${params.pzrDetailId || 'unknown'}:${params.batchType}:${params.sendYmd}`,
      logger: params.logger,
      extra: { serviceDate: params.serviceDate, pzr: params.pzr, pzrDetailId: params.pzrDetailId, alertType: params.alertType }
    })
    return
  }
  try {
    await dispatchManagerEscortException(prisma, params)
  } catch (err) {
    // 客户经理短信自身的日志或通道异常不能回流为陪诊短信异常，避免同一事件被重复通知。
    params.logger?.error(`[orderReminderSchedule] 客户经理异常短信处理失败：订单 ${params.orderNo}`, err)
  }
}

async function dispatchManagerEscortException(prisma: PrismaClient, params: ManagerEscortAlertParams): Promise<void> {
  if (!params.orderNo) return

  const config = await getSmsConfig(prisma)
  const templateCode = config.templateManagerAlert.trim()
  // 异常提醒模板留空或总通道不可用，都表示这一类通知没有启用；不写发送流水或原因。
  if (!isSmsTemplateEnabled(config, templateCode)) return

  const detailId = params.pzrDetailId || 'unknown-detail'
  if (!(await claimEscortSmsSend(prisma, params.orderNo, params.batchType, params.sendYmd, params.pzr || '', params.serviceDate, detailId, params.huanyuOrderNo || ''))) {
    return
  }

  const remoteOrder = await findRemoteReminderOrder(params.orderNo, params.huanyuOrderNo || undefined)
  const phone = String(remoteOrder?.managerPhone || '').replace(/\D/g, '')
  const customerName = remoteOrder?.customerName || '未填写'
  const hospitalName = remoteOrder?.hospitalName || '未填写'
  const escortContact = (await resolveEscortPhone(remoteOrder?.orderNo || '', params.pzr) || '').replace(/\D/g, '')
  const logParams = JSON.stringify({ orderNo: params.orderNo, huanyuOrderNo: params.huanyuOrderNo || '', customerName, hospitalName, pzrDetailId: detailId, alertType: params.alertType, managerName: remoteOrder?.managerName || '', escortContact })
  const baseValues = [params.orderNo, params.batchType, phone || null, params.pzr || null, params.serviceDate, templateCode, config.signName || '寰宇医道', logParams, params.sendYmd]

  if (!/^1\d{10}$/.test(phone)) {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "fact_hy_pz_sms_logs" (
        order_no, batch_type, phone, pzr_name, service_date, template_code, sign_name,
        params_json, status, error_code, error_message, send_ymd, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'failed', 'NO_MANAGER_PHONE', '责任客户经理未配置有效手机号', $9, NOW());
    `, ...baseValues)
    await finishEscortSmsClaim(prisma, params.orderNo, params.batchType, params.sendYmd, 'failed', '责任客户经理未配置有效手机号', detailId, params.huanyuOrderNo || '')
    params.logger?.warn(`[orderReminderSchedule] 客户经理异常短信未发送：责任客户经理无有效手机号，订单 ${params.orderNo}`)
    return
  }

  const result = await sendAliyunSms({
    phoneNumbers: phone,
    signName: config.signName,
    templateCode,
    templateParam: {
      orderNo: params.orderNo,
      customerName,
      hospitalName,
      serviceDate: params.serviceDate,
      escortName: params.pzr || '未填写',
      escortContact: escortContact || '未填写',
      alertType: params.alertType
    }
  }, config)

  if (result.success) {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "fact_hy_pz_sms_logs" (
        order_no, batch_type, phone, pzr_name, service_date, template_code, sign_name,
        params_json, biz_id, request_id, status, send_ymd, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, 'success', $11, NOW());
    `, params.orderNo, params.batchType, phone, params.pzr || null, params.serviceDate, templateCode, config.signName || '寰宇医道', logParams, result.bizId || null, result.requestId || null, params.sendYmd)
    await finishEscortSmsClaim(prisma, params.orderNo, params.batchType, params.sendYmd, 'sent', null, detailId, params.huanyuOrderNo || '')
    params.logger?.info(`[orderReminderSchedule] 已短信通知客户经理 ${remoteOrder?.managerName || '未匹配'}：${params.alertType}，订单 ${params.orderNo}`)
    return
  }

  await prisma.$executeRawUnsafe(`
    INSERT INTO "fact_hy_pz_sms_logs" (
      order_no, batch_type, phone, pzr_name, service_date, template_code, sign_name,
      params_json, request_id, status, error_code, error_message, send_ymd, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'failed', $10, $11, $12, NOW());
  `, params.orderNo, params.batchType, phone, params.pzr || null, params.serviceDate, templateCode, config.signName || '寰宇医道', logParams, result.requestId || null, result.code, result.message, params.sendYmd)
  await finishEscortSmsClaim(prisma, params.orderNo, params.batchType, params.sendYmd, 'failed', result.message, detailId, params.huanyuOrderNo || '')
  params.logger?.warn(`[orderReminderSchedule] 客户经理异常短信发送失败：订单 ${params.orderNo}，错误: ${result.message}`)
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
  `, row.source_order_no, batchType, row.pzr, serviceDate, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no, huanyuOrderNo: row.huanyu_order_no || '', pzrDetailId: row.pzr_detail_id }), reason, sendYmd)
  await finishEscortSmsClaim(prisma, row.source_order_no, batchType, sendYmd, 'skipped', reason, row.pzr_detail_id, row.huanyu_order_no || '')
  const batchLabel = batchType === 'pre_day' ? '前一天确认' : '当天打卡'
  await notifyManagerEscortException(prisma, {
    orderNo: row.source_order_no,
    huanyuOrderNo: row.huanyu_order_no,
    employeeId: row.assigned_employee_id,
    pzr: row.pzr,
    pzrDetailId: row.pzr_detail_id,
    serviceDate,
    sendYmd,
    batchType: batchType === 'pre_day' ? 'mgr_pre_missed' : 'mgr_same_missed',
    alertType: `陪诊${batchLabel}短信未按时发送`,
    logger
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
  // 通道关闭、配置不完整或该模板留空时，这类短信未启用：静默跳过。
  const templateEnabled = isSmsTemplateEnabled(smsConfig, templateCode)
  const canSend = allowSend && inSendWindow && templateEnabled

  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000)
  const tomorrowYmd = formatYmd(tomorrow)
  const signName = smsConfig.signName || '寰宇医道'

  const preDayOrders = await queryInPages(prisma, `
    SELECT 
      o.id AS order_id, o.source_order_no, hs.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id,
      op.service_type
    FROM b_order_huanyu_services hs
    JOIN orders o ON o.id = hs.order_id
    LEFT JOIN b_order_operations op ON op.order_id = o.id AND op.huanyu_order_no = hs.huanyu_order_no
    WHERE (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
      AND (
        hs.workflow_enabled = false OR (
          op.service_type IN ('全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '检查加急', '住院')
          AND EXISTS (
            SELECT 1 FROM b_order_service_steps cstep
            WHERE cstep.operation_id = op.id
              AND cstep.step_code IN ('escort', 'check_companion', 'hospital_companion', 'revisit_escort')
              AND cstep.step_status IN ('pending', 'in_progress')
          )
        )
      )
    ORDER BY o.created_at ASC, o.id ASC
  `)

  for (const baseRow of preDayOrders) {
    const remoteOrder = await findRemoteReminderOrder(baseRow.source_order_no, baseRow.huanyu_order_no)
    if (!remoteOrder) continue
    const remoteDetails = await listRemoteEscortReminderDetails(remoteOrder.orderNo)
    for (const detail of remoteDetails) {
      if (!detail.pzrId || normalizeYmdValue(detail.serviceDate) !== tomorrowYmd) continue
      const row = { ...baseRow, pzr_detail_id: detail.detailId, pzr: detail.pzrId, service_date: detail.serviceDate, remote_order_no: remoteOrder.orderNo }
    try {
    if (!row.source_order_no) continue

    if (!templateEnabled) continue

    if (!(await claimEscortSmsSend(prisma, row.source_order_no, 'pre_day', ymd, row.pzr, tomorrowYmd, row.pzr_detail_id, row.huanyu_order_no))) {
      continue
    }

    if (!canSend) {
      const reason = !allowSend || !inSendWindow
        ? '已错过前一天 11:00 发送时点'
        : '短信未执行'
      await recordSkippedEscortSms(prisma, row, 'pre_day', ymd, tomorrowYmd, templateCode, signName, reason, logger)
      continue
    }

    const phone = await resolveEscortPhone(row.remote_order_no, row.pzr)
    const cleanPhone = (phone || '').replace(/\D/g, '')

    if (cleanPhone && cleanPhone.length === 11) {
      const result = await sendAliyunSms({
        phoneNumbers: cleanPhone,
        signName,
        templateCode,
        templateParam: { orderNo: row.huanyu_order_no }
      }, smsConfig)

      if (result.success) {
        await prisma.$executeRawUnsafe(`
          INSERT INTO "fact_hy_pz_sms_logs" (
            order_no, batch_type, phone, pzr_name, service_date, template_code, sign_name,
            params_json, biz_id, request_id, status, send_ymd, created_at
          ) VALUES ($1, 'pre_day', $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'success', $10, NOW());
        `, row.source_order_no, cleanPhone, row.pzr, tomorrowYmd, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no, huanyuOrderNo: row.huanyu_order_no, pzrDetailId: row.pzr_detail_id }), result.bizId, result.requestId, ymd)
        await finishEscortSmsClaim(prisma, row.source_order_no, 'pre_day', ymd, 'sent', null, row.pzr_detail_id, row.huanyu_order_no)
        await closeReminderByKey(prisma, `auto:escort_sms_failed:${row.source_order_no}:${row.huanyu_order_no}:pre_day:${row.pzr_detail_id}:${ymd}`)

        logger?.info(`[orderReminderSchedule] 前一天出工确认短信发送成功: 订单 ${row.source_order_no}, 手机 ${cleanPhone}, bizId=${result.bizId}`)
      } else {
        await prisma.$executeRawUnsafe(`
          INSERT INTO "fact_hy_pz_sms_logs" (
            order_no, batch_type, phone, pzr_name, service_date, template_code, sign_name,
            params_json, request_id, status, error_code, error_message, send_ymd, created_at
          ) VALUES ($1, 'pre_day', $2, $3, $4, $5, $6, $7::jsonb, $8, 'failed', $9, $10, $11, NOW());
        `, row.source_order_no, cleanPhone, row.pzr, tomorrowYmd, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no, huanyuOrderNo: row.huanyu_order_no, pzrDetailId: row.pzr_detail_id }), result.requestId, result.code, result.message, ymd)
        await finishEscortSmsClaim(prisma, row.source_order_no, 'pre_day', ymd, 'failed', result.message, row.pzr_detail_id, row.huanyu_order_no)

        logger?.warn(`[orderReminderSchedule] 前一天出工确认短信发送失败: 订单 ${row.source_order_no}, 错误: ${result.message}`)

        await notifyManagerEscortException(prisma, {
          orderNo: row.source_order_no,
          huanyuOrderNo: row.huanyu_order_no,
          employeeId: row.assigned_employee_id,
          pzr: row.pzr,
          pzrDetailId: row.pzr_detail_id,
          serviceDate: tomorrowYmd,
          sendYmd: ymd,
          batchType: 'mgr_pre_failed',
          alertType: '陪诊前一天确认短信发送失败',
          logger,
        })
      }
    } else {
      await prisma.$executeRawUnsafe(`
        INSERT INTO "fact_hy_pz_sms_logs" (
          order_no, batch_type, pzr_name, service_date, template_code, sign_name,
          params_json, status, error_code, error_message, send_ymd, created_at
        ) VALUES ($1, 'pre_day', $2, $3, $4, $5, $6::jsonb, 'failed', 'NO_PHONE', '未配置有效陪诊人员手机号', $7, NOW());
      `, row.source_order_no, row.pzr, tomorrowYmd, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no, huanyuOrderNo: row.huanyu_order_no, pzrDetailId: row.pzr_detail_id }), ymd)
      await finishEscortSmsClaim(prisma, row.source_order_no, 'pre_day', ymd, 'failed', '未配置有效陪诊人员手机号', row.pzr_detail_id, row.huanyu_order_no)

      logger?.warn(`[orderReminderSchedule] 前一天出工短信未发送：未找到陪诊人手机号: 订单 ${row.source_order_no}, 陪诊人 ${row.pzr}`)

        await notifyManagerEscortException(prisma, {
        orderNo: row.source_order_no,
        huanyuOrderNo: row.huanyu_order_no,
        employeeId: row.assigned_employee_id,
          pzr: row.pzr,
          pzrDetailId: row.pzr_detail_id,
          serviceDate: tomorrowYmd,
          sendYmd: ymd,
          batchType: 'mgr_pre_failed',
          alertType: '陪诊人员无有效手机号',
        logger,
      })
    }
    } catch (err: any) {
      const reason = String(err?.message || err || '短信任务异常')
      logger?.error(`[orderReminderSchedule] 前一天短信订单处理异常: ${row.source_order_no}`, err)
      const logged = await prisma.$queryRawUnsafe<any[]>(`SELECT status FROM "fact_hy_pz_sms_logs" WHERE order_no = $1 AND batch_type = 'pre_day' AND send_ymd = $2 AND params_json->>'pzrDetailId' = $3 AND params_json->>'huanyuOrderNo' = $4 ORDER BY id DESC LIMIT 1;`, row.source_order_no, ymd, row.pzr_detail_id, row.huanyu_order_no).catch(() => [])
      if (logged[0]?.status === 'success') {
        await finishEscortSmsClaim(prisma, row.source_order_no, 'pre_day', ymd, 'sent', null, row.pzr_detail_id, row.huanyu_order_no).catch(() => {})
        continue
      }
      await finishEscortSmsClaim(prisma, row.source_order_no, 'pre_day', ymd, 'unknown', reason, row.pzr_detail_id, row.huanyu_order_no).catch(() => {})
      if (row.source_order_no) {
        await notifyManagerEscortException(prisma, {
          orderNo: row.source_order_no,
          huanyuOrderNo: row.huanyu_order_no,
          employeeId: row.assigned_employee_id,
          pzr: row.pzr,
          pzrDetailId: row.pzr_detail_id,
          serviceDate: tomorrowYmd,
          sendYmd: ymd,
          batchType: 'mgr_pre_failed',
          alertType: '陪诊前一天确认短信结果未知',
          logger,
        })
      }
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
  // 通道关闭、配置不完整或该模板留空时，这类短信未启用：静默跳过。
  const templateEnabled = isSmsTemplateEnabled(smsConfig, templateCode)
  const canSend = allowSend && inSendWindow && templateEnabled

  const signName = smsConfig.signName || '寰宇医道'

  const sameDayOrders = await queryInPages(prisma, `
    SELECT 
      o.id AS order_id, o.source_order_no, hs.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id,
      op.service_type
    FROM b_order_huanyu_services hs
    JOIN orders o ON o.id = hs.order_id
    LEFT JOIN b_order_operations op ON op.order_id = o.id AND op.huanyu_order_no = hs.huanyu_order_no
    WHERE (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
      AND (
        hs.workflow_enabled = false OR (
          op.service_type IN ('全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '检查加急', '住院')
          AND EXISTS (
            SELECT 1 FROM b_order_service_steps cstep
            WHERE cstep.operation_id = op.id
              AND cstep.step_code IN ('escort', 'check_companion', 'hospital_companion', 'revisit_escort')
              AND cstep.step_status IN ('pending', 'in_progress')
          )
        )
      )
    ORDER BY o.created_at ASC, o.id ASC
  `)

  for (const baseRow of sameDayOrders) {
    const remoteOrder = await findRemoteReminderOrder(baseRow.source_order_no, baseRow.huanyu_order_no)
    if (!remoteOrder) continue
    const remoteDetails = await listRemoteEscortReminderDetails(remoteOrder.orderNo)
    for (const detail of remoteDetails) {
      if (!detail.pzrId || normalizeYmdValue(detail.serviceDate) !== ymd) continue
      const row = { ...baseRow, pzr_detail_id: detail.detailId, pzr: detail.pzrId, service_date: detail.serviceDate, remote_order_no: remoteOrder.orderNo }
    try {
    if (!row.source_order_no) continue

    if (!templateEnabled) continue

    if (!(await claimEscortSmsSend(prisma, row.source_order_no, 'same_day', ymd, row.pzr, ymd, row.pzr_detail_id, row.huanyu_order_no))) {
      continue
    }

    if (!canSend) {
      const reason = !allowSend || !inSendWindow
        ? '已错过当天 07:00 发送时点'
        : '短信未执行'
      await recordSkippedEscortSms(prisma, row, 'same_day', ymd, ymd, templateCode, signName, reason, logger)
      continue
    }

    const phone = await resolveEscortPhone(row.remote_order_no, row.pzr)
    const cleanPhone = (phone || '').replace(/\D/g, '')

    if (cleanPhone && cleanPhone.length === 11) {
      const result = await sendAliyunSms({
        phoneNumbers: cleanPhone,
        signName,
        templateCode,
        templateParam: { orderNo: row.huanyu_order_no }
      }, smsConfig)

      if (result.success) {
        await prisma.$executeRawUnsafe(`
          INSERT INTO "fact_hy_pz_sms_logs" (
            order_no, batch_type, phone, pzr_name, service_date, template_code, sign_name,
            params_json, biz_id, request_id, status, send_ymd, created_at
          ) VALUES ($1, 'same_day', $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'success', $10, NOW());
        `, row.source_order_no, cleanPhone, row.pzr, ymd, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no, huanyuOrderNo: row.huanyu_order_no, pzrDetailId: row.pzr_detail_id }), result.bizId, result.requestId, ymd)
        await finishEscortSmsClaim(prisma, row.source_order_no, 'same_day', ymd, 'sent', null, row.pzr_detail_id, row.huanyu_order_no)
        await closeReminderByKey(prisma, `auto:escort_sms_failed:${row.source_order_no}:${row.huanyu_order_no}:same_day:${row.pzr_detail_id}:${ymd}`)

        logger?.info(`[orderReminderSchedule] 当日出工打卡短信发送成功: 订单 ${row.source_order_no}, 手机 ${cleanPhone}, bizId=${result.bizId}`)
      } else {
        await prisma.$executeRawUnsafe(`
          INSERT INTO "fact_hy_pz_sms_logs" (
            order_no, batch_type, phone, pzr_name, service_date, template_code, sign_name,
            params_json, request_id, status, error_code, error_message, send_ymd, created_at
          ) VALUES ($1, 'same_day', $2, $3, $4, $5, $6, $7::jsonb, $8, 'failed', $9, $10, $11, NOW());
        `, row.source_order_no, cleanPhone, row.pzr, ymd, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no, huanyuOrderNo: row.huanyu_order_no, pzrDetailId: row.pzr_detail_id }), result.requestId, result.code, result.message, ymd)
        await finishEscortSmsClaim(prisma, row.source_order_no, 'same_day', ymd, 'failed', result.message, row.pzr_detail_id, row.huanyu_order_no)

        logger?.warn(`[orderReminderSchedule] 当日出工打卡短信发送失败: 订单 ${row.source_order_no}, 错误: ${result.message}`)

        await notifyManagerEscortException(prisma, {
          orderNo: row.source_order_no,
          huanyuOrderNo: row.huanyu_order_no,
          employeeId: row.assigned_employee_id,
          pzr: row.pzr,
          pzrDetailId: row.pzr_detail_id,
          serviceDate: ymd,
          sendYmd: ymd,
          batchType: 'mgr_same_failed',
          alertType: '陪诊当天出工短信发送失败',
          logger,
        })
      }
    } else {
      await prisma.$executeRawUnsafe(`
        INSERT INTO "fact_hy_pz_sms_logs" (
          order_no, batch_type, pzr_name, service_date, template_code, sign_name,
          params_json, status, error_code, error_message, send_ymd, created_at
        ) VALUES ($1, 'same_day', $2, $3, $4, $5, $6::jsonb, 'failed', 'NO_PHONE', '未配置有效陪诊人员手机号', $7, NOW());
      `, row.source_order_no, row.pzr, ymd, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no, huanyuOrderNo: row.huanyu_order_no, pzrDetailId: row.pzr_detail_id }), ymd)
      await finishEscortSmsClaim(prisma, row.source_order_no, 'same_day', ymd, 'failed', '未配置有效陪诊人员手机号', row.pzr_detail_id, row.huanyu_order_no)

      logger?.warn(`[orderReminderSchedule] 当日出工短信未发送：未找到陪诊人手机号: 订单 ${row.source_order_no}, 陪诊人 ${row.pzr}`)

        await notifyManagerEscortException(prisma, {
        orderNo: row.source_order_no,
        huanyuOrderNo: row.huanyu_order_no,
        employeeId: row.assigned_employee_id,
          pzr: row.pzr,
          pzrDetailId: row.pzr_detail_id,
          serviceDate: ymd,
          sendYmd: ymd,
          batchType: 'mgr_same_failed',
          alertType: '陪诊人员无有效手机号',
        logger,
      })
    }
    } catch (err: any) {
      const reason = String(err?.message || err || '短信任务异常')
      logger?.error(`[orderReminderSchedule] 当天短信订单处理异常: ${row.source_order_no}`, err)
      const logged = await prisma.$queryRawUnsafe<any[]>(`SELECT status FROM "fact_hy_pz_sms_logs" WHERE order_no = $1 AND batch_type = 'same_day' AND send_ymd = $2 AND params_json->>'pzrDetailId' = $3 AND params_json->>'huanyuOrderNo' = $4 ORDER BY id DESC LIMIT 1;`, row.source_order_no, ymd, row.pzr_detail_id, row.huanyu_order_no).catch(() => [])
      if (logged[0]?.status === 'success') {
        await finishEscortSmsClaim(prisma, row.source_order_no, 'same_day', ymd, 'sent', null, row.pzr_detail_id, row.huanyu_order_no).catch(() => {})
        continue
      }
      await finishEscortSmsClaim(prisma, row.source_order_no, 'same_day', ymd, 'unknown', reason, row.pzr_detail_id, row.huanyu_order_no).catch(() => {})
      if (row.source_order_no) {
        await notifyManagerEscortException(prisma, {
          orderNo: row.source_order_no,
          huanyuOrderNo: row.huanyu_order_no,
          employeeId: row.assigned_employee_id,
          pzr: row.pzr,
          pzrDetailId: row.pzr_detail_id,
          serviceDate: ymd,
          sendYmd: ymd,
          batchType: 'mgr_same_failed',
          alertType: '陪诊当天反馈短信结果未知',
          logger,
        })
      }
    }
    }
  }
}

/**
 * 场景 2.2-B & 2.3-B：【陪诊】前一天出工反馈监控（13:00）与当天防迟到出工监控（07:20）
 * 核心门禁：
 * 1. 订单和正式陪诊信息从远程寰宇库读取；
 * 2. 反馈表 fact_hy_pzfk 仍从本地读取，未确认的 AI 候选不作为短信对象或反馈监控对象
 * 3. 严格限定白名单服务类型，排除住院护工协助等非陪诊订单
 * 4. 【关键门禁】：未反馈短信仅在今天成功发送过对应批次短信的前提下才触发，未发短信或发送失败时不重复通知。
 */
export async function scanEscortDailyCheckReminders(prisma: PrismaClient, logger?: LoggerLike, now = new Date()): Promise<void> {
  const { ymd, time, hours, minutes } = shanghaiNowParts(now)
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000)
  const tomorrowYmd = formatYmd(tomorrow)

  // 1. 场景 2.2：前一天出工确认（11:00 发短信，13:00 检查未反馈或异常反馈）
  const preDayOrders = await queryInPages(prisma, `
    SELECT 
      o.id AS order_id, o.source_order_no, hs.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id,
      op.service_type
    FROM b_order_huanyu_services hs
    JOIN orders o ON o.id = hs.order_id
    LEFT JOIN b_order_operations op ON op.order_id = o.id AND op.huanyu_order_no = hs.huanyu_order_no
    WHERE (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
      AND (
        hs.workflow_enabled = false OR (
          op.service_type IN ('全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '检查加急', '住院')
          AND EXISTS (
            SELECT 1 FROM b_order_service_steps cstep
            WHERE cstep.operation_id = op.id
              AND cstep.step_code IN ('escort', 'check_companion', 'hospital_companion', 'revisit_escort')
              AND cstep.step_status IN ('pending', 'in_progress')
          )
        )
      )
    ORDER BY o.created_at ASC, o.id ASC
  `)

  for (const baseRow of preDayOrders) {
    const remoteOrder = await findRemoteReminderOrder(baseRow.source_order_no, baseRow.huanyu_order_no)
    if (!remoteOrder) continue
    const remoteDetails = await listRemoteEscortReminderDetails(remoteOrder.orderNo)
    for (const detail of remoteDetails) {
      if (!detail.pzrId || normalizeYmdValue(detail.serviceDate) !== tomorrowYmd) continue
      const row = { ...baseRow, pzr_detail_id: detail.detailId, pzr: detail.pzrId, service_date: detail.serviceDate }
    // 检查 fact_hy_pzfk 表中的前一天反馈
    const feedbackList = await prisma.$queryRawUnsafe<any[]>(`
      SELECT will_attend, remark, created_at
      FROM "fact_hy_pzfk" 
      WHERE (ddbh = $1 OR ddbh = $2) 
        AND feedback_type = 'pre_day' 
        AND pzr_id = $3 AND service_date = $4 AND pzr_detail_id = $5
        AND created_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::timestamp
      ORDER BY created_at DESC 
      LIMIT 1;
    `, row.source_order_no, row.huanyu_order_no || '', row.pzr, tomorrowYmd, row.pzr_detail_id)

    const feedback = feedbackList[0]

    // 情况 A：已提交但反馈【无法出工（不去）】，立即短信通知客户经理
    if (feedback && feedback.will_attend === false) {
      await closeReminderByKey(prisma, `auto:escort_pre_day_unack:${row.source_order_no}:${row.pzr_detail_id}:${ymd}`, 'resolved', row.huanyu_order_no)
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
      await closeReminderByKey(prisma, `auto:escort_pre_day_unack:${row.source_order_no}:${row.pzr_detail_id}:${ymd}`, 'resolved', row.huanyu_order_no)
      await closeReminderByKey(prisma, `auto:escort_pre_day_reject:${row.source_order_no}:${row.pzr_detail_id}:${ymd}`, 'resolved', row.huanyu_order_no)
      continue
    }

    // 旧快照的反馈没有陪诊人和服务日期，不能抵消当前批次的未反馈提醒。
    if (hours >= 13) {
      // 强前置门禁：必须检查今天是否向该陪诊员成功发送过前一天出工短信！
      const smsLog = await prisma.$queryRawUnsafe<any[]>(`
        SELECT 1 FROM "fact_hy_pz_sms_send_claims"
        WHERE order_no = $1 AND huanyu_order_no = $2 AND batch_type = 'pre_day' AND send_ymd = $3 AND status = 'sent'
          AND pzr_id = $4 AND service_date = $5 AND pzr_detail_id = $6
        LIMIT 1;
      `, row.source_order_no, row.huanyu_order_no, ymd, row.pzr, tomorrowYmd, row.pzr_detail_id)

      if (!smsLog || smsLog.length === 0) {
        // 未发送短信或发送失败时，不发送未反馈短信。
        continue
      }

      if (row.assigned_employee_id) {
        await createReminderIfAbsent(prisma, {
          orderNo: row.source_order_no,
          huanyuOrderNo: row.huanyu_order_no,
          employeeId: row.assigned_employee_id,
          type: 'escort',
          content: `订单号: ${row.source_order_no}\n陪诊人员: ${row.pzr}\n服务日期: ${tomorrowYmd}\n提醒内容: 陪诊人员前一天确认短信后仍未反馈，请及时处理！`,
          dedupeKey: `auto:escort_pre_day_unack:${row.source_order_no}:${row.pzr_detail_id}:${ymd}`,
          logger,
          extra: { serviceDate: tomorrowYmd, pzr: row.pzr, pzrDetailId: row.pzr_detail_id }
        })
      }
    }
  }
  }

  // 2. 场景 2.3：当天防迟到出工（07:00 发短信，07:20 检查未反馈或异常反馈）
  const isAfter720 = hours > 7 || (hours === 7 && minutes >= 20)
  const sameDayOrders = await queryInPages(prisma, `
    SELECT 
      o.id AS order_id, o.source_order_no, hs.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id,
      op.service_type
    FROM b_order_huanyu_services hs
    JOIN orders o ON o.id = hs.order_id
    LEFT JOIN b_order_operations op ON op.order_id = o.id AND op.huanyu_order_no = hs.huanyu_order_no
    WHERE (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
      AND (
        hs.workflow_enabled = false OR (
          op.service_type IN ('全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '检查加急', '住院')
          AND EXISTS (
            SELECT 1 FROM b_order_service_steps cstep
            WHERE cstep.operation_id = op.id
              AND cstep.step_code IN ('escort', 'check_companion', 'hospital_companion', 'revisit_escort')
              AND cstep.step_status IN ('pending', 'in_progress')
          )
        )
      )
    ORDER BY o.created_at ASC, o.id ASC
  `)

  for (const baseRow of sameDayOrders) {
    const remoteOrder = await findRemoteReminderOrder(baseRow.source_order_no, baseRow.huanyu_order_no)
    if (!remoteOrder) continue
    const remoteDetails = await listRemoteEscortReminderDetails(remoteOrder.orderNo)
    for (const detail of remoteDetails) {
      if (!detail.pzrId || normalizeYmdValue(detail.serviceDate) !== ymd) continue
      const row = { ...baseRow, pzr_detail_id: detail.detailId, pzr: detail.pzrId, service_date: detail.serviceDate }
    const feedbackList = await prisma.$queryRawUnsafe<any[]>(`
      SELECT will_attend, remark, created_at 
      FROM "fact_hy_pzfk" 
      WHERE (ddbh = $1 OR ddbh = $2) 
        AND feedback_type = 'same_day' 
        AND pzr_id = $3 AND service_date = $4 AND pzr_detail_id = $5
        AND created_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::timestamp
      ORDER BY created_at DESC 
      LIMIT 1;
    `, row.source_order_no, row.huanyu_order_no || '', row.pzr, ymd, row.pzr_detail_id)

    const feedback = feedbackList[0]

    // 情况 A：当天反馈【无法出工（不去）】，立即短信通知客户经理
    if (feedback && feedback.will_attend === false) {
      await closeReminderByKey(prisma, `auto:escort_same_day_unack:${row.source_order_no}:${row.pzr_detail_id}:${ymd}`, 'resolved', row.huanyu_order_no)
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
      await closeReminderByKey(prisma, `auto:escort_same_day_unack:${row.source_order_no}:${row.pzr_detail_id}:${ymd}`, 'resolved', row.huanyu_order_no)
      await closeReminderByKey(prisma, `auto:escort_same_day_reject:${row.source_order_no}:${row.pzr_detail_id}:${ymd}`, 'resolved', row.huanyu_order_no)
      continue
    }

    // 情况 C：07:20 后未收到当天反馈
    if (isAfter720) {
      // 强前置门禁：必须检查今天是否向该陪诊员成功发送过当日出工打卡短信！
      const smsLog = await prisma.$queryRawUnsafe<any[]>(`
        SELECT 1 FROM "fact_hy_pz_sms_send_claims"
        WHERE order_no = $1 AND huanyu_order_no = $2 AND batch_type = 'same_day' AND send_ymd = $3 AND status = 'sent'
          AND pzr_id = $4 AND service_date = $5 AND pzr_detail_id = $6
        LIMIT 1;
      `, row.source_order_no, row.huanyu_order_no, ymd, row.pzr, ymd, row.pzr_detail_id)

      if (!smsLog || smsLog.length === 0) {
        continue
      }

      await notifyManagerEscortException(prisma, {
        orderNo: row.source_order_no,
        huanyuOrderNo: row.huanyu_order_no,
        employeeId: row.assigned_employee_id,
        pzr: row.pzr,
        pzrDetailId: row.pzr_detail_id,
        serviceDate: ymd,
        sendYmd: ymd,
        batchType: 'mgr_same_unack',
        alertType: '陪诊人员未反馈',
        logger,
      })
    }
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
      o.id AS order_id, o.source_order_no, op.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id, o.status AS order_status,
      op.service_type,
      s.id AS care_step_id, s.occurrence_no, s.started_at AS care_requested_at,
      s.planned_at AS care_end_date, s.evidence_json AS care_evidence
    FROM orders o
    JOIN b_order_operations op ON op.order_id = o.id
    JOIN b_order_service_steps s ON s.operation_id = op.id AND s.step_code = 'hospital_care' AND s.step_status = 'in_progress' AND s.started_at IS NOT NULL
    WHERE op.service_type = '住院护工协助'
      AND o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
    ORDER BY o.id ASC, s.occurrence_no DESC NULLS LAST, s.id DESC
  `)

  const seenCareOrders = new Set<string>()
  for (const row of careOrders) {
    if (!row.assigned_employee_id || !row.source_order_no) continue
    const serviceKey = `${row.source_order_no}:${row.huanyu_order_no || ''}`
    if (seenCareOrders.has(serviceKey)) continue
    seenCareOrders.add(serviceKey)

    const evidence = (row.care_evidence && typeof row.care_evidence === 'object' ? row.care_evidence : {}) as Record<string, unknown>
    const admittedAt = evidence.admittedAt ? parseShanghaiDateTime(String(evidence.admittedAt)) : null
    if (!admittedAt || Number.isNaN(admittedAt.getTime())) continue
    const hasStartTime = Boolean(evidence.careWorkerStartedAt)

    // 3.1 尚未确定护工开始时间：每 2 天上午 09:00 提醒
    if (!hasStartTime) {
      const requestedAt = row.care_requested_at ? parseShanghaiDateTime(row.care_requested_at) : null
      const baseTime = requestedAt && requestedAt > admittedAt ? requestedAt : admittedAt
      if (baseTime) {
        const cycleIdentity = `${row.care_step_id}:${row.occurrence_no ?? 0}:${new Date(baseTime).toISOString()}`
        const dedupeKey = `auto:care_start_unassigned:${row.source_order_no}`
        await closeStalePeriodicCycle(prisma, dedupeKey, cycleIdentity, row.huanyu_order_no)
        const diffDays = shanghaiCalendarDayDiff(baseTime, ymd)

        if (hours >= 9 && diffDays >= 2 && diffDays % 2 === 0) {
          const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 护工开始时间尚未确定，请跟进确认！`

          await upsertPeriodicReminder(prisma, {
            orderNo: row.source_order_no,
            huanyuOrderNo: row.huanyu_order_no,
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
    } else {
      await closeReminderByKey(prisma, `auto:care_start_unassigned:${row.source_order_no}`, 'resolved', row.huanyu_order_no)
    }

    // 3.2 护工结束前 2 个工作日提醒（扣除节假日）
    const endTimeRaw = row.care_end_date
    const serviceYmd = normalizeYmdValue(endTimeRaw)
    if (serviceYmd) {
        const endDate = parseYmdToShanghaiDate(serviceYmd)
        const { ymd: targetRemindYmd } = subtractWorkdays(endDate, 2)
        const dedupeKey = `auto:care_end_notify:${row.source_order_no}:${serviceYmd}`
        await closeReminderKeysExcept(prisma, `auto:care_end_notify:${row.source_order_no}:`, dedupeKey, 'superseded', row.huanyu_order_no)

        if (hours >= 9 && ymd === targetRemindYmd && ymd <= serviceYmd) {
          const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 护工服务结束日期临近，请确认客户后续安排！`

          await createReminderIfAbsent(prisma, {
            orderNo: row.source_order_no,
            huanyuOrderNo: row.huanyu_order_no,
            employeeId: row.assigned_employee_id,
            type: 'hospital_care',
            content,
            dedupeKey,
            logger,
            extra: { careEndDate: serviceYmd, serviceDate: serviceYmd }
          })
        }
    } else {
      await closeReminderKeysExcept(prisma, `auto:care_end_notify:${row.source_order_no}:`, null, 'expired', row.huanyu_order_no)
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
