/**
 * 订单字段与服务步骤分析触发器。
 * 微信/企微沟通按申领号静默后台配置的时长后，逐个分析该申领号下有新素材的订单；
 * 电话 ASR 转写完成后立即触发对应订单分析。手工补录素材仍按静默 3 分钟触发。
 */
import type { PrismaClient } from '@prisma/client'
import type * as Minio from 'minio'
import { analyzeOrderFields, type FieldAnalysisResult } from './orderBriefRunner.js'
import { getOrderAiAutomationConfig } from '../services/orderAiAutomationConfig.js'

const CHECK_INTERVAL_MS = 30_000
const MATERIAL_SILENCE_MS = 3 * 60_000
let timer: ReturnType<typeof setInterval> | null = null
let tickRunning = false

function describeTaskError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message || error.name
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** 同一订单的触发合并；分析进行中又有新触发时，结束后补跑一次读取最新素材。 */
const activeOrderRuns = new Map<number, Promise<FieldAnalysisResult | null>>()
const rerunOrderIds = new Set<number>()
const rerunForceOrderIds = new Set<number>()

export function triggerOrderAiAnalysis(
  prisma: PrismaClient,
  minio: Minio.Client,
  orderId: number,
  options: { force?: boolean } = {}
): Promise<FieldAnalysisResult | null> {
  const active = activeOrderRuns.get(orderId)
  if (active) {
    rerunOrderIds.add(orderId)
    if (options.force) rerunForceOrderIds.add(orderId)
    return active
  }

  const task = Promise.resolve().then(async () => {
    let result: FieldAnalysisResult | null = null
    let force = options.force === true
    do {
      rerunOrderIds.delete(orderId)
      result = await analyzeOrderFields(prisma, minio, orderId, { force })
      force = rerunForceOrderIds.delete(orderId)
    } while (rerunOrderIds.has(orderId))
    if (!result) throw new Error(`订单 ${orderId} 不存在`)
    if (!result.skipped && !result.fieldExtractionSucceeded) {
      throw new Error(`订单 ${orderId} 字段提取未成功`)
    }
    return result
  })
  activeOrderRuns.set(orderId, task)
  void task.finally(() => {
    if (activeOrderRuns.get(orderId) === task) activeOrderRuns.delete(orderId)
    rerunOrderIds.delete(orderId)
    rerunForceOrderIds.delete(orderId)
  }).catch(() => {})
  return task
}

async function processOrder(prisma: PrismaClient, minio: Minio.Client, orderId: number, trigger: string): Promise<void> {
  const result = await triggerOrderAiAnalysis(prisma, minio, orderId)
  if (result && !result.skipped) console.log(`[order-ai:${trigger}] 订单 ${orderId} 字段与服务步骤分析完成`)
}

/** ASR 转写文本成功落库后立即分析本单及同申领号下的其他订单。 */
export async function triggerOrderAiForCall(
  prisma: PrismaClient,
  minio: Minio.Client,
  callId: number
): Promise<void> {
  const calls = await prisma.$queryRaw<Array<{ order_id: number | null; application_no: string | null }>>`
    SELECT order_id, application_no FROM calls WHERE id = ${callId}
  `
  const call = calls[0]
  if (!call) throw new Error(`ASR 完成后的通话记录不存在：${callId}`)

  const orders = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT DISTINCT o.id
    FROM orders o
    WHERE (${call.order_id}::integer IS NOT NULL AND o.id = ${call.order_id})
       OR (${call.application_no}::text IS NOT NULL AND o.raw_json->>'crmApplyNo' = ${call.application_no})
    ORDER BY o.id
  `
  if (orders.length === 0) {
    console.warn(`[order-ai:asr] 通话 ${callId} 转写完成，但未关联到可分析订单；请先关联订单或申领号`)
    return
  }

  for (const order of orders) await processOrder(prisma, minio, order.id, `asr-call-${callId}`)
}

async function runSilentCommunicationOrders(prisma: PrismaClient, minio: Minio.Client): Promise<void> {
  const config = await getOrderAiAutomationConfig(prisma)
  const communicationSilenceMs = config.communicationSilenceMinutes * 60_000
  const cutoff = new Date(Date.now() - communicationSilenceMs)
  const orders = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT o.id
    FROM orders o
    WHERE (
      EXISTS (
        SELECT 1 FROM messages m
        WHERE (m.order_id = o.id OR (
          o.raw_json->>'crmApplyNo' IS NOT NULL
          AND m.application_no = o.raw_json->>'crmApplyNo'
        ))
          AND m.id > COALESCE(o.field_ai_last_msg_id, 0)
          AND m.channel IN ('wechat', 'wxwork')
          AND btrim(COALESCE(m.content_text, '')) <> ''
      )
      OR EXISTS (
        SELECT 1
        FROM native_chat_conversations nc
        JOIN native_chat_messages nm ON nm.conversation_id = nc.id
        LEFT JOIN LATERAL (
          SELECT MAX(a.updated_at) AS latest_attachment_at
          FROM native_chat_attachments a
          WHERE a.message_id = nm.id
        ) na ON TRUE
        WHERE nc.application_link_status = 'matched'
          AND o.raw_json->>'crmApplyNo' IS NOT NULL
          AND nc.application_no = o.raw_json->>'crmApplyNo'
          AND GREATEST(nm.observed_at, COALESCE(na.latest_attachment_at, nm.observed_at), COALESCE(nc.application_linked_at, 'epoch'::timestamp))
              > COALESCE(o.field_ai_last_native_at, 'epoch'::timestamp)
      )
    )
    AND GREATEST(
      COALESCE((
        SELECT MAX(m.captured_at) FROM messages m
        WHERE (m.order_id = o.id OR (
          o.raw_json->>'crmApplyNo' IS NOT NULL
          AND m.application_no = o.raw_json->>'crmApplyNo'
        )) AND m.channel IN ('wechat', 'wxwork')
      ), 'epoch'::timestamp),
      COALESCE((
        SELECT MAX(GREATEST(nm.observed_at, COALESCE(na.latest_attachment_at, nm.observed_at), COALESCE(nc.application_linked_at, 'epoch'::timestamp)))
        FROM native_chat_conversations nc
        JOIN native_chat_messages nm ON nm.conversation_id = nc.id
        LEFT JOIN LATERAL (
          SELECT MAX(a.updated_at) AS latest_attachment_at
          FROM native_chat_attachments a
          WHERE a.message_id = nm.id
        ) na ON TRUE
        WHERE nc.application_link_status = 'matched'
          AND o.raw_json->>'crmApplyNo' IS NOT NULL
          AND nc.application_no = o.raw_json->>'crmApplyNo'
      ), 'epoch'::timestamp)
    ) <= ${cutoff}
    ORDER BY o.id
  `

  let succeeded = 0
  for (const order of orders) {
    try {
      await processOrder(prisma, minio, order.id, `communication-silence-${config.communicationSilenceMinutes}m`)
      succeeded++
    } catch (error) {
      console.error(`[order-ai:communication] 订单 ${order.id} 静默 ${config.communicationSilenceMinutes} 分钟分析失败：\n${describeTaskError(error)}`)
    }
  }
  if (orders.length > 0) {
    console.log(`[order-ai:communication] 静默 ${config.communicationSilenceMinutes} 分钟分析完成：成功 ${succeeded}/${orders.length} 单`)
  }
}

