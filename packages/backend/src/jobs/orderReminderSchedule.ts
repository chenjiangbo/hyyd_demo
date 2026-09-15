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

export interface LoggerLike {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string, err?: unknown) => void
}

const CHECK_INTERVAL_MS = 30_000 // 每 30 秒轮询一次
let timer: NodeJS.Timeout | null = null
let isRunning = false

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

/**
 * 插入提醒记录（基于 dedupe_key 幂等去重）
 */
async function createReminderIfAbsent(
  prisma: PrismaClient,
  params: {
    orderNo: string
    employeeId: number
    type: 'hospital_booking' | 'escort' | 'hospital_care'
    content: string
    dedupeKey: string
    logger?: LoggerLike
    extra?: Record<string, unknown>
  }
): Promise<boolean> {
  try {
    const existing = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM order_reminders WHERE extra_data->>'dedupe_key' = $1 LIMIT 1;`,
      params.dedupeKey
    )
    if (existing && existing.length > 0) {
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

/**
 * 场景 1：【约住院】排队跟进提醒（每 3 天上午 09:00 一次）
 */
async function scanHospitalBookingReminders(prisma: PrismaClient, logger?: LoggerLike): Promise<void> {
  const { ymd, hours } = shanghaiNowParts()
  if (hours < 9) return // 09:00 之后触发

  const steps = await prisma.$queryRawUnsafe<any[]>(`
    SELECT 
      s.id, s.activated_at, s.started_at, s.created_at AS step_created_at,
      o.id AS order_id, o.source_order_no, o.created_at AS order_created_at, o.assigned_employee_id, o.status AS order_status,
      op.service_type
    FROM b_order_service_steps s
    JOIN b_order_operations op ON s.operation_id = op.id
    JOIN orders o ON op.order_id = o.id
    WHERE s.step_code = 'hospital_booking'
      AND s.step_status IN ('pending', 'in_progress')
      AND o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
    LIMIT 200;
  `)

  for (const row of steps) {
    if (!row.assigned_employee_id || !row.source_order_no) continue

    const baseTime = row.activated_at || row.started_at || row.step_created_at || row.order_created_at
    if (!baseTime) continue

    const baseDate = new Date(baseTime)
    const now = new Date()
    const diffDays = Math.floor((now.getTime() - baseDate.getTime()) / (24 * 3600 * 1000))

    if (diffDays >= 3 && diffDays % 3 === 0) {
      const dedupeKey = `auto:hospital_booking:${row.source_order_no}:${ymd}`
      const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 客户意向的住院时间前还没有预约成功，请关注！`

      await createReminderIfAbsent(prisma, {
        orderNo: row.source_order_no,
        employeeId: row.assigned_employee_id,
        type: 'hospital_booking',
        content,
        dedupeKey,
        logger,
        extra: { diffDays, stage: 'hospital_booking' }
      })
    }
  }
}

/**
 * 场景 2.1：【陪诊】派单超时预警（前置完成满 1 小时未抓取到陪诊人）
 */
async function scanEscortUnassignedReminders(prisma: PrismaClient, logger?: LoggerLike): Promise<void> {
  const completedPreSteps = await prisma.$queryRawUnsafe<any[]>(`
    SELECT 
      s.id, s.step_code, s.completed_at,
      o.id AS order_id, o.source_order_no, o.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id, o.status AS order_status,
      h."PZR" AS huanyu_pzr
    FROM b_order_service_steps s
    JOIN b_order_operations op ON s.operation_id = op.id
    JOIN orders o ON op.order_id = o.id
    LEFT JOIN "HY_FACT_DDCX_NEW" h ON (h."BDQD_DDBH" = o.source_order_no OR (o.huanyu_order_no IS NOT NULL AND h."DDBH" = o.huanyu_order_no))
    WHERE s.step_code IN ('registration', 'check_booking', 'hospital_booking')
      AND s.step_status = 'completed'
      AND s.completed_at IS NOT NULL
      AND s.completed_at <= NOW() - INTERVAL '1 hour'
      AND s.completed_at >= NOW() - INTERVAL '3 days'
      AND o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
    LIMIT 200;
  `)

  for (const row of completedPreSteps) {
    if (!row.assigned_employee_id || !row.source_order_no) continue

    // 检查是否已有陪诊人
    const hasPzrInHuanyu = Boolean(row.huanyu_pzr && String(row.huanyu_pzr).trim())
    if (hasPzrInHuanyu) continue

    // 检查 fact_hy_pzrxx 表
    const ddbh = row.huanyu_order_no || row.source_order_no
    const escortRows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT "ZJ" FROM "fact_hy_pzrxx" WHERE "DDBH" = $1 LIMIT 1;`,
      ddbh
    )
    if (escortRows && escortRows.length > 0) continue

    const dedupeKey = `auto:escort_unassigned:${row.source_order_no}`
    const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 陪诊人员没有落实，请关注！`

    await createReminderIfAbsent(prisma, {
      orderNo: row.source_order_no,
      employeeId: row.assigned_employee_id,
      type: 'escort',
      content,
      dedupeKey,
      logger,
      extra: { preStepCode: row.step_code, completedAt: row.completed_at }
    })
  }
}

