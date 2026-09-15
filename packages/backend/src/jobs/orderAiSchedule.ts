/**
 * 订单 AI 定时分析。
 * 不监听新消息或转写完成而立即执行；仅在配置的上海时区时点运行，且只分析自上次
 * 分析后新增了企微/微信有效消息或完成转写通话录音的订单。
 */
import { createHash } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type * as Minio from 'minio'
import { getEnv } from '../env.js'
import { refreshOrderBrief } from './orderBriefRunner.js'
import { applyOrderWorkflowEvent } from '../workflow/serviceWorkflow.js'

const CHECK_INTERVAL_MS = 30_000
let timer: ReturnType<typeof setInterval> | null = null
let running = false
const completedSlots = new Set<string>()

function configuredSlots(): Set<string> {
  const raw = getEnv().orderAiAnalysisTimes ?? '12:00,18:00'
  const values = raw.split(',').map((value) => value.trim()).filter((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value))
  return new Set(values.length > 0 ? values : ['12:00', '18:00'])
}

function shanghaiClock(now = new Date()): { date: string; time: string } {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now)
  const part = (kind: Intl.DateTimeFormatPartTypes) => values.find((item) => item.type === kind)?.value ?? ''
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` }
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
    console.log(`[order-ai-schedule] 上海时间 ${slot} 已完成：分析 ${succeeded}/${orders.length} 单`)
  } finally {
    running = false
  }
}

async function tick(prisma: PrismaClient, minio: Minio.Client): Promise<void> {
  const { date, time } = shanghaiClock()
  if (!configuredSlots().has(time)) return
  const key = `${date} ${time}`
  if (completedSlots.has(key)) return
  completedSlots.add(key)
  // 保留很小的去重窗口，避免长期运行的进程累积无界内存。
  if (completedSlots.size > 8) {
    const latest = [...completedSlots].slice(-8)
    completedSlots.clear()
    for (const item of latest) completedSlots.add(item)
  }
  await run(prisma, minio, time)
}

export function startOrderAiSchedule(prisma: PrismaClient, minio: Minio.Client): void {
  if (timer) return
  timer = setInterval(() => void tick(prisma, minio).catch((error) => {
    console.warn('[order-ai-schedule] tick 异常:', (error as Error).message)
  }), CHECK_INTERVAL_MS)
  void tick(prisma, minio).catch((error) => {
    console.warn('[order-ai-schedule] 启动检查异常:', (error as Error).message)
  })
  console.log(`[order-ai-schedule] 已启动，上海时区执行时点：${[...configuredSlots()].join('、')}`)
}

export function stopOrderAiSchedule(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
