import type { PrismaClient } from '@prisma/client'
import { visionChat } from '../llm/gatewayClient.js'

export type RegistrationProofFields = {
  isRegistrationProof: boolean
  confidence: number | null
  proofType: string | null
  patientName: string | null
  patientNameSuffix: string | null
  idCardSuffix: string | null
  phoneSuffix: string | null
  hospital: string | null
  department: string | null
  doctor: string | null
  appointmentDate: string | null
  appointmentTime: string | null
  registrationNumber: string | null
  rawText: string
  evidence: string[]
}

export type RegistrationOrderCandidate = {
  orderId: number
  sourceOrderNo: string
  customerName: string
  customerPhone: string | null
  hospital: string | null
  department: string | null
  doctor: string | null
  status: string
  appointmentDate: string | null
  matchedFields: string[]
  score: number
}

export type RegistrationProofAnalysis = {
  proof: RegistrationProofFields
  programCandidates: RegistrationOrderCandidate[]
  programMatch: RegistrationOrderCandidate | null
  aiSuggestion: {
    orderId: number
    confidence: number
    matchedFields: string[]
    reason: string
  } | null
  aiCandidateCount: number
}

const SYSTEM_PROMPT = [
  '你是寰宇医疗服务的挂号凭证识别助手。',
  '输入图片可能来自医院小程序、公众号、短信、网页、微信转发图或手机拍摄屏幕。版式不固定。',
  '请判断它是否表达了医院挂号或预约已经成功。',
  '宽松判断规则：如果同时出现挂号/预约成功语义，以及医院、医疗机构、科室、医生、就诊时间或就诊人等医疗预约信息，可以判断为挂号凭证。',
  '不要因为缺少某个字段就否定凭证。普通缴费单、检查报告、病历、普通聊天截图和广告不属于挂号凭证。',
  '只提取图片中明确看见的内容，不要猜测、补全或根据常识编造。脱敏姓名、身份证后四位、手机号后四位要保留可见部分。',
  '必须只返回 JSON，不要 Markdown，不要解释。',
  'JSON 字段：isRegistrationProof(boolean), confidence(number 0-1 或 null), proofType(string 或 null), patientName(string 或 null), patientNameSuffix(string 或 null), idCardSuffix(string 或 null), phoneSuffix(string 或 null), hospital(string 或 null), department(string 或 null), doctor(string 或 null), appointmentDate(string 或 null), appointmentTime(string 或 null), registrationNumber(string 或 null), rawText(string), evidence(string[])。'
].join('\n')

const AI_MATCH_PROMPT = [
  '你负责把一张挂号凭证与候选订单进行比对。',
  '只能从候选订单中选择，不能生成候选订单之外的 ID。',
  '优先比较医院、科室、患者可见姓名、身份证后四位、手机号后四位、医生和就诊日期。',
  '脱敏姓名只有末字时不能单独作为确定依据。',
  '如果没有足够证据，candidateOrderId 必须为 null。',
  '只返回 JSON：{"candidateOrderId":number|null,"confidence":number,"matchedFields":string[],"reason":string}'
].join('\n')

type OrderRow = {
  id: number
  sourceOrderNo: string
  customerName: string
  customerPhone: string | null
  hospital: string | null
  dept: string | null
  doctor: string | null
  status: string
  assignedEmployeeId: number | null
  rawJson: unknown
  detailJson: unknown
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const result = value.trim()
  return result || null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const found = text(value)
    if (found) return found
  }
  return null
}

function flattenStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') {
    const s = value.trim()
    if (s) output.push(s)
  } else if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, output)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) flattenStrings(item, output)
  }
  return output
}

