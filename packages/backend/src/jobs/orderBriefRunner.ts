/**
 * 订单滚动简报的 DB 读写编排：取订单累积消息/通话(增量水位之后) → 调 orderBriefService →
 * 写回 Order.aiBriefJson + 水位。被"手动刷新接口"和"自动扫描器"共用。
 */
import type { PrismaClient } from '@prisma/client'
import type * as Minio from 'minio'
import { spawn } from 'child_process'
import {
  buildOrderBrief,
  type OrderBrief,
  type BriefContext,
  type BriefMessageInput,
  type BriefCallInput,
  type BriefMaterialInput
} from '../llm/orderBriefService.js'
import { understandImage } from '../llm/imageUnderstandService.js'

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  return Buffer.concat(chunks)
}

// 百炼 qwen-vl 对部分 PNG(带 alpha 等)的 base64 会识别为"空白"，统一转成 JPEG(白底)再送。
// 用系统 ImageMagick（后端跑在 Mac，已装 magick）；失败则回退原图。
async function toJpegBase64(buf: Buffer): Promise<{ b64: string; mime: string }> {
  try {
    const out = await new Promise<Buffer>((resolve, reject) => {
      // 后端进程 PATH 常不含 Homebrew，补上 magick 常见安装位置
      const PATH = `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin`
      const p = spawn('magick', ['-', '-background', 'white', '-flatten', 'jpeg:-'], {
        env: { ...process.env, PATH }
      })
      const chunks: Buffer[] = []
      const errs: Buffer[] = []
      p.stdout.on('data', (d) => chunks.push(d))
      p.stderr.on('data', (d) => errs.push(d))
      p.on('error', reject)
      p.on('close', (code) =>
        code === 0 && chunks.length > 0
          ? resolve(Buffer.concat(chunks))
          : reject(new Error('magick 转码失败: ' + Buffer.concat(errs).toString().slice(0, 120)))
      )
      p.stdin.on('error', () => {})
      p.stdin.end(buf)
    })
    return { b64: out.toString('base64'), mime: 'image/jpeg' }
  } catch (e) {
    console.warn('[brief] 图片转 JPEG 失败，回退原图:', (e as Error).message)
    return { b64: buf.toString('base64'), mime: 'image/png' }
  }
}

/** 对未识别过的图片素材跑一次 VLM(分类+OCR)，结果缓存回 Material。失败不阻断简报。 */
async function ensureImageUnderstood(
  prisma: PrismaClient,
  minio: Minio.Client,
  mat: { id: number; type: string; minioBucket: string | null; minioKey: string | null; mimeType: string | null; aiImageProcessedAt: Date | null; aiImageKind: string | null; aiImageText: string | null }
): Promise<void> {
  if (mat.type !== 'image' || mat.aiImageProcessedAt || !mat.minioBucket || !mat.minioKey) return
  try {
    const buf = await streamToBuffer(await minio.getObject(mat.minioBucket, mat.minioKey))
    const { b64, mime } = await toJpegBase64(buf)
    const r = await understandImage(`data:${mime};base64,${b64}`)
    mat.aiImageKind = r.kind
    mat.aiImageText = r.text
    mat.aiImageProcessedAt = new Date()
    await prisma.material.update({
      where: { id: mat.id },
      data: { aiImageKind: r.kind, aiImageText: r.text, aiImageProcessedAt: mat.aiImageProcessedAt }
    })
  } catch (e) {
    console.warn(`[brief] 图片素材 ${mat.id} 识图失败:`, (e as Error).message)
  }
}

export interface RefreshResult {
  brief: OrderBrief | null
  skipped: boolean
  reason?: string
  model?: string
}

function emptyBrief(): OrderBrief {
  return {
    summary: null,
    stage: null,
    stageEvidence: null,
    hasOpenIssue: false,
    nextActions: [],
    risks: [],
    keyInfo: {}
  }
}

/**
 * 刷新某订单简报（增量）。
 * @param opts.force 忽略"无新内容"的预过滤，强制重算（手动按钮可传）
 */
