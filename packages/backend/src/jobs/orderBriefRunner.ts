/**
 * 订单滚动简报的 DB 读写编排：取订单累积消息/通话(增量水位之后) → 调 orderBriefService →
 * 写回 Order.aiBriefJson + 水位。被"手动刷新接口"和"自动扫描器"共用。
 */
import { Prisma, type PrismaClient } from '@prisma/client'
import type * as Minio from 'minio'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import {
  buildOrderBrief,
  type OrderBrief,
  type BriefContext,
  type BriefMessageInput,
  type BriefCallInput,
  type BriefMaterialInput
} from '../llm/orderBriefService.js'
import { extractOrderServiceFields, ORDER_AI_FIELD_PROMPT_VERSION } from '../llm/orderAiExtraction.js'
import { understandImage } from '../llm/imageUnderstandService.js'
import { applyOrderWorkflowEvent } from '../workflow/serviceWorkflow.js'

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
        env: { ...process.env, PATH },
        timeout: 5000
      })
      const chunks: Buffer[] = []
      const errs: Buffer[] = []
      const timer = setTimeout(() => {
        try { p.kill() } catch {}
        reject(new Error('magick 转码超时'))
      }, 5000)
      p.stdout.on('data', (d) => chunks.push(d))
      p.stderr.on('data', (d) => errs.push(d))
      p.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      p.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0 && chunks.length > 0) {
          resolve(Buffer.concat(chunks))
        } else {
          reject(new Error('magick 转码失败: ' + Buffer.concat(errs).toString().slice(0, 120)))
        }
      })
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

export interface FieldAnalysisResult {
  skipped: boolean
  reason?: string
  model?: string
  fieldExtractionSucceeded: boolean
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
    keyInfo: {},
    workflowEvents: []
  }
}

function jsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value == null ? Prisma.JsonNull : value as Prisma.InputJsonValue
}

function applicationNoOf(rawJson: unknown): string | null {
  const raw = (rawJson ?? {}) as Record<string, unknown>
  const value = raw.crmApplyNo
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function persistFieldCandidates(
  prisma: PrismaClient,
  input: {
    orderId: number
    applicationNo: string | null
    model: string
    maxMessageId: number
    maxCallId: number
    maxMaterialId: number
    raw: string
    candidates: Awaited<ReturnType<typeof extractOrderServiceFields>>['candidates']
  }
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const runs = await tx.$queryRaw<Array<{ id: bigint }>>`
      INSERT INTO b_order_ai_analysis_runs (
        order_id, application_no, model, prompt_version, status,
        source_message_max_id, source_call_max_id, source_material_max_id, raw_result_json, completed_at
      ) VALUES (
        ${input.orderId}, ${input.applicationNo}, ${input.model}, ${ORDER_AI_FIELD_PROMPT_VERSION}, 'succeeded',
        ${input.maxMessageId}, ${input.maxCallId}, ${input.maxMaterialId},
        ${JSON.stringify({ raw: input.raw })}::jsonb, now()
      ) RETURNING id
    `
    const runId = runs[0]!.id
    // 本轮使用完整沟通历史重新提取：上一轮未再次出现的候选也必须退出当前补位。
    await tx.$executeRaw`
      UPDATE b_order_ai_field_candidates SET status = 'superseded'
      WHERE order_id = ${input.orderId} AND status = 'pending'
    `
    for (const candidate of input.candidates) {
      await tx.$executeRaw`
        INSERT INTO b_order_ai_field_candidates (
          run_id, order_id, field_code, field_label, value_text, normalized_value_json,
          candidate_type, confidence, requires_confirmation, evidence_json
        ) VALUES (
          ${runId}, ${input.orderId}, ${candidate.fieldCode}, ${candidate.fieldLabel}, ${candidate.value},
          ${JSON.stringify(candidate.normalizedValue)}::jsonb, ${candidate.candidateType},
          ${candidate.confidence}, ${candidate.requiresConfirmation}, ${JSON.stringify(candidate.evidence)}::jsonb
        )
      `
    }
  })
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const details = [`${error.name}: ${error.message || '错误对象没有 message'}`]
    if (error.cause) details.push(`cause: ${describeError(error.cause)}`)
    if (error.stack) details.push(error.stack)
    return details.join('\n')
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

