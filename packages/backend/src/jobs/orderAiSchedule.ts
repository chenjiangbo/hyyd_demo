/**
 * 订单 AI 定时分析调度引擎。
 * 不监听新消息或转写完成而立即执行；仅在配置的上海时区时点运行，且只分析自上次
 * 分析后新增了企微/微信有效消息或完成转写通话录音的订单。
 *
 * 支持通过数据库 sys_settings 动态热配置工作时段与频次（如 09:00~21:00 每30分钟/15分钟），即改即生效。
 */
import { createHash } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type * as Minio from 'minio'
import { refreshOrderBrief } from './orderBriefRunner.js'
import { applyOrderWorkflowEvent } from '../workflow/serviceWorkflow.js'

export interface OrderAiScheduleConfig {
  enabled: boolean
  startTime: string // "09:00"
  endTime: string   // "21:00"
  intervalMinutes: number // 15 | 30 | 60 等
}

export const DEFAULT_ORDER_AI_SCHEDULE_CONFIG: OrderAiScheduleConfig = {
  enabled: true,
  startTime: '09:00',
  endTime: '21:00',
  intervalMinutes: 30
}

const CHECK_INTERVAL_MS = 30_000
let timer: ReturnType<typeof setInterval> | null = null
let running = false

let currentConfig: OrderAiScheduleConfig = { ...DEFAULT_ORDER_AI_SCHEDULE_CONFIG }
let cachedSlots: Set<string> = new Set(
  generateScheduleSlots(currentConfig.startTime, currentConfig.endTime, currentConfig.intervalMinutes)
)
let lastRunSlot: string | null = null // 格式："YYYY-MM-DD HH:mm"，精确单值防重
let lastRunAt: string | null = null

/**
 * 根据起始时间、结束时间和间隔分钟数计算上海时区执行时点数组（升序）
 */
export function generateScheduleSlots(startTime: string, endTime: string, intervalMinutes: number): string[] {
  const parseMinute = (t: string) => {
    const [h, m] = t.split(':').map(Number)
    return h * 60 + m
  }
  const formatMinute = (mins: number) => {
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }

  const start = parseMinute(startTime)
  const end = parseMinute(endTime)
  if (isNaN(start) || isNaN(end) || start > end || intervalMinutes <= 0) {
    return ['09:00', '21:00']
  }

  const slots: string[] = []
  for (let curr = start; curr <= end; curr += intervalMinutes) {
    slots.push(formatMinute(curr))
  }
  return slots
}

