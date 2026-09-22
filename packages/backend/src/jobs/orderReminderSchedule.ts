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
import { getEnv } from '../env.js'
import { sendAliyunSms, getSmsConfig } from '../services/aliyunSmsService.js'
import { listHuanyuEscorts } from '../db/remoteDictionary.js'

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
    type: 'hospital_booking' | 'escort' | 'hospital_care' | 'system' | 'upload_recording'
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
      AND op.service_type IN ('全流程', '住院')
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
 * 逻辑：
 * 1. 彻底不取 HY_FACT_DDCX_NEW.PZR
 * 2. 优先查正式表 fact_hy_pzrxx（有值则直接视为已落实）
 * 3. 库里没有（无人手动保存），取 AI 候选表 b_order_ai_field_candidates 中的 escort_name（排除无效占位词）
 * 4. 仅当两处皆无陪诊人员，且前置完成满 1 小时，才写入超时未落实预警
 * 5. 不向数据库做任何回写
 */
async function scanEscortUnassignedReminders(prisma: PrismaClient, logger?: LoggerLike): Promise<void> {
  const completedPreSteps = await prisma.$queryRawUnsafe<any[]>(`
    SELECT 
      s.id, s.step_code, s.completed_at,
      o.id AS order_id, o.source_order_no, o.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id, o.status AS order_status,
      op.service_type,
      EXISTS(
        SELECT 1 FROM "fact_hy_pzrxx" p 
        WHERE (p."DDBH" = o.source_order_no OR (o.huanyu_order_no IS NOT NULL AND p."DDBH" = o.huanyu_order_no))
          AND p."PZR" IS NOT NULL AND TRIM(p."PZR") != ''
      ) AS has_db_pzr,
      (
        SELECT c.value_text FROM b_order_ai_field_candidates c
        WHERE c.order_id = o.id 
          AND c.field_code = 'escort_name'
          AND c.status != 'dismissed'
          AND TRIM(c.value_text) NOT IN ('', '无', '待定', '暂无', '待安排', '待分配', '未指派', '未安排', '无陪诊', '不需陪诊', '不需要陪诊')
        ORDER BY c.created_at DESC
        LIMIT 1
      ) AS ai_pzr
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
      AND s.completed_at >= NOW() - INTERVAL '3 days'
      AND o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
      AND EXISTS (
        SELECT 1 FROM b_order_service_steps cstep
        WHERE cstep.operation_id = op.id
          AND cstep.step_code IN ('escort', 'check_companion', 'hospital_companion', 'revisit_escort')
          AND cstep.step_status != 'cancelled'
      )
    LIMIT 200;
  `)

  for (const row of completedPreSteps) {
    if (!row.assigned_employee_id || !row.source_order_no) continue

    // 1. 优先检查正式库 fact_hy_pzrxx
    if (row.has_db_pzr) continue

    // 2. 若正式库没有，检查 AI 提取到的候选数据（无需用户在页面点保存）
    if (row.ai_pzr && String(row.ai_pzr).trim()) continue

    const dedupeKey = `auto:escort_unassigned:${row.source_order_no}:${row.step_code}`
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
 * 辅助方法：解析陪诊人员手机号
 * 优先级：
 * 1. 本地陪诊人员表 f_hy_pzr (name / id)
 * 2. 远端 MySQL 字典库 dim_hy_pzr
 * 3. AI 候选表 b_order_ai_field_candidates (escort_phone)
 */
async function resolveEscortPhone(
  prisma: PrismaClient,
  pzrName: string | null | undefined,
  orderId: number | null | undefined
): Promise<string | null> {
  const cleanName = (pzrName || '').trim()
  if (cleanName) {
    try {
      const rows = await prisma.$queryRawUnsafe<any[]>(`
        SELECT "sj" FROM "f_hy_pzr"
        WHERE ("name" = $1 OR "id" = $1)
          AND "sj" IS NOT NULL AND TRIM("sj") != ''
        LIMIT 1;
      `, cleanName)
      if (rows && rows[0]?.sj && String(rows[0].sj).trim()) {
        return String(rows[0].sj).trim()
      }
    } catch {
      // 忽略查询异常
    }

    try {
      const escorts = await listHuanyuEscorts(cleanName)
      const matched = escorts.find((e) => e.id === cleanName || e.name === cleanName) || escorts[0]
      if (matched && matched.phone && String(matched.phone).trim()) {
        return String(matched.phone).trim()
      }
    } catch {
      // 忽略远端异常
    }
  }

  if (orderId) {
    try {
      const aiRows = await prisma.$queryRawUnsafe<any[]>(`
        SELECT value_text FROM b_order_ai_field_candidates
        WHERE order_id = $1
          AND field_code = 'escort_phone'
          AND status != 'dismissed'
          AND TRIM(value_text) != ''
        ORDER BY created_at DESC
        LIMIT 1;
      `, orderId)
      if (aiRows && aiRows[0]?.value_text && String(aiRows[0].value_text).trim()) {
        return String(aiRows[0].value_text).trim()
      }
    } catch {
      // 忽略查询异常
    }
  }

  return null
}

/**
 * 场景 2.2-A：【陪诊】前一天 11:00 自动发送出工确认短信（模板：SMS_512665048）
 * 逻辑：
 * 1. 每天 11:00 启动扫描明日出工的陪诊订单（白名单服务类型）；
 * 2. 解析陪诊人员手机号，调用阿里云 SendSms 接口下发短信，参数为 { orderNo: source_order_no }；
 * 3. 发送成功：记录流水表 fact_hy_pz_sms_logs (status = 'success')，静默等待反馈，不打扰客户经理；
 * 4. 发送失败（或未找到手机号）：记录流水表 (status = 'failed')，并【立即向责任客户经理报警】，通知人工及时介入！
 */
async function sendPreDayEscortSms(prisma: PrismaClient, logger?: LoggerLike): Promise<void> {
  const { ymd, hours } = shanghaiNowParts()
  if (hours < 11) return // 11:00 前不执行

  const smsConfig = await getSmsConfig(prisma)
  if (!smsConfig.enabled) {
    return
  }

  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000)
  const tomorrowYmd = formatYmd(tomorrow)
  const templateCode = smsConfig.templatePreDay || 'SMS_512665048'
  const signName = smsConfig.signName || '寰宇医道'

  const preDayOrders = await prisma.$queryRawUnsafe<any[]>(`
    SELECT 
      o.id AS order_id, o.source_order_no, o.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id,
      op.service_type,
      COALESCE(
        NULLIF(TRIM(p."PZR"), ''),
        ai_escort.value_text
      ) AS pzr,
      COALESCE(
        NULLIF(TRIM(p."BBQ_FW"), ''),
        ai_date.value_text,
        h."BBQ_FW",
        h."DATE_FW"
      ) AS service_date
    FROM orders o
    JOIN b_order_operations op ON op.order_id = o.id
    LEFT JOIN "HY_FACT_DDCX_NEW" h ON (h."BDQD_DDBH" = o.source_order_no OR (o.huanyu_order_no IS NOT NULL AND h."DDBH" = o.huanyu_order_no))
    LEFT JOIN LATERAL (
      SELECT "PZR", "BBQ_FW" FROM "fact_hy_pzrxx" p 
      WHERE (p."DDBH" = o.huanyu_order_no OR p."DDBH" = o.source_order_no)
        AND p."PZR" IS NOT NULL AND TRIM(p."PZR") != ''
      ORDER BY "xtsj" DESC NULLS LAST, "ZJ" DESC
      LIMIT 1
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT value_text FROM b_order_ai_field_candidates c
      WHERE c.order_id = o.id 
        AND c.field_code = 'escort_name'
        AND c.status != 'dismissed'
        AND TRIM(c.value_text) NOT IN ('', '无', '待定', '暂无', '待安排', '待分配', '未指派', '未安排', '无陪诊', '不需陪诊', '不需要陪诊')
      ORDER BY c.created_at DESC
      LIMIT 1
    ) ai_escort ON true
    LEFT JOIN LATERAL (
      SELECT value_text FROM b_order_ai_field_candidates c
      WHERE c.order_id = o.id 
        AND c.field_code = 'escort_service_date'
        AND c.status != 'dismissed'
        AND TRIM(c.value_text) NOT IN ('', '无', '待定', '暂无')
      ORDER BY c.created_at DESC
      LIMIT 1
    ) ai_date ON true
    WHERE o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
      AND op.service_type IN ('全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '检查加急', '住院')
      AND EXISTS (
        SELECT 1 FROM b_order_service_steps cstep
        WHERE cstep.operation_id = op.id
          AND cstep.step_code IN ('escort', 'check_companion', 'hospital_companion', 'revisit_escort')
          AND cstep.step_status != 'cancelled'
      )
      AND (
        (p."BBQ_FW" LIKE $1)
        OR (p."BBQ_FW" IS NULL AND ai_date.value_text LIKE $1)
        OR (p."BBQ_FW" IS NULL AND ai_date.value_text IS NULL AND (h."BBQ_FW" LIKE $1 OR h."DATE_FW" LIKE $1))
      )
      AND (
        (p."PZR" IS NOT NULL AND TRIM(p."PZR") != '')
        OR (ai_escort.value_text IS NOT NULL AND TRIM(ai_escort.value_text) != '')
      )
    LIMIT 200;
  `, `%${tomorrowYmd}%`)

  for (const row of preDayOrders) {
    if (!row.assigned_employee_id || !row.source_order_no) continue

    // 检查今天是否已处理过该订单前一天短信发送
    const existingLog = await prisma.$queryRawUnsafe<any[]>(`
      SELECT id, status FROM "fact_hy_pz_sms_logs"
      WHERE order_no = $1 AND batch_type = 'pre_day' AND send_ymd = $2
      LIMIT 1;
    `, row.source_order_no, ymd)

    if (existingLog && existingLog.length > 0) {
      continue
    }

    const phone = await resolveEscortPhone(prisma, row.pzr, row.order_id)
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
        `, row.source_order_no, cleanPhone, row.pzr, tomorrowYmd, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no }), result.bizId, result.requestId, ymd)

        logger?.info(`[orderReminderSchedule] 前一天出工确认短信发送成功: 订单 ${row.source_order_no}, 手机 ${cleanPhone}, bizId=${result.bizId}`)
      } else {
        await prisma.$executeRawUnsafe(`
          INSERT INTO "fact_hy_pz_sms_logs" (
            order_no, batch_type, phone, pzr_name, service_date, template_code, sign_name,
            params_json, request_id, status, error_code, error_message, send_ymd, created_at
          ) VALUES ($1, 'pre_day', $2, $3, $4, $5, $6, $7::jsonb, $8, 'failed', $9, $10, $11, NOW());
        `, row.source_order_no, cleanPhone, row.pzr, tomorrowYmd, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no }), result.requestId, result.code, result.message, ymd)

        logger?.warn(`[orderReminderSchedule] 前一天出工确认短信发送失败: 订单 ${row.source_order_no}, 错误: ${result.message}`)

        const dedupeKey = `auto:escort_sms_failed:${row.source_order_no}:pre_day:${ymd}`
        const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 陪诊出工确认短信发送失败（原因：${result.message}），请及时人工联系陪诊人员！`

        await createReminderIfAbsent(prisma, {
          orderNo: row.source_order_no,
          employeeId: row.assigned_employee_id,
          type: 'escort',
          content,
          dedupeKey,
          logger,
          extra: { failureReason: result.message, phone: cleanPhone, pzr: row.pzr, batchType: 'pre_day' }
        })
      }
    } else {
      await prisma.$executeRawUnsafe(`
        INSERT INTO "fact_hy_pz_sms_logs" (
          order_no, batch_type, pzr_name, service_date, template_code, sign_name,
          params_json, status, error_code, error_message, send_ymd, created_at
        ) VALUES ($1, 'pre_day', $2, $3, $4, $5, $6::jsonb, 'failed', 'NO_PHONE', '未配置有效陪诊人员手机号', $7, NOW());
      `, row.source_order_no, row.pzr, tomorrowYmd, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no }), ymd)

      logger?.warn(`[orderReminderSchedule] 前一天出工短信未发送：未找到陪诊人手机号: 订单 ${row.source_order_no}, 陪诊人 ${row.pzr}`)

      const dedupeKey = `auto:escort_sms_failed:${row.source_order_no}:pre_day:${ymd}`
      const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 未找到陪诊人员有效手机号，出工确认短信无法发送，请及时人工联系陪诊人员！`

      await createReminderIfAbsent(prisma, {
        orderNo: row.source_order_no,
        employeeId: row.assigned_employee_id,
        type: 'escort',
        content,
        dedupeKey,
        logger,
        extra: { failureReason: '未配置有效陪诊人员手机号', pzr: row.pzr, batchType: 'pre_day' }
      })
    }
  }
}

/**
 * 场景 2.3-A：【陪诊】当天 07:00 自动发送出工打卡短信（模板：SMS_512530051）
 * 逻辑：
 * 1. 每天 07:00 启动扫描当天出工的陪诊订单（白名单服务类型）；
 * 2. 下发打卡短信；成功记录流水，失败立即报警通知客户经理。
 */
async function sendSameDayEscortSms(prisma: PrismaClient, logger?: LoggerLike): Promise<void> {
  const { ymd, hours } = shanghaiNowParts()
  if (hours < 7) return // 07:00 前不执行

  const smsConfig = await getSmsConfig(prisma)
  if (!smsConfig.enabled) {
    return
  }

  const templateCode = smsConfig.templateSameDay || 'SMS_512530051'
  const signName = smsConfig.signName || '寰宇医道'

  const sameDayOrders = await prisma.$queryRawUnsafe<any[]>(`
    SELECT 
      o.id AS order_id, o.source_order_no, o.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id,
      op.service_type,
      COALESCE(
        NULLIF(TRIM(p."PZR"), ''),
        ai_escort.value_text
      ) AS pzr,
      COALESCE(
        NULLIF(TRIM(p."BBQ_FW"), ''),
        ai_date.value_text,
        h."BBQ_FW",
        h."DATE_FW"
      ) AS service_date
    FROM orders o
    JOIN b_order_operations op ON op.order_id = o.id
    LEFT JOIN "HY_FACT_DDCX_NEW" h ON (h."BDQD_DDBH" = o.source_order_no OR (o.huanyu_order_no IS NOT NULL AND h."DDBH" = o.huanyu_order_no))
    LEFT JOIN LATERAL (
      SELECT "PZR", "BBQ_FW" FROM "fact_hy_pzrxx" p 
      WHERE (p."DDBH" = o.huanyu_order_no OR p."DDBH" = o.source_order_no)
        AND p."PZR" IS NOT NULL AND TRIM(p."PZR") != ''
      ORDER BY "xtsj" DESC NULLS LAST, "ZJ" DESC
      LIMIT 1
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT value_text FROM b_order_ai_field_candidates c
      WHERE c.order_id = o.id 
        AND c.field_code = 'escort_name'
        AND c.status != 'dismissed'
        AND TRIM(c.value_text) NOT IN ('', '无', '待定', '暂无', '待安排', '待分配', '未指派', '未安排', '无陪诊', '不需陪诊', '不需要陪诊')
      ORDER BY c.created_at DESC
      LIMIT 1
    ) ai_escort ON true
    LEFT JOIN LATERAL (
      SELECT value_text FROM b_order_ai_field_candidates c
      WHERE c.order_id = o.id 
        AND c.field_code = 'escort_service_date'
        AND c.status != 'dismissed'
        AND TRIM(c.value_text) NOT IN ('', '无', '待定', '暂无')
      ORDER BY c.created_at DESC
      LIMIT 1
    ) ai_date ON true
    WHERE o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
      AND op.service_type IN ('全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '检查加急', '住院')
      AND EXISTS (
        SELECT 1 FROM b_order_service_steps cstep
        WHERE cstep.operation_id = op.id
          AND cstep.step_code IN ('escort', 'check_companion', 'hospital_companion', 'revisit_escort')
          AND cstep.step_status != 'cancelled'
      )
      AND (
        (p."BBQ_FW" LIKE $1)
        OR (p."BBQ_FW" IS NULL AND ai_date.value_text LIKE $1)
        OR (p."BBQ_FW" IS NULL AND ai_date.value_text IS NULL AND (h."BBQ_FW" LIKE $1 OR h."DATE_FW" LIKE $1))
      )
      AND (
        (p."PZR" IS NOT NULL AND TRIM(p."PZR") != '')
        OR (ai_escort.value_text IS NOT NULL AND TRIM(ai_escort.value_text) != '')
      )
    LIMIT 200;
  `, `%${ymd}%`)

  for (const row of sameDayOrders) {
    if (!row.assigned_employee_id || !row.source_order_no) continue

    const existingLog = await prisma.$queryRawUnsafe<any[]>(`
      SELECT id, status FROM "fact_hy_pz_sms_logs"
      WHERE order_no = $1 AND batch_type = 'same_day' AND send_ymd = $2
      LIMIT 1;
    `, row.source_order_no, ymd)

    if (existingLog && existingLog.length > 0) {
      continue
    }

    const phone = await resolveEscortPhone(prisma, row.pzr, row.order_id)
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
        `, row.source_order_no, cleanPhone, row.pzr, ymd, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no }), result.bizId, result.requestId, ymd)

        logger?.info(`[orderReminderSchedule] 当日出工打卡短信发送成功: 订单 ${row.source_order_no}, 手机 ${cleanPhone}, bizId=${result.bizId}`)
      } else {
        await prisma.$executeRawUnsafe(`
          INSERT INTO "fact_hy_pz_sms_logs" (
            order_no, batch_type, phone, pzr_name, service_date, template_code, sign_name,
            params_json, request_id, status, error_code, error_message, send_ymd, created_at
          ) VALUES ($1, 'same_day', $2, $3, $4, $5, $6, $7::jsonb, $8, 'failed', $9, $10, $11, NOW());
        `, row.source_order_no, cleanPhone, row.pzr, ymd, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no }), result.requestId, result.code, result.message, ymd)

        logger?.warn(`[orderReminderSchedule] 当日出工打卡短信发送失败: 订单 ${row.source_order_no}, 错误: ${result.message}`)

        const dedupeKey = `auto:escort_sms_failed:${row.source_order_no}:same_day:${ymd}`
        const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 陪诊当日出工打卡短信发送失败（原因：${result.message}），请紧急人工联系陪诊人员！`

        await createReminderIfAbsent(prisma, {
          orderNo: row.source_order_no,
          employeeId: row.assigned_employee_id,
          type: 'escort',
          content,
          dedupeKey,
          logger,
          extra: { failureReason: result.message, phone: cleanPhone, pzr: row.pzr, batchType: 'same_day' }
        })
      }
    } else {
      await prisma.$executeRawUnsafe(`
        INSERT INTO "fact_hy_pz_sms_logs" (
          order_no, batch_type, pzr_name, service_date, template_code, sign_name,
          params_json, status, error_code, error_message, send_ymd, created_at
        ) VALUES ($1, 'same_day', $2, $3, $4, $5, $6::jsonb, 'failed', 'NO_PHONE', '未配置有效陪诊人员手机号', $7, NOW());
      `, row.source_order_no, row.pzr, ymd, templateCode, signName, JSON.stringify({ orderNo: row.source_order_no }), ymd)

      logger?.warn(`[orderReminderSchedule] 当日出工短信未发送：未找到陪诊人手机号: 订单 ${row.source_order_no}, 陪诊人 ${row.pzr}`)

      const dedupeKey = `auto:escort_sms_failed:${row.source_order_no}:same_day:${ymd}`
      const content = `订单号: ${row.source_order_no}\n申请时间: ${formatDateDisplay(row.order_created_at)}\n提醒内容: 未找到陪诊人员有效手机号，当日出工打卡短信无法发送，请紧急人工联系陪诊人员！`

      await createReminderIfAbsent(prisma, {
        orderNo: row.source_order_no,
        employeeId: row.assigned_employee_id,
        type: 'escort',
        content,
        dedupeKey,
        logger,
        extra: { failureReason: '未配置有效陪诊人员手机号', pzr: row.pzr, batchType: 'same_day' }
      })
    }
  }
}

/**
 * 场景 2.2-B & 2.3-B：【陪诊】前一天出工反馈监控（13:00）与当天防迟到出工监控（07:20）
 * 核心门禁：
 * 1. 绝不取 HY_FACT_DDCX_NEW.PZR
 * 2. 陪诊人员优先取 fact_hy_pzrxx.PZR；若无则取 AI 候选表 b_order_ai_field_candidates 的 escort_name
 * 3. 严格限定白名单服务类型，排除住院护工协助等非陪诊订单
 * 4. 【关键门禁】：未反馈提醒仅在今天成功发送过对应批次短信的前提下才触发！未发短信或发送失败（已报警）绝不重复误报！
 */
async function scanEscortDailyCheckReminders(prisma: PrismaClient, logger?: LoggerLike): Promise<void> {
  const { ymd, time, hours, minutes } = shanghaiNowParts()
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000)
  const tomorrowYmd = formatYmd(tomorrow)

  // 1. 场景 2.2：前一天出工确认（11:00 发短信，13:00 检查未反馈或异常反馈）
  const preDayOrders = await prisma.$queryRawUnsafe<any[]>(`
    SELECT 
      o.id AS order_id, o.source_order_no, o.huanyu_order_no, o.created_at AS order_created_at, o.assigned_employee_id,
      op.service_type,
      COALESCE(
        NULLIF(TRIM(p."PZR"), ''),
        ai_escort.value_text
      ) AS pzr,
      COALESCE(
        NULLIF(TRIM(p."BBQ_FW"), ''),
        ai_date.value_text,
        h."BBQ_FW",
        h."DATE_FW"
      ) AS service_date,
      h."BBQ_FK", h."DATE_FK"
    FROM orders o
    JOIN b_order_operations op ON op.order_id = o.id
    LEFT JOIN "HY_FACT_DDCX_NEW" h ON (h."BDQD_DDBH" = o.source_order_no OR (o.huanyu_order_no IS NOT NULL AND h."DDBH" = o.huanyu_order_no))
    LEFT JOIN LATERAL (
      SELECT "PZR", "BBQ_FW" FROM "fact_hy_pzrxx" p 
      WHERE (p."DDBH" = o.huanyu_order_no OR p."DDBH" = o.source_order_no)
        AND p."PZR" IS NOT NULL AND TRIM(p."PZR") != ''
      ORDER BY "xtsj" DESC NULLS LAST, "ZJ" DESC
      LIMIT 1
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT value_text FROM b_order_ai_field_candidates c
      WHERE c.order_id = o.id 
        AND c.field_code = 'escort_name'
        AND c.status != 'dismissed'
        AND TRIM(c.value_text) NOT IN ('', '无', '待定', '暂无', '待安排', '待分配', '未指派', '未安排', '无陪诊', '不需陪诊', '不需要陪诊')
      ORDER BY c.created_at DESC
      LIMIT 1
    ) ai_escort ON true
    LEFT JOIN LATERAL (
      SELECT value_text FROM b_order_ai_field_candidates c
      WHERE c.order_id = o.id 
        AND c.field_code = 'escort_service_date'
        AND c.status != 'dismissed'
        AND TRIM(c.value_text) NOT IN ('', '无', '待定', '暂无')
      ORDER BY c.created_at DESC
      LIMIT 1
    ) ai_date ON true
    WHERE o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
      AND op.service_type IN ('全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '检查加急', '住院')
      AND EXISTS (
        SELECT 1 FROM b_order_service_steps cstep
        WHERE cstep.operation_id = op.id
          AND cstep.step_code IN ('escort', 'check_companion', 'hospital_companion', 'revisit_escort')
          AND cstep.step_status != 'cancelled'
      )
      AND (
        (p."BBQ_FW" LIKE $1)
        OR (p."BBQ_FW" IS NULL AND ai_date.value_text LIKE $1)
        OR (p."BBQ_FW" IS NULL AND ai_date.value_text IS NULL AND (h."BBQ_FW" LIKE $1 OR h."DATE_FW" LIKE $1))
      )
      AND (
        (p."PZR" IS NOT NULL AND TRIM(p."PZR") != '')
        OR (ai_escort.value_text IS NOT NULL AND TRIM(ai_escort.value_text) != '')
      )
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
      // 强前置门禁：必须检查今天是否向该陪诊员成功发送过前一天出工短信！
      const smsLog = await prisma.$queryRawUnsafe<any[]>(`
        SELECT id FROM "fact_hy_pz_sms_logs"
        WHERE order_no = $1 AND batch_type = 'pre_day' AND send_ymd = $2 AND status = 'success'
        LIMIT 1;
      `, row.source_order_no, ymd)

      if (!smsLog || smsLog.length === 0) {
        // 未发送短信或发送失败（发送失败已在 11:00 报警过），绝不报未反馈假提醒
        continue
      }

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
      op.service_type,
      COALESCE(
        NULLIF(TRIM(p."PZR"), ''),
        ai_escort.value_text
      ) AS pzr,
      COALESCE(
        NULLIF(TRIM(p."BBQ_FW"), ''),
        ai_date.value_text,
        h."BBQ_FW",
        h."DATE_FW"
      ) AS service_date,
      h."BBQ_FK", h."DATE_FK"
    FROM orders o
    JOIN b_order_operations op ON op.order_id = o.id
    LEFT JOIN "HY_FACT_DDCX_NEW" h ON (h."BDQD_DDBH" = o.source_order_no OR (o.huanyu_order_no IS NOT NULL AND h."DDBH" = o.huanyu_order_no))
    LEFT JOIN LATERAL (
      SELECT "PZR", "BBQ_FW" FROM "fact_hy_pzrxx" p 
      WHERE (p."DDBH" = o.huanyu_order_no OR p."DDBH" = o.source_order_no)
        AND p."PZR" IS NOT NULL AND TRIM(p."PZR") != ''
      ORDER BY "xtsj" DESC NULLS LAST, "ZJ" DESC
      LIMIT 1
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT value_text FROM b_order_ai_field_candidates c
      WHERE c.order_id = o.id 
        AND c.field_code = 'escort_name'
        AND c.status != 'dismissed'
        AND TRIM(c.value_text) NOT IN ('', '无', '待定', '暂无', '待安排', '待分配', '未指派', '未安排', '无陪诊', '不需陪诊', '不需要陪诊')
      ORDER BY c.created_at DESC
      LIMIT 1
    ) ai_escort ON true
    LEFT JOIN LATERAL (
      SELECT value_text FROM b_order_ai_field_candidates c
      WHERE c.order_id = o.id 
        AND c.field_code = 'escort_service_date'
        AND c.status != 'dismissed'
        AND TRIM(c.value_text) NOT IN ('', '无', '待定', '暂无')
      ORDER BY c.created_at DESC
      LIMIT 1
    ) ai_date ON true
    WHERE o.assigned_employee_id IS NOT NULL
      AND (o.status IS NULL OR (o.status NOT LIKE '%取消%' AND o.status != '已完成'))
      AND op.service_type IN ('全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '检查加急', '住院')
      AND EXISTS (
        SELECT 1 FROM b_order_service_steps cstep
        WHERE cstep.operation_id = op.id
          AND cstep.step_code IN ('escort', 'check_companion', 'hospital_companion', 'revisit_escort')
          AND cstep.step_status != 'cancelled'
      )
      AND (
        (p."BBQ_FW" LIKE $1)
        OR (p."BBQ_FW" IS NULL AND ai_date.value_text LIKE $1)
        OR (p."BBQ_FW" IS NULL AND ai_date.value_text IS NULL AND (h."BBQ_FW" LIKE $1 OR h."DATE_FW" LIKE $1))
      )
      AND (
        (p."PZR" IS NOT NULL AND TRIM(p."PZR") != '')
        OR (ai_escort.value_text IS NOT NULL AND TRIM(ai_escort.value_text) != '')
      )
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
      // 强前置门禁：必须检查今天是否向该陪诊员成功发送过当日出工打卡短信！
      const smsLog = await prisma.$queryRawUnsafe<any[]>(`
        SELECT id FROM "fact_hy_pz_sms_logs"
        WHERE order_no = $1 AND batch_type = 'same_day' AND send_ymd = $2 AND status = 'success'
        LIMIT 1;
      `, row.source_order_no, ymd)

      if (!smsLog || smsLog.length === 0) {
        continue
      }

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
    WHERE op.service_type = '住院护工协助'
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
 * 清理过期的日常录音上传提醒：
 * 日常录音提醒（11:30、17:30）仅在当天有效。
 * 若员工昨日未开机或未处理，跨天后自动标记为 expired，绝不延续到次日补弹。
 */
async function expirePastDailyUploadReminders(prisma: PrismaClient, logger?: LoggerLike): Promise<void> {
  try {
    const expiredCount = await (prisma as any).$executeRawUnsafe(`
      UPDATE order_reminders
         SET status = 'expired', updated_at = NOW()
       WHERE type = 'upload_recording'
         AND status IN ('pending', 'unread')
         AND remind_time < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date;
    `)
    if (expiredCount > 0) {
      logger?.info(`[orderReminderSchedule] 已自动失效 ${expiredCount} 条跨天的日常录音上传提醒`)
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
    await expirePastDailyUploadReminders(prisma, logger)
    await scanDailyCallUploadReminders(prisma, logger)
    await scanHospitalBookingReminders(prisma, logger)
    await scanEscortUnassignedReminders(prisma, logger)
    await sendPreDayEscortSms(prisma, logger)
    await sendSameDayEscortSms(prisma, logger)
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