/**
 * 场景 2.2 & 2.3：【陪诊】前一天出工确认（11:00/13:00）与当天防迟到出工（07:00/07:20）
 */
async function scanEscortDailyCheckReminders(prisma: PrismaClient, logger?: LoggerLike): Promise<void> {
  const { ymd, time, hours, minutes } = shanghaiNowParts()
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000)
  const tomorrowYmd = formatYmd(tomorrow)

  // 1. 场景 2.2：前一天出工确认（11:00 发短信，13:00 检查未反馈或异常反馈）
  const preDayOrders = await prisma.$queryRawUnsafe<any[]>(`
    SELECT 
      o.id AS order_id, o.source_order_no, o.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id,
      COALESCE(p."PZR", h."PZR") AS pzr,
      COALESCE(p."BBQ_FW", h."BBQ_FW", h."DATE_FW") AS service_date,
      h."BBQ_FK", h."DATE_FK"
    FROM orders o
    LEFT JOIN "HY_FACT_DDCX_NEW" h ON (h."BDQD_DDBH" = o.source_order_no OR (o.huanyu_order_no IS NOT NULL AND h."DDBH" = o.huanyu_order_no))
    LEFT JOIN "fact_hy_pzrxx" p ON (p."DDBH" = o.huanyu_order_no OR p."DDBH" = o.source_order_no)
    WHERE (p."BBQ_FW" LIKE $1 OR h."BBQ_FW" LIKE $1 OR h."DATE_FW" LIKE $1)
      AND (p."PZR" IS NOT NULL AND p."PZR" != '' OR h."PZR" IS NOT NULL AND h."PZR" != '')
      AND o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
    LIMIT 200;
  `, `%${tomorrowYmd}%`)

  for (const row of preDayOrders) {
    // 检查 fact_hy_pzfk 表中的前一天反馈
    const feedbackList = await prisma.$queryRawUnsafe<any[]>(`
      SELECT will_attend, remark, created_at 
      FROM "fact_hy_pzfk" 
      WHERE (ddbh = $1 OR ddbh = $2) 
        AND feedback_type = 'pre_day' 
        AND created_at >= CURRENT_DATE - INTERVAL '1 day'
      ORDER BY created_at DESC 
      LIMIT 1;
    `, row.source_order_no, row.huanyu_order_no || '')

    const feedback = feedbackList[0]

    // 情况 A：已提交但反馈【无法出工（不去）】，立即报警
    if (feedback && feedback.will_attend === false) {
      const dedupeKey = `auto:escort_pre_day_reject:${row.source_order_no}:${ymd}`
      const reasonText = feedback.remark ? `（原因：${feedback.remark}）` : ''
      const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 陪诊人员反馈【无法出工】${reasonText}，请立即处理！`

      await createReminderIfAbsent(prisma, {
        orderNo: row.source_order_no,
        employeeId: row.assigned_employee_id,
        type: 'escort',
        content,
        dedupeKey,
        logger,
        extra: { serviceDate: tomorrowYmd, pzr: row.pzr, willAttend: false, remark: feedback.remark }
      })
      continue
    }

    // 情况 B：已提交且确认出工，正常通过，无需提醒
    if (feedback && feedback.will_attend === true) {
      continue
    }

    // 情况 C：未在 fact_hy_pzfk 中提交反馈，且旧表也无反馈
    const hasLegacyFeedback = Boolean((row.BBQ_FK && String(row.BBQ_FK).trim()) || (row.DATE_FK && String(row.DATE_FK).trim()))
    if (!hasLegacyFeedback && hours >= 13) {
      const dedupeKey = `auto:escort_pre_day_unack:${row.source_order_no}:${ymd}`
      const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 陪诊人员没有第一次反馈信息，请关注！`

      await createReminderIfAbsent(prisma, {
        orderNo: row.source_order_no,
        employeeId: row.assigned_employee_id,
        type: 'escort',
        content,
        dedupeKey,
        logger,
        extra: { serviceDate: tomorrowYmd, pzr: row.pzr }
      })
    }
  }

  // 2. 场景 2.3：当天防迟到出工（07:00 发短信，07:20 检查未反馈或异常反馈）
  const isAfter720 = hours > 7 || (hours === 7 && minutes >= 20)
  const sameDayOrders = await prisma.$queryRawUnsafe<any[]>(`
    SELECT 
      o.id AS order_id, o.source_order_no, o.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id,
      COALESCE(p."PZR", h."PZR") AS pzr,
      COALESCE(p."BBQ_FW", h."BBQ_FW", h."DATE_FW") AS service_date,
      h."BBQ_FK", h."DATE_FK"
    FROM orders o
    LEFT JOIN "HY_FACT_DDCX_NEW" h ON (h."BDQD_DDBH" = o.source_order_no OR (o.huanyu_order_no IS NOT NULL AND h."DDBH" = o.huanyu_order_no))
    LEFT JOIN "fact_hy_pzrxx" p ON (p."DDBH" = o.huanyu_order_no OR p."DDBH" = o.source_order_no)
    WHERE (p."BBQ_FW" LIKE $1 OR h."BBQ_FW" LIKE $1 OR h."DATE_FW" LIKE $1)
      AND (p."PZR" IS NOT NULL AND p."PZR" != '' OR h."PZR" IS NOT NULL AND h."PZR" != '')
      AND o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
    LIMIT 200;
  `, `%${ymd}%`)

  for (const row of sameDayOrders) {
    const feedbackList = await prisma.$queryRawUnsafe<any[]>(`
      SELECT will_attend, remark, created_at 
      FROM "fact_hy_pzfk" 
      WHERE (ddbh = $1 OR ddbh = $2) 
        AND feedback_type = 'same_day' 
        AND created_at >= CURRENT_DATE
      ORDER BY created_at DESC 
      LIMIT 1;
    `, row.source_order_no, row.huanyu_order_no || '')

    const feedback = feedbackList[0]

    // 情况 A：当天反馈【无法出工（不去）】，立即报警
    if (feedback && feedback.will_attend === false) {
      const dedupeKey = `auto:escort_same_day_reject:${row.source_order_no}:${ymd}`
      const reasonText = feedback.remark ? `（原因：${feedback.remark}）` : ''
      const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 陪诊人员当天反馈【无法出工】${reasonText}，请紧急处理！`

      await createReminderIfAbsent(prisma, {
        orderNo: row.source_order_no,
        employeeId: row.assigned_employee_id,
        type: 'escort',
        content,
        dedupeKey,
        logger,
        extra: { serviceDate: ymd, triggerTime: time, pzr: row.pzr, willAttend: false, remark: feedback.remark }
      })
      continue
    }

    // 情况 B：已反馈确认出工，正常通过
    if (feedback && feedback.will_attend === true) {
      continue
    }

    // 情况 C：07:20 后未收到当天反馈
    const hasLegacyFeedback = Boolean((row.BBQ_FK && String(row.BBQ_FK).trim()) || (row.DATE_FK && String(row.DATE_FK).trim()))
    if (!hasLegacyFeedback && isAfter720) {
      const dedupeKey = `auto:escort_same_day_unack:${row.source_order_no}:${ymd}`
      const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 陪诊人员没有第一次反馈信息，请关注！`

      await createReminderIfAbsent(prisma, {
        orderNo: row.source_order_no,
        employeeId: row.assigned_employee_id,
        type: 'escort',
        content,
        dedupeKey,
        logger,
        extra: { serviceDate: ymd, triggerTime: time, pzr: row.pzr }
      })
    }
  }
}