async function createRunningAnalysisRun(
  prisma: PrismaClient,
  input: {
    orderId: number
    applicationNo: string | null
    maxMessageId: number
    maxCallId: number
    maxMaterialId: number
  }
): Promise<bigint> {
  const rows = await prisma.$queryRaw<Array<{ id: bigint }>>`
    INSERT INTO b_order_ai_analysis_runs (
      order_id, application_no, model, prompt_version, status,
      source_message_max_id, source_call_max_id, source_material_max_id
    ) VALUES (
      ${input.orderId}, ${input.applicationNo}, ${String(process.env.HYYD_LLM_MODEL ?? 'qwen-plus').slice(0, 100)}, ${ORDER_AI_FIELD_PROMPT_VERSION}, 'running',
      ${input.maxMessageId}, ${input.maxCallId}, ${input.maxMaterialId}
    ) RETURNING id
  `
  return rows[0]!.id
}

async function completeRunningAnalysisRun(
  prisma: PrismaClient,
  input: {
    runId: bigint
    orderId: number
    model: string
    raw: string
    candidates: Awaited<ReturnType<typeof extractOrderServiceFields>>['candidates']
  }
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // 本轮使用完整沟通历史重新提取：上一轮未再次出现的候选也必须退出当前补位。
    await tx.$executeRaw`
      UPDATE b_order_ai_field_candidates SET status = 'superseded'
      WHERE order_id = ${input.orderId} AND status = 'pending'
    `
    for (const candidate of input.candidates) {
      await tx.$executeRaw`
        INSERT INTO b_order_ai_field_candidates (
          run_id, order_id, field_code, field_label, value_text, normalized_value_json,
          candidate_type, confidence, requires_confirmation, evidence_json
        ) VALUES (
          ${input.runId}, ${input.orderId}, ${candidate.fieldCode}, ${candidate.fieldLabel}, ${candidate.value},
          ${JSON.stringify(candidate.normalizedValue)}::jsonb, ${candidate.candidateType},
          ${candidate.confidence}, ${candidate.requiresConfirmation}, ${JSON.stringify(candidate.evidence)}::jsonb
        )
      `
    }
    await tx.$executeRaw`
      UPDATE b_order_ai_analysis_runs
      SET status = 'succeeded', model = ${input.model}, raw_result_json = ${JSON.stringify({ raw: input.raw })}::jsonb, completed_at = now()
      WHERE id = ${input.runId} AND status = 'running'
    `
  })
}