function orderExtra(row: OrderRow): { patientName: string | null; idCardSuffix: string | null; phoneSuffix: string | null; appointmentDate: string | null; identifiers: string[] } {
  const raw = record(row.rawJson)
  const detail = record(row.detailJson)
  const rec = record(detail.recommendations)
  const patientName = firstText(raw.patientName, raw.patient_name, raw.JZR_XM, detail.patientName, detail.patient_name, rec.patientName, rec.patient_name)
  const idCard = firstText(raw.idCard, raw.idNumber, raw.cardId, raw.certNo, raw.JZR_ZJHM, detail.idCard, detail.idNumber, rec.idCard)
  const phone = firstText(raw.phone, raw.mobile, raw.patientPhone, raw.JZR_LXDH, detail.phone, detail.patientPhone, rec.patientPhone)
  const appointmentDate = firstText(raw.appointmentDate, raw.visitDate, raw.serviceDate, raw['就诊日期'], detail.appointmentDate, detail.visitDate, rec.appointmentDate)
  const identifiers = flattenStrings({
    sourceOrderNo: row.sourceOrderNo,
    raw,
    detail
  }).filter((value) => value.length >= 4)
  return {
    patientName,
    idCardSuffix: idCard ? digits(idCard).slice(-4) || null : null,
    phoneSuffix: phone ? digits(phone).slice(-4) || null : null,
    appointmentDate,
    identifiers
  }
}

function digits(value: string): string {
  return value.replace(/\D/g, '')
}

function compact(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[\s()（）\-—_:：,.，。/\\]/g, '')
}

function includesValue(haystack: string | null | undefined, needle: string | null | undefined): boolean {
  const h = compact(haystack)
  const n = compact(needle)
  return Boolean(h && n && (h.includes(n) || n.includes(h)))
}