/**
 * 场景 3.1 & 3.2：【住院陪护】确认护工开始时间与结束前提醒
 */
async function scanHospitalCareReminders(prisma: PrismaClient, logger?: LoggerLike): Promise<void> {
  const { ymd, hours } = shanghaiNowParts()
  if (hours < 9) return // 上午 09:00 后触发

  const careOrders = await prisma.$queryRawUnsafe<any[]>(`
    SELECT 
      o.id AS order_id, o.source_order_no, o.created_at AS order_created_at, o.assigned_employee_id, o.status AS order_status,
      op.service_type,
      h."BBQ_FW" AS care_start_time, h."DATE_FW" AS care_start_date,
      h."BBQ_QDFW" AS care_end_time, h."DATE_QDFW" AS care_end_date,
      s.activated_at AS care_activated_at
    FROM orders o
    JOIN b_order_operations op ON op.order_id = o.id
    LEFT JOIN b_order_service_steps s ON s.operation_id = op.id AND s.step_code = 'hospital_care'
    LEFT JOIN "HY_FACT_DDCX_NEW" h ON (h."BDQD_DDBH" = o.source_order_no OR (o.huanyu_order_no IS NOT NULL AND h."DDBH" = o.huanyu_order_no))
    WHERE (op.service_type = '住院护工协助' OR o.status LIKE '%护工%' OR o.status LIKE '%住院%')
      AND o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
    LIMIT 200;
  `)

  for (const row of careOrders) {
    if (!row.assigned_employee_id || !row.source_order_no) continue

    const hasStartTime = Boolean(
      (row.care_start_time && String(row.care_start_time).trim()) ||
      (row.care_start_date && String(row.care_start_date).trim())
    )

    // 3.1 尚未确定护工开始时间：每 2 天上午 09:00 提醒
    if (!hasStartTime) {
      const baseTime = row.care_activated_at || row.order_created_at
      if (baseTime) {
        const baseDate = new Date(baseTime)
        const now = new Date()
        const diffDays = Math.floor((now.getTime() - baseDate.getTime()) / (24 * 3600 * 1000))

        if (diffDays >= 2 && diffDays % 2 === 0) {
          const dedupeKey = `auto:care_start_unassigned:${row.source_order_no}:${ymd}`
          const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 客户处于住院期间，请定期关注客户满意度情况！`

          await createReminderIfAbsent(prisma, {
            orderNo: row.source_order_no,
            employeeId: row.assigned_employee_id,
            type: 'hospital_care',
            content,
            dedupeKey,
            logger,
            extra: { diffDays }
          })
        }
      }
    }

    // 3.2 护工结束前 2 个工作日提醒（扣除节假日）
    const endTimeRaw = row.care_end_time || row.care_end_date
    if (endTimeRaw) {
      const endDateStr = String(endTimeRaw).trim()
      const match = /^(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})/.exec(endDateStr)
      if (match) {
        const endDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
        const { ymd: targetRemindYmd } = subtractWorkdays(endDate, 2)

        if (ymd === targetRemindYmd) {
          const dedupeKey = `auto:care_end_notify:${row.source_order_no}`
          const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 客户出院时间到了，请关注客户后续行程！`

          await createReminderIfAbsent(prisma, {
            orderNo: row.source_order_no,
            employeeId: row.assigned_employee_id,
            type: 'hospital_care',
            content,
            dedupeKey,
            logger,
            extra: { careEndDate: targetRemindYmd }
          })
        }
      }
    }
  }
}

/**
 * 单次扫描总入口
 */
export async function runOrderReminderCycle(prisma: PrismaClient, logger?: LoggerLike): Promise<void> {
  if (isRunning) return
  isRunning = true
  try {
    await scanHospitalBookingReminders(prisma, logger)
    await scanEscortUnassignedReminders(prisma, logger)
    await scanEscortDailyCheckReminders(prisma, logger)
    await scanHospitalCareReminders(prisma, logger)
  } catch (err) {
    logger?.error('[orderReminderSchedule] 定时提醒扫描异常:', err)
  } finally {
    isRunning = false
  }
}

/**
 * 启动后台常驻定时扫描
 */
export function startOrderReminderSchedule(prisma: PrismaClient, logger?: LoggerLike): void {
  if (timer) clearInterval(timer)

  logger?.info('[orderReminderSchedule] 订单自动提醒扫描任务已启动，轮询周期: 30秒')

  // 启动即执行一轮
  void runOrderReminderCycle(prisma, logger)

  timer = setInterval(() => {
    void runOrderReminderCycle(prisma, logger)
  }, CHECK_INTERVAL_MS)
}

export function stopOrderReminderSchedule(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