function shanghaiClock(now = new Date()): { date: string; time: string } {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now)
  const part = (kind: Intl.DateTimeFormatPartTypes) => values.find((item) => item.type === kind)?.value ?? ''
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` }
}

/**
 * 从数据库 sys_settings 加载调度配置
 */
export async function loadScheduleConfigFromDb(prisma: PrismaClient): Promise<OrderAiScheduleConfig> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ value: any }>>(
      `SELECT value FROM sys_settings WHERE key = 'order_ai_schedule' LIMIT 1;`
    )
    if (rows && rows.length > 0 && rows[0].value) {
      const val = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value
      return {
        enabled: val.enabled !== false,
        startTime: val.startTime || '09:00',
        endTime: val.endTime || '21:00',
        intervalMinutes: Number(val.intervalMinutes) || 30
      }
    }
  } catch (err) {
    console.warn('[order-ai-schedule] 读取数据库配置失败，使用内存当前配置:', (err as Error).message)
  }
  return currentConfig
}

/**
 * 热重载内存中的调度配置（更新时点集合，即改即生效，无需重启服务）
 */
export async function reloadScheduleConfig(prisma: PrismaClient): Promise<OrderAiScheduleConfig> {
  const conf = await loadScheduleConfigFromDb(prisma)
  currentConfig = conf
  if (conf.enabled) {
    const slots = generateScheduleSlots(conf.startTime, conf.endTime, conf.intervalMinutes)
    cachedSlots = new Set(slots)
  } else {
    cachedSlots = new Set()
  }
  console.log(
    `[order-ai-schedule] 调度配置已热重载: enabled=${conf.enabled}, 时段=${conf.startTime}~${conf.endTime}, 间隔=${conf.intervalMinutes}分钟, 共 ${cachedSlots.size} 个执行时点`
  )
  return currentConfig
}

/**
 * 获取当前调度状态（供管理后台展示）
 */
export function getScheduleStatus(): {
  config: OrderAiScheduleConfig
  slots: string[]
  lastRunSlot: string | null
  lastRunAt: string | null
  nextRunSlot: string | null
  timeZone: string
} {
  const { time } = shanghaiClock()
  const slotsList = generateScheduleSlots(currentConfig.startTime, currentConfig.endTime, currentConfig.intervalMinutes)

  let nextRunSlot: string | null = null
  if (currentConfig.enabled) {
    for (const s of slotsList) {
      if (s > time) {
        nextRunSlot = s
        break
      }
    }
    if (!nextRunSlot && slotsList.length > 0) {
      nextRunSlot = `次日 ${slotsList[0]}`
    }
  }

  return {
    config: currentConfig,
    slots: slotsList,
    lastRunSlot,
    lastRunAt,
    nextRunSlot,
    timeZone: 'Asia/Shanghai（上海时区）'
  }
}

async function processOrder(prisma: PrismaClient, minio: Minio.Client, orderId: number): Promise<boolean> {
  // 不使用 force：即使候选筛选与水位在并发时出现短暂差异，也绝不对无新增内容的订单调用模型。
  const result = await refreshOrderBrief(prisma, minio, orderId)
  if (!result?.brief) return false
  for (const event of result.brief.workflowEvents) {
    // 同一事实的证据文本产生同一来源引用，定时任务重跑不会重复新建复诊/住院服务包。
    const fingerprint = createHash('sha256').update(`${orderId}:${event.code}:${event.evidence}`).digest('hex').slice(0, 32)
    try {
      await applyOrderWorkflowEvent(prisma, orderId, {
        code: event.code,
        source: 'ai',
        sourceRef: `qwen:${event.code}:${fingerprint}`,
        confidence: 0.8,
        evidence: [{ text: event.evidence, model: result.model ?? 'qwen-plus' }]
      })
    } catch (error) {
      // 例如当前服务类型不支持“住院服务”；简报仍应保留，单个事件失败不阻断同批订单。
      console.warn(`[order-ai-schedule] 订单 ${orderId} 事件 ${event.code} 未应用:`, (error as Error).message)
    }
  }
  return true
}

async function run(prisma: PrismaClient, minio: Minio.Client, slot: string): Promise<void> {
  if (running) return
  running = true
  try {
    // 申请号是沟通数据范围，订单是分析结果范围：同一申请号下只要新增有效沟通，
    // 每张关联订单都会按各自服务类型分别分析。手工素材不会单独触发本定时任务。
    const orders = await prisma.$queryRaw<Array<{ id: number }>>`
      SELECT o.id
      FROM orders o
      WHERE EXISTS (
        SELECT 1
        FROM messages m
        WHERE (
            m.order_id = o.id
            OR (
              o.raw_json->>'crmApplyNo' IS NOT NULL
              AND m.application_no = o.raw_json->>'crmApplyNo'
            )
          )
          AND m.id > COALESCE(o.brief_last_msg_id, 0)
          AND m.channel IN ('wechat', 'wxwork')
          AND btrim(COALESCE(m.content_text, '')) <> ''
      )
      OR EXISTS (
        SELECT 1
        FROM calls c
        WHERE (
            c.order_id = o.id
            OR (
              o.raw_json->>'crmApplyNo' IS NOT NULL
              AND c.application_no = o.raw_json->>'crmApplyNo'
            )
          )
          AND c.id > COALESCE(o.brief_last_call_id, 0)
          AND btrim(COALESCE(c.asr_text, '')) <> ''
      )
      ORDER BY o.updated_at ASC
    `
    let succeeded = 0
    for (const order of orders) {
      try {
        if (await processOrder(prisma, minio, order.id)) succeeded += 1
      } catch (error) {
        console.warn(`[order-ai-schedule] 订单 ${order.id} 分析失败:`, (error as Error).message)
      }
    }
    console.log(`[order-ai-schedule] 上海时间 ${slot} 批量执行完成：分析 ${succeeded}/${orders.length} 单`)
  } finally {
    running = false
  }
}

async function tick(prisma: PrismaClient, minio: Minio.Client): Promise<void> {
  if (!currentConfig.enabled) return
  const { date, time } = shanghaiClock()
  if (!cachedSlots.has(time)) return

  const key = `${date} ${time}`
  if (lastRunSlot === key) return // 该分钟已执行过，跳过
  lastRunSlot = key
  lastRunAt = new Date().toISOString()

  await run(prisma, minio, time)
}

export function startOrderAiSchedule(prisma: PrismaClient, minio: Minio.Client): void {
  if (timer) return

  // 启动即先从数据库加载最新配置
  void reloadScheduleConfig(prisma).then(() => {
    void tick(prisma, minio).catch((error) => {
      console.warn('[order-ai-schedule] 启动首次检查异常:', (error as Error).message)
    })
  })

  timer = setInterval(() => void tick(prisma, minio).catch((error) => {
    console.warn('[order-ai-schedule] tick 异常:', (error as Error).message)
  }), CHECK_INTERVAL_MS)

  console.log(`[order-ai-schedule] 定时扫描引擎已启动，检测周期: ${CHECK_INTERVAL_MS / 1000}秒`)
}

export function stopOrderAiSchedule(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