function dateMatches(orderDate: string | null, proofDate: string | null): boolean {
  if (!orderDate || !proofDate) return false
  const a = orderDate.replace(/年|月/g, '-').replace(/日/g, '').replace(/\//g, '-')
  const b = proofDate.replace(/年|月/g, '-').replace(/日/g, '').replace(/\//g, '-')
  return compact(a) === compact(b) || a.includes(b) || b.includes(a)
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('视觉模型没有返回 JSON 对象')
  const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('视觉模型 JSON 结构非法')
  return parsed as Record<string, unknown>
}

function parseProof(content: string): RegistrationProofFields {
  const parsed = parseJsonObject(content)
  if (typeof parsed.isRegistrationProof !== 'boolean') throw new Error('视觉模型缺少 isRegistrationProof')
  const confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
    ? Math.max(0, Math.min(1, parsed.confidence))
    : null
  const evidence = Array.isArray(parsed.evidence) ? parsed.evidence.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean) : []
  return {
    isRegistrationProof: parsed.isRegistrationProof,
    confidence,
    proofType: text(parsed.proofType),
    patientName: text(parsed.patientName),
    patientNameSuffix: text(parsed.patientNameSuffix),
    idCardSuffix: text(parsed.idCardSuffix),
    phoneSuffix: text(parsed.phoneSuffix),
    hospital: text(parsed.hospital),
    department: text(parsed.department),
    doctor: text(parsed.doctor),
    appointmentDate: text(parsed.appointmentDate),
    appointmentTime: text(parsed.appointmentTime),
    registrationNumber: text(parsed.registrationNumber),
    rawText: text(parsed.rawText) ?? '',
    evidence
  }
}

function matchOrder(row: OrderRow, proof: RegistrationProofFields): RegistrationOrderCandidate {
  const extra = orderExtra(row)
  const matchedFields: string[] = []
  let score = 0
  if (proof.registrationNumber && extra.identifiers.some(value => includesValue(value, proof.registrationNumber))) {
    matchedFields.push('registrationNumber')
    score += 8
  }
  if (proof.hospital && includesValue(row.hospital, proof.hospital)) { matchedFields.push('hospital'); score += 3 }
  if (proof.department && includesValue(row.dept, proof.department)) { matchedFields.push('department'); score += 3 }
  if (proof.doctor && includesValue(row.doctor, proof.doctor)) { matchedFields.push('doctor'); score += 2 }
  if (proof.patientName && includesValue(extra.patientName ?? row.customerName, proof.patientName)) { matchedFields.push('patientName'); score += 3 }
  if (proof.patientNameSuffix && extra.patientName?.endsWith(proof.patientNameSuffix)) { matchedFields.push('patientNameSuffix'); score += 1 }
  if (proof.idCardSuffix && extra.idCardSuffix === digits(proof.idCardSuffix).slice(-4)) { matchedFields.push('idCardSuffix'); score += 5 }
  if (proof.phoneSuffix && extra.phoneSuffix === digits(proof.phoneSuffix).slice(-4)) { matchedFields.push('phoneSuffix'); score += 4 }
  if (dateMatches(extra.appointmentDate, proof.appointmentDate)) { matchedFields.push('appointmentDate'); score += 3 }
  return {
    orderId: row.id,
    sourceOrderNo: row.sourceOrderNo,
    customerName: extra.patientName ?? row.customerName,
    customerPhone: row.customerPhone,
    hospital: row.hospital,
    department: row.dept,
    doctor: row.doctor,
    status: row.status,
    appointmentDate: extra.appointmentDate,
    matchedFields,
    score
  }
}

function isUsefulAnchor(candidate: RegistrationOrderCandidate): boolean {
  return candidate.matchedFields.some(field => ['registrationNumber', 'idCardSuffix', 'phoneSuffix', 'hospital', 'department', 'appointmentDate'].includes(field))
}

export async function analyzeRegistrationProof(
  prisma: PrismaClient,
  imageDataUrl: string,
  employeeId: number
): Promise<RegistrationProofAnalysis> {
  const vision = await visionChat(SYSTEM_PROMPT, '请识别这张图片，只返回规定 JSON。', imageDataUrl, {
    model: process.env.HYYD_VLM_MODEL || 'qwen-vl-max',
    temperature: 0
  })
  const proof = parseProof(vision.content)
  if (!proof.isRegistrationProof) {
    return { proof, programCandidates: [], programMatch: null, aiSuggestion: null, aiCandidateCount: 0 }
  }

  const rows = await prisma.order.findMany({
    select: {
      id: true, sourceOrderNo: true, customerName: true, customerPhone: true,
      hospital: true,
      dept: true,
      doctor: true,
      status: true,
      assignedEmployeeId: true,
      rawJson: true,
      detailJson: true
    }
  }) as OrderRow[]
  const candidates = rows
    .map(row => matchOrder(row, proof))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.orderId - b.orderId)
  const best = candidates[0] ?? null
  const second = candidates[1] ?? null
  const programMatch = best && isUsefulAnchor(best) && (best.score >= 8 || (best.score >= 6 && (!second || best.score > second.score))) ? best : null

  if (programMatch) {
    return { proof, programCandidates: candidates, programMatch, aiSuggestion: null, aiCandidateCount: 0 }
  }

  // AI 只能在当前员工负责的订单中辅助判断。程序匹配仍然使用完整订单集，
  // 这样不会因为员工分配字段异常而漏掉程序上的强匹配；也不会把全量订单发给模型。
  const aiCandidates = rows
    .filter(row => row.assignedEmployeeId === employeeId)
    .map(row => matchOrder(row, proof))
    .filter(isUsefulAnchor)
    .sort((a, b) => b.score - a.score || a.orderId - b.orderId)
  if (aiCandidates.length === 0) {
    return { proof, programCandidates: candidates, programMatch: null, aiSuggestion: null, aiCandidateCount: 0 }
  }
  const candidateText = aiCandidates.map(candidate => JSON.stringify(candidate)).join('\n')
  const aiVision = await visionChat(
    AI_MATCH_PROMPT,
    `挂号凭证识别结果：${JSON.stringify(proof)}\n候选订单：\n${candidateText}`,
    imageDataUrl,
    { model: process.env.HYYD_VLM_MODEL || 'qwen-vl-max', temperature: 0 }
  )
  const ai = parseJsonObject(aiVision.content)
  const id = typeof ai.candidateOrderId === 'number' ? ai.candidateOrderId : null
  const confidence = typeof ai.confidence === 'number' ? Math.max(0, Math.min(1, ai.confidence)) : 0
  const matchedFields = Array.isArray(ai.matchedFields) ? ai.matchedFields.filter((v): v is string => typeof v === 'string') : []
  const reason = text(ai.reason) ?? ''
  const valid = id !== null && aiCandidates.some(candidate => candidate.orderId === id)
  return {
    proof,
    programCandidates: candidates.length > 0 ? candidates : aiCandidates,
    programMatch: null,
    aiSuggestion: valid && confidence > 0 ? { orderId: id!, confidence, matchedFields, reason } : null,
    aiCandidateCount: aiCandidates.length
  }
}