async function failRunningAnalysisRun(prisma: PrismaClient, runId: bigint, errorMessage: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE b_order_ai_analysis_runs
    SET status = 'failed', error_message = ${errorMessage.slice(0, 8000)}, completed_at = now()
    WHERE id = ${runId} AND status = 'running'
  `
}

async function loadBFormSavedValues(prisma: PrismaClient, orderId: number): Promise<Record<string, Record<string, string>>> {
  const saved: Record<string, Record<string, string>> = {}
  try {
    const formRows = await prisma.$queryRaw<Array<{ tab_code: string; data_json: Record<string, unknown> }>>`
      SELECT d.tab_code, d.data_json
      FROM b_order_form_tab_data d
      JOIN b_order_form_instances i ON i.id = d.form_instance_id
      JOIN b_order_operations o ON o.id = i.operation_id
      WHERE o.order_id = ${orderId} AND i.status <> 'void'
      ORDER BY i.updated_at DESC, i.id DESC
    `
    for (const row of formRows) {
      if (saved[row.tab_code]) continue
      const fields: Record<string, string> = {}
      for (const [key, value] of Object.entries(row.data_json ?? {})) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        for (const [property, stored] of Object.entries(value)) {
          if (typeof stored === 'string' && stored.trim() && stored.length <= 200) fields[`${key}.${property}`] = stored
        }
      }
      saved[row.tab_code] = fields
    }
  } catch (error) {
    console.warn(`[order-ai-field] orderId=${orderId} 读取 B 端正式表单值失败: ${describeError(error)}`)
  }
  return saved
}

/**
 * 自动字段与服务步骤分析。它不生成也不更新旧版 AI 简报，且使用独立水位：
 * 同一批输入无论成功还是失败都只尝试一次；有新素材后才会再次入队。
 */
export async function analyzeOrderFields(
  prisma: PrismaClient,
  minio: Minio.Client,
  orderId: number,
  options: { force?: boolean } = {}
): Promise<FieldAnalysisResult | null> {
  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order) return null

  const lastMsgId = order.fieldAiLastMsgId ?? 0
  const lastCallId = order.fieldAiLastCallId ?? 0
  const lastMaterialId = order.fieldAiLastMaterialId ?? 0
  const applicationNo = applicationNoOf(order.rawJson)
  const captureWhere = applicationNo ? { OR: [{ applicationNo }, { orderId }] } : { orderId }
  const [msgs, calls, mats] = await Promise.all([
    prisma.message.findMany({ where: captureWhere, orderBy: { id: 'asc' } }),
    prisma.call.findMany({ where: captureWhere, orderBy: { id: 'asc' } }),
    prisma.material.findMany({ where: { orderId }, orderBy: { id: 'asc' } })
  ])
  const maxMessageId = msgs.at(-1)?.id ?? lastMsgId
  const maxCallId = calls.at(-1)?.id ?? lastCallId
  const maxMaterialId = mats.at(-1)?.id ?? lastMaterialId
  const hasNewContent =
    msgs.some((m) => m.id > lastMsgId && (m.contentText ?? '').trim().length > 0) ||
    calls.some((c) => c.id > lastCallId && ((c.asrText ?? '').trim().length > 0 || (c.durationSec ?? 0) > 0)) ||
    mats.some((m) => m.id > lastMaterialId && (m.type === 'image' || (m.textContent ?? '').trim().length > 0))

  if (!hasNewContent && !options.force) {
    if (maxMessageId > lastMsgId || maxCallId > lastCallId || maxMaterialId > lastMaterialId) {
      await prisma.order.update({
        where: { id: orderId },
        data: { fieldAiLastMsgId: maxMessageId, fieldAiLastCallId: maxCallId, fieldAiLastMaterialId: maxMaterialId }
      })
    }
    return { skipped: true, reason: 'no_new_content', fieldExtractionSucceeded: false }
  }

  for (const material of mats) {
    if (material.type === 'image') await ensureImageUnderstood(prisma, minio, material)
  }
  const raw = (order.rawJson ?? {}) as Record<string, unknown>
  const bFormSaved = await loadBFormSavedValues(prisma, orderId)
  const runId = await createRunningAnalysisRun(prisma, { orderId, applicationNo, maxMessageId, maxCallId, maxMaterialId })

  try {
    const extraction = await extractOrderServiceFields({
      orderId,
      applicationNo,
      serviceType: String(raw.serviceType ?? raw.itemName ?? '').trim() || '未识别服务',
      currentValues: {
        hospital: order.hospital,
        department: order.dept,
        doctor: order.doctor,
        serviceRemark: raw.comments ?? raw.comment ?? null,
        bFormSaved
      },
      messages: [
        ...msgs.map((m) => ({
          id: m.id, channel: m.channel, senderName: m.senderName, contentText: m.contentText,
          occurredAt: m.sortTime ?? m.chatTime ?? m.capturedAt
        })),
        ...mats
          .map((m) => ({
            id: -m.id,
            channel: 'material',
            senderName: m.type === 'image' ? `补录图片(${m.aiImageKind || '单据'})` : '专员文字补录',
            contentText: m.type === 'image' ? m.aiImageText : m.textContent,
            occurredAt: m.createdAt
          }))
          .filter((m) => (m.contentText ?? '').trim().length > 0)
          .map((m) => ({ ...m, contentText: m.contentText! }))
      ],
      calls: calls.map((c) => ({ id: c.id, direction: c.direction, asrText: c.asrText, startedAt: c.startedAt }))
    })

    await completeRunningAnalysisRun(prisma, {
      runId, orderId, model: extraction.model, raw: extraction.raw, candidates: extraction.candidates
    })
    for (const event of extraction.workflowEvents) {
      const fingerprint = createHash('sha256').update(`${orderId}:${event.code}:${event.evidence}`).digest('hex').slice(0, 32)
      try {
        await applyOrderWorkflowEvent(prisma, orderId, {
          code: event.code, source: 'ai', sourceRef: `qwen:${event.code}:${fingerprint}`, confidence: 0.85,
          evidence: [{ text: event.evidence, model: extraction.model || 'qwen-plus' }], occurredAt: event.occurredAt, plannedAt: event.plannedAt
        })
      } catch (error) {
        console.warn(`[order-ai-field] orderId=${orderId} runId=${runId} 服务步骤 ${event.code} 写入失败: ${describeError(error)}`)
      }
    }
    console.log(`[order-ai-field] orderId=${orderId} runId=${runId} status=succeeded materialMaxId=${maxMaterialId} messageMaxId=${maxMessageId} callMaxId=${maxCallId} model=${extraction.model} candidates=${extraction.candidates.length} events=${extraction.workflowEvents.length}`)
    return { skipped: false, model: extraction.model, fieldExtractionSucceeded: true }
  } catch (error) {
    const errorMessage = describeError(error)
    console.error(`[order-ai-field] orderId=${orderId} runId=${runId} status=failed materialMaxId=${maxMaterialId} messageMaxId=${maxMessageId} callMaxId=${maxCallId} model=${String(process.env.HYYD_LLM_MODEL ?? 'qwen-plus')} promptVersion=${ORDER_AI_FIELD_PROMPT_VERSION}\n${errorMessage}`)
    try {
      await failRunningAnalysisRun(prisma, runId, errorMessage)
    } catch (runError) {
      console.error(`[order-ai-field] orderId=${orderId} runId=${runId} 失败记录写入异常:\n${describeError(runError)}`)
    }
    return { skipped: false, fieldExtractionSucceeded: false }
  } finally {
    // 自动任务不重试：本批输入无论成功或失败均消费，新的消息/通话/补录才会触发下一次调用。
    await prisma.order.update({
      where: { id: orderId },
      data: { fieldAiLastMsgId: maxMessageId, fieldAiLastCallId: maxCallId, fieldAiLastMaterialId: maxMaterialId }
    })
  }
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

  // 沟通记录以申请号采集，AI 仍以订单为粒度产出：同一申请号下的每张订单都会
  // 带着自己的服务类型和字段白名单分别分析，不能把记录强行归给某一张订单。
  const applicationNo = applicationNoOf(order.rawJson)
  const captureWhere = applicationNo
    ? { OR: [{ applicationNo }, { orderId }] }
    : { orderId }

  // 全量取：该申请号（或无申请号时该订单）名下所有消息/通话；手工补录仍只属于订单。
  const msgs = await prisma.message.findMany({
    where: captureWhere,
    orderBy: { id: 'asc' }
  })
  const calls = await prisma.call.findMany({
    where: captureWhere,
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

  // 第二个、严格限定字段白名单的结构化调用：给表单候选值与步骤流转使用。
  // 简报失败之外的候选提取失败不会丢掉已有简报；下一次有新沟通时会重试。
  // 步骤流转仅相信字段白名单提取器的结果；它失败时宁可不自动推进，也不能回退到
  // 面向展示的普通简报事件。
  let extractionEvents: typeof res.workflowEvents = []
  try {
    // 用 B 端已经保存的事实帮助模型识别“新增”与“变更”，不让模型照搬成候选。
    let bFormSaved: Record<string, Record<string, string>> = {}
    try {
      const formRows = await prisma.$queryRaw<Array<{ tab_code: string; data_json: Record<string, unknown> }>>`
        SELECT d.tab_code, d.data_json
        FROM b_order_form_tab_data d
        JOIN b_order_form_instances i ON i.id = d.form_instance_id
        JOIN b_order_operations o ON o.id = i.operation_id
        WHERE o.order_id = ${orderId} AND i.status <> 'void'
        ORDER BY i.updated_at DESC, i.id DESC
      `
      for (const row of formRows) {
        if (bFormSaved[row.tab_code]) continue
        const fields: Record<string, string> = {}
        for (const [key, value] of Object.entries(row.data_json ?? {})) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue
          for (const [property, saved] of Object.entries(value)) {
            if (typeof saved === 'string' && saved.trim() && saved.length <= 200) fields[`${key}.${property}`] = saved
          }
        }
        bFormSaved[row.tab_code] = fields
      }
    } catch (error) {
      console.warn(`[order-ai] 订单 ${orderId} 读取 B 端正式表单值失败:`, (error as Error).message)
    }
    const extraction = await extractOrderServiceFields({
      orderId,
      applicationNo,
      serviceType: String(raw.serviceType ?? raw.itemName ?? '').trim() || '未识别服务',
      currentValues: {
        hospital: order.hospital,
        department: order.dept,
        doctor: order.doctor,
        serviceRemark: raw.comments ?? raw.comment ?? null,
        bFormSaved
      },
      messages: [
        ...msgs.map((m) => ({
          id: m.id,
          channel: m.channel,
          senderName: m.senderName,
          contentText: m.contentText,
          occurredAt: m.sortTime ?? m.chatTime ?? m.capturedAt
        })),
        ...briefMats
          .filter((bm) => (bm.textContent ?? '').trim().length > 0)
          .map((bm, idx) => ({
            id: -(idx + 1),
            channel: 'material',
            senderName: bm.type === 'image' ? `补录图片(${bm.imageKind || '单据'})` : '专员文字补录',
            contentText: bm.textContent!,
            occurredAt: bm.createdAt
          }))
      ],
      calls: calls.map((c) => ({ id: c.id, direction: c.direction, asrText: c.asrText, startedAt: c.startedAt }))
    })
    extractionEvents = extraction.workflowEvents
    await persistFieldCandidates(prisma, {
      orderId,
      applicationNo,
      model: extraction.model,
      maxMessageId: maxMsgId,
      maxCallId,
      maxMaterialId,
      raw: extraction.raw,
      candidates: extraction.candidates
    })
    // 自动应用 AI 识别出的工作流事件（包括 service_cancelled 取消关单、各履约环节等）
    for (const event of extractionEvents) {
      const fingerprint = createHash('sha256').update(`${orderId}:${event.code}:${event.evidence}`).digest('hex').slice(0, 32)
      try {
        await applyOrderWorkflowEvent(prisma, orderId, {
          code: event.code,
          source: 'ai',
          sourceRef: `qwen:${event.code}:${fingerprint}`,
          confidence: 0.85,
          evidence: [{ text: event.evidence, model: extraction.model ?? 'qwen-plus' }], occurredAt: event.occurredAt, plannedAt: event.plannedAt
        })
      } catch (eventErr) {
        console.warn(`[order-ai] 订单 ${orderId} 自动应用事件 ${event.code} 异常:`, (eventErr as Error).message)
      }
    }
  } catch (error) {
    console.warn(`[order-ai] 订单 ${orderId} 字段提取失败，保留简报:`, (error as Error).message)
  }

  // 存储：简报字段 + 记号(本次跑到的最新 id) + 模型，便于前端展示与追溯
  const stored = {
    summary: res.summary,
    stage: res.stage,
    stageEvidence: res.stageEvidence,
    hasOpenIssue: res.hasOpenIssue,
    nextActions: res.nextActions,
    risks: res.risks,
    keyInfo: res.keyInfo,
    workflowEvents: extractionEvents,
    model: res.model,
    updatedFrom: { lastMessageId: maxMsgId, lastCallId: maxCallId, lastMaterialId: maxMaterialId }
  }

  await prisma.order.update({
    where: { id: orderId },
    data: {
      aiBriefJson: jsonInput(stored),
      briefUpdatedAt: new Date(),
      briefLastMsgId: maxMsgId,
      briefLastCallId: maxCallId,
      briefLastMaterialId: maxMaterialId
    }
  })

  return { brief: { ...res, workflowEvents: extractionEvents }, skipped: false, model: res.model }
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
