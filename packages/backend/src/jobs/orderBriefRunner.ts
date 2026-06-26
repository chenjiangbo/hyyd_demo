/**
 * 订单滚动简报的 DB 读写编排：取订单累积消息/通话(增量水位之后) → 调 orderBriefService →
 * 写回 Order.aiBriefJson + 水位。被"手动刷新接口"和"自动扫描器"共用。
 */
import { Prisma, type PrismaClient } from '@prisma/client'
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

type ApplicationOrderContext = {
  customer_name: string | null
  hospital: string | null
  dept: string | null
  doctor: string | null
  status: string | null
  raw_json: unknown
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

function jsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value == null ? Prisma.JsonNull : value as Prisma.InputJsonValue
}

/**
 * 刷新某订单简报。
 *
 * 全量重算：每次都把该订单**全部**的微信/企微消息 + 通话/录音转写 + 手工补录一起喂给 LLM，
 * 不做增量喂（信息量不大，全量更准，也不会出现"只总结了新增那几条"的问题）。
 * `briefLastMsgId/CallId/MaterialId` 仅作"上次跑到哪了"的记号——只用来判断"自上次以来有没有新内容"
 * （扫描器据此避免对同一状态重复跑），不参与喂给 LLM 的范围。
 *
 * @param opts.force 忽略"自上次以来无新内容"的判断，强制重算（手动按钮 / 转写完成后可传）
 */
