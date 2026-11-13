import { Prisma, type PrismaClient } from '@prisma/client'
import type * as Minio from 'minio'
import { chat } from '../llm/gatewayClient.js'
import { triggerOrderAiAnalysis } from '../jobs/orderAiSchedule.js'
import { getOrderAiAutomationConfig } from './orderAiAutomationConfig.js'

interface SummaryFields {
  patientName: string | null
  patientPhone: string | null
  hospital: string | null
  department: string | null
  doctor: string | null
  visitTime: string | null
}
interface Candidate {
  orderId: number
  applicationNo: string
  sourceOrderNo: string
  serviceType: string | null
  status: string
  patientName: string
  patientPhone: string | null
  hospital: string | null
  hospitals: string[]
  department: string | null
  departments: string[]
  doctor: string | null
  doctors: string[]
  visitTime: string | null
  visitTimes: string[]
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
function parseObject(content: string): Record<string, unknown> {
  const first = content.indexOf('{'), last = content.lastIndexOf('}')
  if (first < 0 || last <= first) throw new Error('陪诊小结 AI 未返回 JSON')
  const result: unknown = JSON.parse(content.slice(first, last + 1))
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('陪诊小结 AI 返回结构无效')
  return result as Record<string, unknown>
}
function normalizePhone(value: string | null): string {
  return value?.replace(/\D/g, '') ?? ''
}
function normalized(value: string | null): string {
  return value?.replace(/[\s（）()·]/g, '').toLowerCase() ?? ''
}
function matches(a: string | null, b: string | null): boolean {
  const x = normalized(a), y = normalized(b)
  return Boolean(x && y && (x.includes(y) || y.includes(x)))
}
function datesMatch(a: string | null, b: string | null): boolean {
  const date = (value: string | null) => value?.match(/(\d{4})[年\-/](\d{1,2})[月\-/](\d{1,2})/)
  const x = date(a), y = date(b)
  return Boolean(x && y && Number(x[1]) === Number(y[1]) && Number(x[2]) === Number(y[2]) && Number(x[3]) === Number(y[3]))
}
export function selectEscortCandidate(scores: Array<{ orderId: number; confidence: number }>, candidateIds: number[]): number | null {
  if (scores.length !== candidateIds.length || new Set(scores.map((s) => s.orderId)).size !== candidateIds.length || scores.some((s) => !candidateIds.includes(s.orderId) || !Number.isFinite(s.confidence) || s.confidence < 0 || s.confidence > 100)) throw new Error('陪诊小结 AI 返回的候选订单或置信度无效')
  const sorted = [...scores].sort((a, b) => b.confidence - a.confidence)
  if (!sorted[0] || sorted[0].confidence < 70 || sorted[1]?.confidence === sorted[0].confidence) return null
  return sorted[0].orderId
}
function first(...values: unknown[]): string | null {
  for (const value of values) { const item = asText(value); if (item) return item }
  return null
}
function orderFields(value: unknown, names: Set<string>, output: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) orderFields(item, names, output)
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // The user requested that chat histories are not sent to matching AI.
      if (/communication|conversation|messages?|chat|沟通|聊天/i.test(key)) continue
      if (names.has(key.toLowerCase())) {
        const found = asText(item)
        if (found && !output.includes(found)) output.push(found)
      }
      if (item && typeof item === 'object') orderFields(item, names, output)
    }
  }
  return output
}
type MatcherDependencies = {
  chat: typeof chat
  config: typeof getOrderAiAutomationConfig
  trigger: typeof triggerOrderAiAnalysis
}
const defaultDependencies: MatcherDependencies = { chat, config: getOrderAiAutomationConfig, trigger: triggerOrderAiAnalysis }
async function finishAnalysis(prisma: PrismaClient, minio: Minio.Client, id: number, orderId: number, result: Record<string, unknown>, deps: MatcherDependencies): Promise<void> {
  const analysis = await deps.trigger(prisma, minio, orderId)
  if (!analysis) throw new Error('陪诊小结关联的订单不存在')
  if (analysis.skipped && analysis.reason === 'waiting_for_retry') throw new Error('订单字段分析等待重试')
  if (analysis.skipped && analysis.reason === 'automatic_retries_exhausted') {
    await prisma.$executeRaw`UPDATE escort_summary_jobs SET status='analysis_failed', result=COALESCE(result, '{}'::jsonb) || ${JSON.stringify(result)}::jsonb, last_error='订单字段分析自动重试已耗尽', updated_at=NOW() WHERE message_id=${id}`
    console.error('[escort-summary] 订单字段分析重试已耗尽', { messageId: id, orderId })
    return
  }
  if (analysis.skipped && analysis.reason !== 'no_new_content') throw new Error(`订单字段分析未执行：${analysis.reason ?? '未知原因'}`)
  await prisma.$executeRaw`UPDATE escort_summary_jobs SET status='matched', result=COALESCE(result, '{}'::jsonb) || ${JSON.stringify(result)}::jsonb, last_error=NULL, updated_at=NOW() WHERE message_id=${id}`
}
export async function processEscortSummaryJob(prisma: PrismaClient, minio: Minio.Client, id: number, deps: MatcherDependencies = defaultDependencies): Promise<void> {
  const message = await prisma.nativeChatMessage.findUnique({ where: { id }, include: { conversation: true } })
  if (!message || !message.text) throw new Error('陪诊小结消息不存在或正文为空')
  const config = await deps.config(prisma)
  const opts = { model: config.textAnalysisModel, provider: config.textAnalysisProvider, temperature: 0, timeoutMs: 90_000 }
  const extracted = parseObject((await deps.chat([
    { role: 'system', content: '判断消息是否实际包含陪诊服务经过或结束小结，并提取就诊人及本次就诊信息。仅出现“陪诊小结”等字样但没有实际内容，不算小结；若为引用或微信笔记，请检查其中的实际内容。对于实际小结，将其提炼为可填写的服务小结，保留就诊经过、医生意见、诊断、检查结果及后续安排等原文明确的关键事实，不得编造；如内容简短可保留原文。只返回 JSON：isSummary（boolean）、escortSummary（提炼后文字，无实际小结时为 null）、patientName、patientPhone、hospital、department、doctor、visitTime，未知填 null。电话必须是就诊人或客户电话，不得使用陪诊人的电话。不要猜测或补全。' },
    { role: 'user', content: message.text }
  ], opts)).content)
  if (typeof extracted.isSummary !== 'boolean') throw new Error('陪诊小结 AI 未返回有效的小结判断')
  if (!extracted.isSummary) {
    await prisma.$executeRaw`UPDATE escort_summary_jobs SET status='not_summary', result=${JSON.stringify({ reason: '消息未包含实际陪诊小结' })}::jsonb, last_error=NULL, updated_at=NOW() WHERE message_id=${id}`
    console.info('[escort-summary] 不含实际小结', { messageId: id })
    return
  }
  const escortSummary = asText(extracted.escortSummary)
  if (!escortSummary) throw new Error('陪诊小结 AI 未返回提炼结果')
  await prisma.$executeRaw`UPDATE escort_summary_jobs SET result=COALESCE(result, '{}'::jsonb) || ${JSON.stringify({ escortSummary })}::jsonb, updated_at=NOW() WHERE message_id=${id}`
  // Explicit dispatch or manager-confirmed links take precedence, but only
  // after confirming this message actually contains a completed summary.
  if (message.orderId && message.applicationLinkStatus === 'matched') {
    await finishAnalysis(prisma, minio, id, message.orderId, { orderId: message.orderId, source: message.applicationLinkSource }, deps)
    return
  }
  const fields: SummaryFields = { patientName: asText(extracted.patientName), patientPhone: asText(extracted.patientPhone), hospital: asText(extracted.hospital), department: asText(extracted.department), doctor: asText(extracted.doctor), visitTime: asText(extracted.visitTime) }
  if (fields.patientName && !normalized(message.text).includes(normalized(fields.patientName))) throw new Error('陪诊小结 AI 返回的就诊人姓名不在原文中')
  if (fields.patientPhone && !normalizePhone(message.text).includes(normalizePhone(fields.patientPhone))) throw new Error('陪诊小结 AI 返回的客户电话不在原文中')
  if (!fields.patientName && normalizePhone(fields.patientPhone).length < 11) {
    await prisma.$executeRaw`UPDATE escort_summary_jobs SET status='unmatched', result=${JSON.stringify({ escortSummary, fields, reason: '没有可核对的就诊人姓名或完整客户电话' })}::jsonb, last_error=NULL, updated_at=NOW() WHERE message_id=${id}`
    console.info('[escort-summary] 未匹配：缺少就诊人姓名和客户电话', { messageId: id })
    return
  }
  // Fetch every matching order, not the entire order database and not just a page.
  const terms: Prisma.Sql[] = []
  if (fields.patientName) {
    terms.push(Prisma.sql`(customer_name = ${fields.patientName} OR raw_json->>'patientName' = ${fields.patientName} OR raw_json->>'patient_name' = ${fields.patientName} OR raw_json->>'JZR_XM' = ${fields.patientName} OR detail_json->>'patientName' = ${fields.patientName} OR detail_json->'recommendations'->>'patientName' = ${fields.patientName})`)
  }
  const phone = normalizePhone(fields.patientPhone)
  if (phone.length >= 11) {
    terms.push(Prisma.sql`(regexp_replace(COALESCE(customer_phone, ''), '[^0-9]', '', 'g') = ${phone}
      OR regexp_replace(COALESCE(raw_json->>'patientPhone', ''), '[^0-9]', '', 'g') = ${phone}
      OR regexp_replace(COALESCE(raw_json->>'phone', ''), '[^0-9]', '', 'g') = ${phone}
      OR regexp_replace(COALESCE(raw_json->>'mobile', ''), '[^0-9]', '', 'g') = ${phone}
      OR regexp_replace(COALESCE(raw_json->>'JZR_LXDH', ''), '[^0-9]', '', 'g') = ${phone}
      OR regexp_replace(COALESCE(detail_json->>'patientPhone', ''), '[^0-9]', '', 'g') = ${phone}
      OR regexp_replace(COALESCE(detail_json->'recommendations'->>'patientPhone', ''), '[^0-9]', '', 'g') = ${phone})`)
  }
  if (!terms.length) throw new Error('陪诊小结缺少可用于查找的就诊人姓名或电话')
  const orders = await prisma.$queryRaw<Array<{ id: number; sourceOrderNo: string; customerName: string; customerPhone: string | null; hospital: string | null; dept: string | null; doctor: string | null; status: string; rawJson: unknown; detailJson: unknown }>>(Prisma.sql`
    SELECT id, source_order_no AS "sourceOrderNo", customer_name AS "customerName", customer_phone AS "customerPhone",
           hospital, dept, doctor, status, raw_json AS "rawJson", detail_json AS "detailJson"
      FROM orders WHERE source = 'taikang' AND (${Prisma.join(terms, ' OR ')})
  `)
  const candidates: Candidate[] = []
  for (const order of orders) {
    const raw = asObject(order.rawJson), detail = asObject(order.detailJson), rec = asObject(detail.recommendations)
    const applicationNo = asText(raw.crmApplyNo)
    const names = [raw.patientName, raw.patient_name, raw.JZR_XM, detail.patientName, rec.patientName, order.customerName].map(asText).filter((v): v is string => Boolean(v))
    const name = names.find((value) => normalized(value) === normalized(fields.patientName)) ?? names[0] ?? null
    const phones = [order.customerPhone, raw.patientPhone, raw.phone, raw.mobile, raw.JZR_LXDH, detail.patientPhone, rec.patientPhone].map(asText).filter((v): v is string => Boolean(v))
    const phone = phones.find((value) => normalizePhone(value) === normalizePhone(fields.patientPhone)) ?? phones[0] ?? null
    const nameMatch = Boolean(fields.patientName && name && normalized(fields.patientName) === normalized(name))
    const phoneMatch = Boolean(normalizePhone(fields.patientPhone).length >= 11 && normalizePhone(fields.patientPhone) === normalizePhone(phone))
    if (!applicationNo || (!nameMatch && !phoneMatch)) continue
    const hospitals = [...new Set([order.hospital, ...orderFields([raw, detail], new Set(['intendhos', 'hospital', 'hospitalname', 'hospital_name', '医院', '就诊医院']))].filter((v): v is string => Boolean(v)))]
    const departments = [...new Set([order.dept, ...orderFields([raw, detail], new Set(['intenddept', 'dept', 'department', 'departmentname', '科室', '就诊科室']))].filter((v): v is string => Boolean(v)))]
    const doctors = [...new Set([order.doctor, ...orderFields([raw, detail], new Set(['intenddoc', 'doctor', 'doctorname', '医生', '专家']))].filter((v): v is string => Boolean(v)))]
    const visitTimes = orderFields([raw, detail], new Set(['appointmentdate', 'appointmenttime', 'visitdate', 'visittime', 'servicedate', '就诊日期', '就诊时间']))
    candidates.push({ orderId: order.id, applicationNo, sourceOrderNo: order.sourceOrderNo, serviceType: first(raw.serviceType, raw.service_type, detail.serviceType, detail.service_type), status: order.status, patientName: name ?? '', patientPhone: phone, hospital: hospitals[0] ?? null, hospitals, department: departments[0] ?? null, departments, doctor: doctors[0] ?? null, doctors, visitTime: visitTimes[0] ?? null, visitTimes })
  }
  if (!candidates.length) {
    await prisma.$executeRaw`UPDATE escort_summary_jobs SET status='unmatched', result=${JSON.stringify({ escortSummary, fields, reason: '未找到对应泰康订单' })}::jsonb, last_error=NULL, updated_at=NOW() WHERE message_id=${id}`
    console.info('[escort-summary] 未匹配：未找到候选订单', { messageId: id })
    return
  }
  let selected: number | null = null
  let scores: Array<{ orderId: number; confidence: number }> = []
  if (candidates.length === 1) {
    const c = candidates[0]
    const name = fields.patientName && normalized(fields.patientName) === normalized(c.patientName)
    const phone = normalizePhone(fields.patientPhone).length >= 11 && normalizePhone(fields.patientPhone) === normalizePhone(c.patientPhone)
    const visitEvidence = c.hospitals.some((item) => matches(fields.hospital, item)) || c.departments.some((item) => matches(fields.department, item)) || c.doctors.some((item) => matches(fields.doctor, item)) || c.visitTimes.some((item) => datesMatch(fields.visitTime, item))
    if ((name && phone) || ((name || phone) && visitEvidence)) selected = c.orderId
  }
  if (selected === null && candidates.length > 1) {
    const response = parseObject((await deps.chat([
      { role: 'system', content: '你是医疗陪诊小结与泰康订单匹配助手。只依据给出的信息，逐一评价全部候选订单与小结是否同一人、同一次服务；不确定或资料不足应给低分，不得编造。只返回 JSON：{"scores":[{"orderId":数字,"confidence":0到100}]}，每个候选必须且只能出现一次。' },
      { role: 'user', content: JSON.stringify({ summary: fields, candidates }) }
    ], opts)).content)
    if (!Array.isArray(response.scores)) throw new Error('陪诊小结 AI 缺少候选评分')
    scores = response.scores.map((item) => { const v = asObject(item); return { orderId: Number(v.orderId), confidence: Number(v.confidence) } })
    selected = selectEscortCandidate(scores, candidates.map((c) => c.orderId))
  }
  const selectedCandidate = candidates.find((candidate) => candidate.orderId === selected)
  if (!selectedCandidate) {
    await prisma.$executeRaw`UPDATE escort_summary_jobs SET status='unmatched', result=${JSON.stringify({ escortSummary, fields, candidates, scores, reason: '证据不足或候选置信度未达到70%' })}::jsonb, last_error=NULL, updated_at=NOW() WHERE message_id=${id}`
    console.info('[escort-summary] 未匹配：候选证据不足', { messageId: id, candidateCount: candidates.length })
    return
  }
  const evidence = JSON.stringify({ fields, scores, candidateOrderIds: candidates.map((c) => c.orderId) })
  const changed = await prisma.$executeRaw`
    UPDATE native_chat_messages SET application_no=${selectedCandidate.applicationNo}, order_id=${selectedCandidate.orderId},
      application_link_status='matched', application_link_source='escort_summary', application_link_evidence=${evidence}::jsonb, application_linked_at=NOW()
    WHERE id=${id} AND application_link_source IS DISTINCT FROM 'manager_confirmation'
      AND application_link_status <> 'conflict'
      AND (order_id IS NULL OR order_id=${selectedCandidate.orderId})
      AND (application_no IS NULL OR application_no=${selectedCandidate.applicationNo})
  `
  if (changed !== 1) {
    await prisma.$executeRaw`UPDATE escort_summary_jobs SET status='conflict', result=${JSON.stringify({ escortSummary, fields, candidateOrderId: selectedCandidate.orderId, scores })}::jsonb, last_error='消息已有不同关联或正在人工确认', updated_at=NOW() WHERE message_id=${id}`
    console.warn('[escort-summary] 关联冲突，保留原关联', { messageId: id, candidateOrderId: selectedCandidate.orderId })
    return
  }
  await finishAnalysis(prisma, minio, id, selectedCandidate.orderId, { fields, orderId: selectedCandidate.orderId, applicationNo: selectedCandidate.applicationNo, scores }, deps)
  console.info('[escort-summary] 订单关联完成', { messageId: id, orderId: selectedCandidate.orderId })
}
let timer: ReturnType<typeof setInterval> | null = null
let active = false
export function startEscortSummaryMatcher(prisma: PrismaClient, minio: Minio.Client): void {
  if (timer) return
  const tick = async () => {
    if (active) return
    active = true
    try {
      const rows = await prisma.$queryRaw<Array<{ message_id: number }>>`
        UPDATE escort_summary_jobs SET status='running', attempts=attempts+1, updated_at=NOW()
        WHERE message_id=(SELECT message_id FROM escort_summary_jobs WHERE (status='pending' AND next_attempt_at <= NOW()) OR (status='running' AND updated_at < NOW() - INTERVAL '10 minutes') ORDER BY next_attempt_at, message_id FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING message_id
      `
      const row = rows[0]
      if (!row) return
      try { await processEscortSummaryJob(prisma, minio, row.message_id) }
      catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        console.error('[escort-summary] 处理失败', { messageId: row.message_id, error: detail })
        await prisma.$executeRaw`UPDATE escort_summary_jobs SET status='pending', last_error=${detail}, next_attempt_at=NOW() + INTERVAL '5 minutes', updated_at=NOW() WHERE message_id=${row.message_id}`
      }
    } catch (error) { console.error('[escort-summary] 任务读取失败', error) }
    finally { active = false }
  }
  timer = setInterval(() => void tick(), 5_000)
  void tick()
}
