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
    registrationNumber: raw.registrationNumber,
    registrationNo: raw.registrationNo,
    appointmentNumber: raw.appointmentNumber,
    appointmentNo: raw.appointmentNo,
    visitNumber: raw.visitNumber,
    挂号号: raw['挂号号'],
    预约号: raw['预约号'],
    就诊号: raw['就诊号'],
    detailRegistrationNumber: detail.registrationNumber,
    detailRegistrationNo: detail.registrationNo,
    detailAppointmentNumber: detail.appointmentNumber,
    detailAppointmentNo: detail.appointmentNo
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

function businessDateTime(value: Date): string {
  return value.toLocaleString('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  })
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
    model: process.env.HYYD_VLM_MODEL?.trim() || 'gui-plus',
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
    { model: process.env.HYYD_VLM_MODEL?.trim() || 'gui-plus', temperature: 0 }
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

type NativeImageSummary = {
  description: string
  visibleText: string
  visibleFields: Array<{ label: string; value: string }>
}

type NativeRegistrationMatch = {
  applicationDecision: 'matched' | 'ambiguous' | 'no_match'
  applicationNo: string | null
  applicationEvidence: string[]
  orderDecision: 'matched' | 'ambiguous' | 'not_evaluated'
  orderId: number | null
  orderEvidence: string[]
  alternatives: string[]
  reason: string
  candidateApplicationCount: number
  candidateOrderCount: number
  candidateApplications: Array<{
    applicationNo: string
    programEvidence: string[]
    orders: Array<{
      orderId: number
      sourceOrderNo: string
      customerName: string
      serviceType: string | null
      hospital: string | null
      department: string | null
      doctor: string | null
      appointmentDate: string | null
      status: string
      programMatchedFields: string[]
    }>
  }>
}

const NATIVE_APPLICATION_ORDER_PROMPT = [
  '你是寰宇医疗服务的业务匹配助手。图片内容已由图片识别步骤判定为挂号凭证。本次任务不是重新判断图片类型，而是依次确定凭证属于哪个申领号，以及该申领号下的哪张服务订单。',
  '业务背景：泰康申领号代表一个客户的服务申请，一个申领号下可能有多张寰宇服务订单。多张订单属于同一个客户，姓名末字可以帮助核对客户和申领号，但不能区分同一申领号下的不同订单。客户可能使用多个挂号权益，也可能在不同服务阶段多次挂号；复诊次数没有固定上限，通常会间隔一段时间。医院可以相同或不同；订单的服务目的、计划、进度必须按各自记录判断，不能互相挪用。',
  '电话、微信、企微中讨论的医院、科室、医生和日期可能只是备选方案。讨论过不等于已经办理。挂号凭证表达的实际结果是判断最终选择的重要证据；同时检查发生时间更晚的取消、改约或重新办理信息。',
  '只能把本次输入明确提供的订单字段和沟通事实当作证据。未提供沟通记录或时间线为空，只表示当前资料没有这部分，不能据此推断现实中没有历史沟通、属于首次服务或没有复诊；不得以“没有历史记录”为订单排序依据，也不得在 reason 或 evidence 中声称没有历史记录。图片只证明凭证上这一次挂号所表达的状态，不能据此推断客户是首次挂号、首次就诊或复诊；只有输入中的订单字段或沟通明确说明时，才能使用首次/复诊结论。图片里的登记号、就诊序号、医院订单号不是泰康申领号，也不是寰宇订单号。若候选订单没有提供与图片编号相同的业务编号字段，就完全忽略该图片编号，不得依据编号格式、数字片段或自行推算的生成时间进行匹配。',
  '请分两阶段推理。第一阶段：只从程序给出的申领号候选中判断申领号。图片不会出现泰康或寰宇系统使用的申领号，不要声称从图片中读到了申领号。综合图片实际可见的患者姓名（包括末字）、联系方式或证件尾号、医院、科室、日期及候选记录判断，并说明命中依据和冲突。若候选不足以区分，不要强行选申领号。',
  '第二阶段：只有申领号已经明确后才判断订单。只比较该申领号下给出的全部订单，结合凭证内容、订单服务目的、计划时间、订单进度和沟通时间线。区分不同挂号权益、首次就诊和后续复诊，以及讨论方案和实际办理结果。不得因为医院或科室相同就直接认定为同一单，也不得把一个订单的信息复制到另一个订单。',
  '候选申领号仍有冲突时，不要继续选订单。申领号确定但订单证据不足时，保留为该申领号下尚未确定具体订单的凭证。输出前逐条核对 applicationEvidence、orderEvidence 和 reason，删除无法在图片实际内容、候选订单字段或沟通时间线中找到明确依据的说法。只能返回输入候选中的申领号和订单 ID。只返回 JSON：{"applicationDecision":"matched|ambiguous|no_match","applicationNo":string|null,"applicationEvidence":string[],"orderDecision":"matched|ambiguous|not_evaluated","orderId":number|null,"orderEvidence":string[],"alternatives":string[],"reason":string}。'
].join('\n')

const NATIVE_LINKED_APPLICATION_ORDER_PROMPT = [
  '你是寰宇医疗服务的业务匹配助手。图片内容已由图片识别步骤判定为挂号凭证，且原微信/企微会话已确认关联到一个申领号。该申领号关系是程序已确认的业务资料，本次不需要搜索或重新判断申领号，只判断凭证属于该申领号下的哪张服务订单。',
  '业务背景：泰康申领号代表一个客户的服务申请，一个申领号下可能有多张寰宇服务订单。多张订单属于同一个客户，姓名末字可以帮助确认客户，但不能区分同一申领号下的不同订单。客户可能使用多个挂号权益，也可能在不同服务阶段多次挂号；复诊次数没有固定上限，通常会间隔一段时间。医院可以相同或不同；订单的服务目的、计划、进度必须按各自记录判断，不能互相挪用。',
  '电话、微信、企微中讨论的医院、科室、医生和日期可能只是备选方案。讨论过不等于已经办理。挂号凭证表达的实际结果是判断最终选择的重要证据；同时检查发生时间更晚的取消、改约或重新办理信息。',
  '只能把本次输入明确提供的订单字段和沟通事实当作证据。未提供沟通记录或时间线为空，只表示当前资料没有这部分，不能据此推断现实中没有历史沟通、属于首次服务或没有复诊；不得以“没有历史记录”为订单排序依据，也不得在 reason 或 evidence 中声称没有历史记录。图片只证明凭证上这一次挂号所表达的状态，不能据此推断客户是首次挂号、首次就诊或复诊；只有输入中的订单字段或沟通明确说明时，才能使用首次/复诊结论。图片里的登记号、就诊序号、医院订单号不是泰康申领号，也不是寰宇订单号。若候选订单没有提供与图片编号相同的业务编号字段，就完全忽略该图片编号，不得依据编号格式、数字片段或自行推算的生成时间进行匹配。',
  '只比较输入申领号下给出的全部订单，结合凭证内容、订单服务目的、计划时间、订单进度和沟通时间线。区分不同挂号权益、首次就诊和后续复诊，以及讨论方案和实际办理结果。不得因为医院或科室相同就直接认定为同一单，也不得把一个订单的信息复制到另一个订单。',
  '如果订单证据不足，不要强行选择，保留为该申领号下尚未确定具体订单的凭证。候选订单列表的先后顺序没有业务含义，不得因为排在第一位就选它。输出前逐条核对 orderEvidence 和 reason，删除无法在图片实际内容、候选订单字段或沟通时间线中找到明确依据的说法。判断必须指出对应的图片或业务证据。只返回 JSON：{"orderDecision":"matched|ambiguous","orderId":number|null,"orderEvidence":string[],"alternatives":string[],"reason":string}。申领号和申领号证据由程序沿用会话关联结果，不要在 JSON 中输出 applicationDecision、applicationNo 或 applicationEvidence。'
].join('\n')

function applicationNoOf(row: OrderRow): string | null {
  const value = record(row.rawJson).crmApplyNo
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function fieldValue(fields: NativeImageSummary['visibleFields'], labels: string[]): string | null {
  const normalized = new Set(labels.map((label) => compact(label)))
  for (const field of fields) {
    if (normalized.has(compact(field.label)) && field.value.trim()) return field.value.trim()
  }
  return null
}

function proofFromNativeImage(image: NativeImageSummary): RegistrationProofFields {
  const patientName = fieldValue(image.visibleFields, ['患者姓名', '就诊人', '患者', '姓名'])
  const idCard = fieldValue(image.visibleFields, ['身份证号', '证件号码', '证件号'])
  const phone = fieldValue(image.visibleFields, ['联系电话', '手机号', '手机号码', '电话'])
  const suffix = (value: string | null): string | null => value ? value.replace(/\s/g, '').slice(-1) || null : null
  return {
    isRegistrationProof: true,
    confidence: null,
    proofType: 'native_image',
    patientName,
    patientNameSuffix: suffix(patientName),
    idCardSuffix: idCard ? digits(idCard).slice(-4) || null : null,
    phoneSuffix: phone ? digits(phone).slice(-4) || null : null,
    hospital: fieldValue(image.visibleFields, ['医院', '就诊医院', '医疗机构']),
    department: fieldValue(image.visibleFields, ['科室', '就诊科室']),
    doctor: fieldValue(image.visibleFields, ['医生', '医生姓名', '接诊医生']),
    appointmentDate: fieldValue(image.visibleFields, ['就诊日期', '预约日期', '看诊日期']),
    appointmentTime: fieldValue(image.visibleFields, ['就诊时间', '预约时间', '看诊时间']),
    registrationNumber: fieldValue(image.visibleFields, ['挂号号', '预约号', '就诊号']),
    rawText: image.visibleText,
    evidence: [image.description, ...image.visibleFields.map((field) => `${field.label}：${field.value}`)].filter(Boolean)
  }
}

function parseNativeMatch(
  content: string,
  applications: Set<string>,
  orderIdsByApplication: Map<string, Set<number>>,
  knownApplicationNo: string | null
): Omit<NativeRegistrationMatch, 'candidateApplicationCount' | 'candidateOrderCount'> {
  const parsed = parseJsonObject(content)
  if (knownApplicationNo && !applications.has(knownApplicationNo)) throw new Error('后台已关联申领号不在订单候选范围内')
  const applicationDecision = knownApplicationNo ? 'matched' : parsed.applicationDecision
  if (!knownApplicationNo && !['matched', 'ambiguous', 'no_match'].includes(String(applicationDecision))) throw new Error('订单匹配 AI 返回了无效的 applicationDecision')
  const applicationNo = knownApplicationNo ?? text(parsed.applicationNo)
  if (applicationNo && !applications.has(applicationNo)) throw new Error('订单匹配 AI 返回了候选范围外的申领号')
  if (applicationDecision === 'matched' && !applicationNo) throw new Error('订单匹配 AI 判定申领号 matched，但没有返回申领号')
  if (applicationDecision !== 'matched' && applicationNo) throw new Error('订单匹配 AI 未确定申领号，却返回了申领号')
  const orderDecision = parsed.orderDecision
  if (!['matched', 'ambiguous', 'not_evaluated'].includes(String(orderDecision))) throw new Error('订单匹配 AI 返回了无效的 orderDecision')
  const orderId = typeof parsed.orderId === 'number' && Number.isSafeInteger(parsed.orderId) ? parsed.orderId : null
  if (orderDecision === 'matched' && orderId === null) throw new Error('订单匹配 AI 判定订单 matched，但没有返回订单 ID')
  if (orderDecision !== 'matched' && orderId !== null) throw new Error('订单匹配 AI 未确定订单，却返回了订单 ID')
  if ((applicationDecision !== 'matched' || knownApplicationNo !== null) && orderDecision === 'not_evaluated') {
    throw new Error('申领号尚未确定时，订单匹配结果必须为 not_evaluated')
  }
  if (orderId !== null && (!applicationNo || !orderIdsByApplication.get(applicationNo)?.has(orderId))) {
    throw new Error('订单匹配 AI 返回了当前申领号之外的订单')
  }
  const stringArray = (value: unknown, name: string): string[] => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new Error(`订单匹配 AI 返回的 ${name} 必须是非空字符串数组`)
    }
    return value.map((item) => (item as string).trim())
  }
  return {
    applicationDecision: applicationDecision as 'matched' | 'ambiguous' | 'no_match',
    applicationNo: applicationDecision === 'matched' ? applicationNo : null,
    applicationEvidence: knownApplicationNo ? ['原微信/企微会话已确认关联该申领号'] : stringArray(parsed.applicationEvidence, 'applicationEvidence'),
    orderDecision: orderDecision as 'matched' | 'ambiguous' | 'not_evaluated',
    orderId: orderDecision === 'matched' ? orderId : null,
    orderEvidence: stringArray(parsed.orderEvidence, 'orderEvidence'),
    alternatives: stringArray(parsed.alternatives, 'alternatives'),
    reason: text(parsed.reason) ?? ''
  }
}

/** Match a native-chat registration proof by resolving application scope before selecting one of its orders. */
export async function matchNativeRegistrationProofToOrders(
  prisma: PrismaClient,
  imageDataUrl: string,
  image: NativeImageSummary,
  options: { applicationNo: string | null; conversationId?: number }
): Promise<NativeRegistrationMatch> {
  const orders = await prisma.order.findMany({
    where: options.applicationNo
      ? { rawJson: { path: ['crmApplyNo'], equals: options.applicationNo } }
      : undefined,
    select: {
      id: true, sourceOrderNo: true, customerName: true, customerPhone: true,
      hospital: true, dept: true, doctor: true, status: true,
      assignedEmployeeId: true, rawJson: true, detailJson: true
    }
  }) as OrderRow[]
  const proof = proofFromNativeImage(image)
  const appRows = new Map<string, OrderRow[]>()
  const applicationScores = new Map<string, { score: number; evidence: string[] }>()
  for (const row of orders) {
    const appNo = applicationNoOf(row)
    if (!appNo) continue
    const group = appRows.get(appNo) ?? []
    group.push(row)
    appRows.set(appNo, group)
    // A hospital registration/appointment number is not the insurer's application number.
    // Do not use it to search across application groups; only patient and visit evidence can
    // nominate an application. Once the application is already linked, the search is skipped.
    const matched = matchOrder(row, { ...proof, registrationNumber: null })
    if (matched.score > 0) {
      const prior = applicationScores.get(appNo) ?? { score: 0, evidence: [] }
      prior.score = Math.max(prior.score, matched.score)
      prior.evidence = [...new Set([...prior.evidence, ...matched.matchedFields])]
      applicationScores.set(appNo, prior)
    }
  }

  const candidateApplicationNos = options.applicationNo
    ? [options.applicationNo]
    : [...applicationScores.keys()].sort((a, b) => (applicationScores.get(b)?.score ?? 0) - (applicationScores.get(a)?.score ?? 0) || a.localeCompare(b))
  const candidates = candidateApplicationNos
    .map((applicationNo) => ({
      applicationNo,
      programEvidence: applicationScores.get(applicationNo)?.evidence ?? [],
      orders: (appRows.get(applicationNo) ?? []).map((row) => {
        const candidate = matchOrder(row, { ...proof, registrationNumber: null })
        const extra = orderExtra(row)
        return {
          orderId: row.id,
          sourceOrderNo: row.sourceOrderNo,
          customerName: extra.patientName ?? row.customerName,
          serviceType: firstText(record(row.rawJson).serviceType, record(row.rawJson).service_type, record(row.detailJson).serviceType, record(row.detailJson).service_type),
          hospital: row.hospital,
          department: row.dept,
          doctor: row.doctor,
          appointmentDate: extra.appointmentDate,
          status: row.status,
          programMatchedFields: candidate.matchedFields
        }
      })
    }))
    .filter((candidate) => candidate.orders.length > 0)

  if (candidates.length === 0) {
    return {
      applicationDecision: 'no_match', applicationNo: null, applicationEvidence: [],
      orderDecision: 'not_evaluated', orderId: null, orderEvidence: [], alternatives: [],
      reason: options.applicationNo ? '已关联申领号下未找到订单数据' : '图片可见信息未检索到申领号候选',
      candidateApplicationCount: 0, candidateOrderCount: 0, candidateApplications: []
    }
  }

  const unlinkedConversation = options.conversationId && !options.applicationNo
    ? await prisma.nativeChatMessage.findMany({
        where: { conversationId: options.conversationId },
        include: { conversation: { select: { channel: true } }, attachments: { orderBy: { id: 'asc' } } },
        orderBy: [{ occurredAt: 'asc' }, { sourceItemIndex: 'asc' }, { id: 'asc' }]
      })
    : []
  const communications = await Promise.all(candidateApplicationNos.filter((appNo) => appRows.has(appNo)).map(async (appNo) => {
    const [messages, calls] = await Promise.all([
      prisma.message.findMany({
        where: { applicationNo: appNo, channel: { in: ['wechat', 'wxwork'] } },
        select: { id: true, senderName: true, senderType: true, kind: true, contentText: true, chatTime: true, sortTime: true, capturedAt: true },
        orderBy: [{ sortTime: 'asc' }, { id: 'asc' }]
      }),
      prisma.call.findMany({
        where: { applicationNo: appNo },
        select: { id: true, direction: true, startedAt: true, asrText: true },
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }]
      })
    ])
    const native = await prisma.nativeChatMessage.findMany({
      where: { conversation: { applicationNo: appNo, applicationLinkStatus: 'matched' } },
      include: { conversation: { select: { channel: true } }, attachments: { orderBy: { id: 'asc' } } },
      orderBy: [{ occurredAt: 'asc' }, { sourceItemIndex: 'asc' }, { id: 'asc' }]
    })
    const rows = [
      ...messages.map((m) => ({ time: m.sortTime ?? m.chatTime ?? m.capturedAt, source: '历史消息', sender: m.senderName ?? m.senderType, type: m.kind, content: m.contentText })),
      ...calls.filter((c) => c.asrText?.trim()).map((c) => ({ time: c.startedAt, source: '电话转写', sender: c.direction, type: '通话', content: c.asrText })),
      ...native.map((m) => ({
        time: m.occurredAt,
        source: m.conversation.channel,
        sender: m.senderName ?? m.direction,
        type: m.kind,
        content: [m.text, ...m.attachments.map((attachment) => {
          const metadata = record(attachment.sourceMetadata)
          const analysis = record(metadata.imageAnalysis)
          return analysis?.status === 'completed'
            ? `图片：${String(analysis.imageType ?? '')}；${String(analysis.description ?? '')}；${String(analysis.visibleText ?? '')}`
            : attachment.fileName ? `附件：${attachment.fileName}` : `附件：${attachment.kind}`
        })].filter(Boolean).join('\n')
      })),
      ...unlinkedConversation.map((m) => ({
        time: m.occurredAt,
        source: m.conversation.channel,
        sender: m.senderName ?? m.direction,
        type: m.kind,
        content: [m.text, ...m.attachments.map((attachment) => {
          const metadata = record(attachment.sourceMetadata)
          const analysis = record(metadata.imageAnalysis)
          return analysis?.status === 'completed'
            ? `图片：${String(analysis.imageType ?? '')}；${String(analysis.description ?? '')}；${String(analysis.visibleText ?? '')}`
            : attachment.fileName ? `附件：${attachment.fileName}` : `附件：${attachment.kind}`
        })].filter(Boolean).join('\n')
      }))
    ].sort((a, b) => a.time.getTime() - b.time.getTime())
    return {
      applicationNo: appNo,
      communications: rows.map((row) => ({ ...row, time: businessDateTime(row.time) }))
    }
  }))

  const modelCandidates = candidates.map((candidate) => ({
    applicationNo: candidate.applicationNo,
    programEvidence: candidate.programEvidence,
    orders: candidate.orders.map((order) => ({
      orderId: order.orderId,
      customerName: order.customerName,
      serviceType: order.serviceType,
      hospital: order.hospital,
      department: order.department,
      doctor: order.doctor,
      appointmentDate: order.appointmentDate,
      status: order.status,
      programMatchedFields: order.programMatchedFields
    }))
  }))
  const userPrompt = [
    `挂号凭证图片识别结果：${JSON.stringify(image)}`,
    `程序检索到的申领号及其全部订单：${JSON.stringify(modelCandidates)}`,
    `这些申领号的相关沟通时间线：${JSON.stringify(communications)}`
  ].join('\n\n')
  const response = await visionChat(
    options.applicationNo ? NATIVE_LINKED_APPLICATION_ORDER_PROMPT : NATIVE_APPLICATION_ORDER_PROMPT,
    userPrompt,
    imageDataUrl,
    { temperature: 0 }
  )
  const orderIdsByApplication = new Map(candidates.map((candidate) => [candidate.applicationNo, new Set(candidate.orders.map((order) => order.orderId))]))
  const parsed = parseNativeMatch(
    response.content,
    new Set(candidates.map((candidate) => candidate.applicationNo)),
    orderIdsByApplication,
    options.applicationNo
  )
  return {
    ...parsed,
    candidateApplicationCount: candidates.length,
    candidateOrderCount: candidates.reduce((total, candidate) => total + candidate.orders.length, 0),
    candidateApplications: candidates
  }
}