export async function refreshOrderBrief(
  prisma: PrismaClient,
  minio: Minio.Client,
  orderId: number,
  opts: { force?: boolean } = {}
): Promise<RefreshResult | null> {
  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order) return null

  // 上次跑到哪了（仅用于判断"有没有新内容"，不用于裁剪喂给 LLM 的范围）
  const lastMsgId = order.briefLastMsgId ?? 0
  const lastCallId = order.briefLastCallId ?? 0
  const lastMaterialId = order.briefLastMaterialId ?? 0

  // 全量取：该订单名下所有消息/通话/手工补录
  const msgs = await prisma.message.findMany({
    where: { orderId },
    orderBy: { id: 'asc' }
  })
  const calls = await prisma.call.findMany({
    where: { orderId },
    orderBy: { id: 'asc' }
  })
  // 手工补录素材（专员主动记录，补无感采集之漏）
  const mats = await prisma.material.findMany({
    where: { orderId },
    orderBy: { id: 'asc' }
  })

  const maxMsgId = msgs.length > 0 ? msgs[msgs.length - 1].id : lastMsgId
  const maxCallId = calls.length > 0 ? calls[calls.length - 1].id : lastCallId
  const maxMaterialId = mats.length > 0 ? mats[mats.length - 1].id : lastMaterialId

  // 自上次跑之后有没有"有内容的"新东西（便宜预过滤：纯时间戳/系统提示/空转写不算）
  const hasNewContent =
    msgs.some((m) => m.id > lastMsgId && (m.contentText ?? '').trim().length > 0) ||
    calls.some((c) => c.id > lastCallId && ((c.asrText ?? '').trim().length > 0 || (c.durationSec ?? 0) > 0)) ||
    mats.some((m) => m.id > lastMaterialId && (m.type === 'image' || (m.textContent ?? '').trim().length > 0))

  const prevBrief = (order.aiBriefJson as OrderBrief | null) ?? null

  if (!hasNewContent && !opts.force) {
    // 自上次以来没有有营养的新内容 → 不调 LLM，但把记号推进到最新，避免扫描器每轮重复评估同一单
    const hasNewRows = maxMsgId > lastMsgId || maxCallId > lastCallId || maxMaterialId > lastMaterialId
    if (hasNewRows) {
      await prisma.order.update({
        where: { id: orderId },
        data: { briefLastMsgId: maxMsgId, briefLastCallId: maxCallId, briefLastMaterialId: maxMaterialId }
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

  // 全量重算：prevBrief 传 null，让 LLM 看到全部对话后重新产出整份简报，不做增量合并。
  void prevBrief
  const res = await buildOrderBrief(ctx, null, briefMsgs, briefCalls, briefMats)

  // 存储：简报字段 + 记号(本次跑到的最新 id) + 模型，便于前端展示与追溯
  const stored = {
    summary: res.summary,
    stage: res.stage,
    stageEvidence: res.stageEvidence,
    hasOpenIssue: res.hasOpenIssue,
    nextActions: res.nextActions,
    risks: res.risks,
    keyInfo: res.keyInfo,
    model: res.model,
    updatedFrom: { lastMessageId: maxMsgId, lastCallId: maxCallId, lastMaterialId: maxMaterialId }
  }

  await prisma.order.update({
    where: { id: orderId },
    data: {
      aiBriefJson: stored,
      briefUpdatedAt: new Date(),
      briefLastMsgId: maxMsgId,
      briefLastCallId: maxCallId,
      briefLastMaterialId: maxMaterialId
    }
  })

  return { brief: res, skipped: false, model: res.model }
}

export async function refreshApplicationBrief(
  prisma: PrismaClient,
  applicationNo: string,
  opts: { force?: boolean } = {}
): Promise<RefreshResult> {
  const appNo = applicationNo.trim()
  if (!appNo) throw new Error('applicationNo 不能为空')

  const existing = await prisma.applicationBrief.findUnique({ where: { applicationNo: appNo } })
  const lastMsgId = existing?.briefLastMsgId ?? 0
  const lastCallId = existing?.briefLastCallId ?? 0

  const [msgs, calls, orders] = await Promise.all([
    prisma.message.findMany({
      where: { applicationNo: appNo },
      orderBy: { id: 'asc' }
    }),
    prisma.call.findMany({
      where: { applicationNo: appNo },
      orderBy: { id: 'asc' }
    }),
    prisma.$queryRaw<ApplicationOrderContext[]>`
      SELECT customer_name, hospital, dept, doctor, status, raw_json
      FROM orders
      WHERE raw_json->>'crmApplyNo' = ${appNo}
      ORDER BY id ASC
    `
  ])

  const maxMsgId = msgs.length > 0 ? msgs[msgs.length - 1].id : lastMsgId
  const maxCallId = calls.length > 0 ? calls[calls.length - 1].id : lastCallId
  const hasNewContent =
    msgs.some((m) => m.id > lastMsgId && (m.contentText ?? '').trim().length > 0) ||
    calls.some((c) => c.id > lastCallId && ((c.asrText ?? '').trim().length > 0 || (c.durationSec ?? 0) > 0))

  const prevBrief = (existing?.briefJson as OrderBrief | null) ?? null
  if (!hasNewContent && !opts.force) {
    if (maxMsgId > lastMsgId || maxCallId > lastCallId) {
      await prisma.applicationBrief.upsert({
        where: { applicationNo: appNo },
        create: {
          applicationNo: appNo,
          briefJson: jsonInput(prevBrief),
          briefLastMsgId: maxMsgId,
          briefLastCallId: maxCallId
        },
        update: {
          briefLastMsgId: maxMsgId,
          briefLastCallId: maxCallId
        }
      })
    }
    return { brief: prevBrief, skipped: true, reason: 'no_new_content' }
  }

  const first = orders[0]
  const serviceLabels = Array.from(new Set(orders.map((o) => {
    const raw = (o.raw_json ?? {}) as Record<string, unknown>
    return String(raw.serviceType ?? raw.itemName ?? '').trim()
  }).filter(Boolean)))
  const hospitals = Array.from(new Set(orders.map((o) => o.hospital).filter((x): x is string => !!x)))
  const depts = Array.from(new Set(orders.map((o) => o.dept).filter((x): x is string => !!x)))

  const ctx: BriefContext = {
    customerName: first?.customer_name ?? null,
    serviceType: serviceLabels.join('、') || null,
    itemName: orders.length > 1 ? `${orders.length} 个订单` : null,
    hospital: hospitals.join('、') || first?.hospital || null,
    dept: depts.join('、') || first?.dept || null,
    doctor: first?.doctor ?? null,
    status: first?.status ?? null
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

  const res = await buildOrderBrief(ctx, null, briefMsgs, briefCalls, [])
  const stored = {
    summary: res.summary,
    stage: res.stage,
    stageEvidence: res.stageEvidence,
    hasOpenIssue: res.hasOpenIssue,
    nextActions: res.nextActions,
    risks: res.risks,
    keyInfo: res.keyInfo,
    model: res.model,
    updatedFrom: { lastMessageId: maxMsgId, lastCallId: maxCallId }
  }

  await prisma.applicationBrief.upsert({
    where: { applicationNo: appNo },
    create: {
      applicationNo: appNo,
      briefJson: jsonInput(stored),
      briefUpdatedAt: new Date(),
      briefLastMsgId: maxMsgId,
      briefLastCallId: maxCallId
    },
    update: {
      briefJson: jsonInput(stored),
      briefUpdatedAt: new Date(),
      briefLastMsgId: maxMsgId,
      briefLastCallId: maxCallId
    }
  })

  return { brief: res, skipped: false, model: res.model }
}

export { emptyBrief }