export async function refreshOrderBrief(
  prisma: PrismaClient,
  minio: Minio.Client,
  orderId: number,
  opts: { force?: boolean } = {}
): Promise<RefreshResult | null> {
  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order) return null

  const lastMsgId = order.briefLastMsgId ?? 0
  const lastCallId = order.briefLastCallId ?? 0
  const lastMaterialId = order.briefLastMaterialId ?? 0
  const prevBrief = (order.aiBriefJson as OrderBrief | null) ?? null

  const msgs = await prisma.message.findMany({
    where: { orderId, id: { gt: lastMsgId } },
    orderBy: { id: 'asc' }
  })
  const calls = await prisma.call.findMany({
    where: { orderId, id: { gt: lastCallId } },
    orderBy: { id: 'asc' }
  })
  // 手工补录素材（专员主动记录，补无感采集之漏）
  const mats = await prisma.material.findMany({
    where: { orderId, id: { gt: lastMaterialId } },
    orderBy: { id: 'asc' }
  })

  // 便宜预过滤：没有"有内容"的新消息/通话/手工补录 → 不调 AI
  const hasContent =
    msgs.some((m) => (m.contentText ?? '').trim().length > 0) ||
    calls.some((c) => (c.asrText ?? '').trim().length > 0 || (c.durationSec ?? 0) > 0) ||
    mats.some((m) => m.type === 'image' || (m.textContent ?? '').trim().length > 0)
  if (!hasContent && !opts.force) {
    // 有新行但都没营养 → 不调 AI，但推进水位，避免扫描器每轮重复评估同一单
    if (msgs.length > 0 || calls.length > 0 || mats.length > 0) {
      await prisma.order.update({
        where: { id: orderId },
        data: {
          briefLastMsgId: msgs.length > 0 ? msgs[msgs.length - 1].id : lastMsgId,
          briefLastCallId: calls.length > 0 ? calls[calls.length - 1].id : lastCallId,
          briefLastMaterialId: mats.length > 0 ? mats[mats.length - 1].id : lastMaterialId
        }
      })
    }
    return { brief: prevBrief, skipped: true, reason: 'no_new_content' }
  }

  const raw = (order.rawJson ?? {}) as Record<string, unknown>
  const ctx: BriefContext = {
    customerName: order.customerName,
    serviceType: (raw.serviceType as string) ?? null,
    itemName: (raw.itemName as string) ?? null,
    hospital: order.hospital,
    dept: order.dept,
    doctor: order.doctor,
    status: order.status
  }

  const briefMsgs: BriefMessageInput[] = msgs.map((m) => ({
    channel: m.channel,
    senderName: m.senderName,
    contentText: m.contentText,
    capturedAt: m.capturedAt
  }))
  const briefCalls: BriefCallInput[] = calls.map((c) => ({
    direction: c.direction,
    callStatus: c.callStatus,
    durationSec: c.durationSec,
    asrText: c.asrText,
    startedAt: c.startedAt
  }))
  // 图片素材：先用 VLM 识图(分类+OCR)，结果缓存回 Material 后再用
  for (const m of mats) {
    if (m.type === 'image') await ensureImageUnderstood(prisma, minio, m)
  }
  const briefMats: BriefMaterialInput[] = mats.map((m) => ({
    type: m.type,
    textContent: m.type === 'image' ? m.aiImageText : m.textContent,
    imageKind: m.aiImageKind,
    createdAt: m.createdAt
  }))

  const res = await buildOrderBrief(ctx, prevBrief, briefMsgs, briefCalls, briefMats)

  const newLastMsgId = msgs.length > 0 ? msgs[msgs.length - 1].id : lastMsgId
  const newLastCallId = calls.length > 0 ? calls[calls.length - 1].id : lastCallId
  const newLastMaterialId = mats.length > 0 ? mats[mats.length - 1].id : lastMaterialId

  // 存储：简报字段 + 水位 + 模型，便于前端展示与追溯
  const stored = {
    summary: res.summary,
    stage: res.stage,
    stageEvidence: res.stageEvidence,
    hasOpenIssue: res.hasOpenIssue,
    nextActions: res.nextActions,
    risks: res.risks,
    keyInfo: res.keyInfo,
    model: res.model,
    updatedFrom: { lastMessageId: newLastMsgId, lastCallId: newLastCallId, lastMaterialId: newLastMaterialId }
  }

  await prisma.order.update({
    where: { id: orderId },
    data: {
      aiBriefJson: stored,
      briefUpdatedAt: new Date(),
      briefLastMsgId: newLastMsgId,
      briefLastCallId: newLastCallId,
      briefLastMaterialId: newLastMaterialId
    }
  })

  return { brief: res, skipped: false, model: res.model }
}

export { emptyBrief }