/** 服务在 ASR 写库与即时触发之间重启时，扫描器会发现尚未消费水位的转写。 */
async function runCompletedCallOrders(prisma: PrismaClient, minio: Minio.Client): Promise<void> {
  const orders = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT DISTINCT o.id
    FROM orders o
    JOIN calls c ON (
      c.order_id = o.id
      OR (o.raw_json->>'crmApplyNo' IS NOT NULL AND c.application_no = o.raw_json->>'crmApplyNo')
    )
    WHERE c.asr_status = 'done'
      AND btrim(COALESCE(c.asr_text, '')) <> ''
      AND c.id > COALESCE(o.field_ai_last_call_id, 0)
    ORDER BY o.id
  `
  for (const order of orders) {
    try {
      await processOrder(prisma, minio, order.id, 'completed-call-recovery')
    } catch (error) {
      console.error(`[order-ai:asr] 订单 ${order.id} 转写完成后的字段分析失败：\n${describeTaskError(error)}`)
    }
  }
}

async function runSilentMaterialOrders(prisma: PrismaClient, minio: Minio.Client): Promise<void> {
  const silenceCutoff = new Date(Date.now() - MATERIAL_SILENCE_MS)
  const orders = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT o.id
    FROM orders o
    WHERE EXISTS (
      SELECT 1 FROM materials m
      WHERE m.order_id = o.id AND m.id > COALESCE(o.field_ai_last_material_id, 0)
    )
    AND NOT EXISTS (
      SELECT 1 FROM materials m
      WHERE m.order_id = o.id
        AND m.id > COALESCE(o.field_ai_last_material_id, 0)
        AND m.created_at > ${silenceCutoff}
    )
    ORDER BY o.id
  `
  for (const order of orders) {
    try {
      await processOrder(prisma, minio, order.id, 'material-silence-3m')
    } catch (error) {
      console.error(`[order-ai:material] 订单 ${order.id} 静默补录分析失败：\n${describeTaskError(error)}`)
    }
  }
}

async function tick(prisma: PrismaClient, minio: Minio.Client): Promise<void> {
  if (tickRunning) return
  tickRunning = true
  try {
    await runCompletedCallOrders(prisma, minio)
    await runSilentCommunicationOrders(prisma, minio)
    await runSilentMaterialOrders(prisma, minio)
  } finally {
    tickRunning = false
  }
}

export function startOrderAiSchedule(prisma: PrismaClient, minio: Minio.Client): void {
  if (timer) return
  void tick(prisma, minio).catch((error) => {
    console.error(`[order-ai] 启动时扫描失败：\n${describeTaskError(error)}`)
  })
  timer = setInterval(() => {
    void tick(prisma, minio).catch((error) => {
      console.error(`[order-ai] 定时扫描失败：\n${describeTaskError(error)}`)
    })
  }, CHECK_INTERVAL_MS)
  console.log('[order-ai] 触发器已启动：电话转写完成后立即分析；微信/企微静默后台配置的时长后分析；每 30 秒检查一次')
}

export function stopOrderAiSchedule(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
