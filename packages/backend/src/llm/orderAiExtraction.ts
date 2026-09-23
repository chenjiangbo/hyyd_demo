import { chat } from './gatewayClient.js'
import { WORKFLOW_EVENT_CODES, type WorkflowAnalysisEvent } from './orderBriefService.js'

export const ORDER_AI_FIELD_PROMPT_VERSION = 'order-fields-v1'

export type OrderAiSourceMessage = {
  id: number
  channel: string
  senderName: string | null
  contentText: string
  occurredAt: Date
}

export type OrderAiSourceCall = {
  id: number
  direction: string
  asrText: string | null
  startedAt: Date
}

export type OrderAiFieldCandidate = {
  fieldCode: string
  fieldLabel: string
  value: string
  normalizedValue: unknown
  candidateType: 'new_or_confirmed' | 'change_candidate' | 'ambiguous'
  confidence: number
  requiresConfirmation: boolean
  evidence: Array<{ sourceId: string; quote: string }>
}

export type OrderAiExtraction = {
  candidates: OrderAiFieldCandidate[]
  workflowEvents: WorkflowAnalysisEvent[]
  model: string
  raw: string
}

export type OrderAiFieldDefinition = {
  code: string
  label: string
  services?: readonly string[]
  requiresConfirmation?: boolean
}

// 管理后台“订单 AI 分析配置”页与实际模型调用共用这份白名单，避免说明与执行逻辑漂移。
export const ORDER_AI_FIELD_DEFINITIONS: readonly OrderAiFieldDefinition[] = [
// 只保留“服务执行过程中才产生或需要确认”的字段。泰康已同步的人员、订单、
// 套餐、初始意向等基础资料不在这里；若沟通明确说变更，才以 change_candidate 返回。
  { code: 'hospital', label: '最终确认医院' },
  { code: 'hospital_address', label: '医院地址/院区/候诊地址' },
  { code: 'department', label: '最终确认科室' },
  { code: 'doctor', label: '最终确认医生' },
  { code: 'expert_level', label: '医生职称/专家级别' },
  { code: 'service_remark', label: '订单服务备注/注意事项' },
  { code: 'request_time', label: '需求时间（初次联系客户时间，无论接通与否）' },
  { code: 'response_time', label: '应答时间（与需求时间一致）' },
  { code: 'service_start_time', label: '启动服务时间（首次推荐医生或介入服务时间）' },
  { code: 'appointment_success_time', label: '预约反馈时间（挂号/预约成功后通知客户时间）' },
  { code: 'latest_ticket_time', label: '最晚取号时间（挂号单取号时间/就诊时段）', services: ['全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '挂号协助'] },
  { code: 'escort_service_date', label: '陪诊服务日期（挂号单看诊日期）', services: ['全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '检查加急', '住院'] },
  { code: 'registration_fee_amount', label: '挂号费金额', requiresConfirmation: true, services: ['全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '挂号协助'] },
  { code: 'escort_name', label: '陪诊人员姓名', services: ['全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '检查加急', '住院'] },
  { code: 'escort_phone', label: '陪诊联系电话', services: ['全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '检查加急', '住院'] },
  { code: 'escort_service_summary', label: '陪诊服务小结', services: ['全流程', '全程门诊', '单次门诊', '电话问诊', 'MDT服务', '检查加急', '住院'] },
  { code: 'inspection_item', label: '检查项目', services: ['检查加急'] },
  { code: 'inspection_booking_time', label: '检查预约时间', services: ['检查加急'] },
  { code: 'inspection_actual_time', label: '实际检查时间', services: ['检查加急'] },
  { code: 'inspection_location', label: '检查地点/候诊地址', services: ['检查加急'] },
  { code: 'inspection_notes', label: '检查注意事项/备注', services: ['检查加急'] },
  { code: 'hospitalization_appointment_time', label: '约住院时间', services: ['住院', '全流程'] },
  { code: 'admission_no', label: '住院单号', services: ['住院', '全流程'] },
  { code: 'actual_admission_time', label: '实际住院时间', services: ['住院', '全流程'] },
  { code: 'discharge_time', label: '出院时间', services: ['住院', '全流程'] },
  { code: 'admission_type', label: '住院类型', services: ['住院', '全流程'] },
  { code: 'diagnosis_result', label: '诊断结论', services: ['住院', '全流程'], requiresConfirmation: true },
  { code: 'icd10_code', label: 'ICD10编码', services: ['住院', '全流程'], requiresConfirmation: true },
  { code: 'admission_summary', label: '住院总结', services: ['住院', '全流程'] },
  { code: 'caregiver_start_time', label: '预计护工开启时间', services: ['住院护工协助'] },
  { code: 'caregiver_service_period', label: '护工服务起止时间', services: ['住院护工协助'] },
  { code: 'caregiver_feedback', label: '护工服务反馈', services: ['住院护工协助'] },
  { code: 'transport_origin', label: '接送出发地', services: ['就医接送'] },
  { code: 'transport_destination', label: '接送目的地', services: ['就医接送'] },
  { code: 'transport_service_time', label: '接送实际服务时间', services: ['就医接送'] },
  { code: 'transport_mode', label: '接送交通工具/车型', services: ['就医接送'] },
  { code: 'transport_summary', label: '接送服务备注', services: ['就医接送'] },
  { code: 'mdt_diagnosis', label: '疾病诊断', services: ['MDT服务'], requiresConfirmation: true },
  { code: 'mdt_disease_summary', label: '疾病简介', services: ['MDT服务'] },
  { code: 'mdt_expert_advice', label: '专家咨询建议', services: ['MDT服务'] },
  { code: 'revisit_time', label: '复诊时间', services: ['全程门诊', '全流程'] }
]

export const ORDER_AI_PROMPT_RULES = [
  '你是医疗服务订单的结构化业务执行信息提取助手。',
  '沟通记录按申请号采集，但本次只能分析指定的一张订单；绝不把另一服务订单的信息写入本订单。',
  '订单基础资料已由泰康同步，不重复提取姓名、证件、联系人、套餐、订单号、初始就医意向或内部人员。',
  '只提取沟通后新增、变更或明确确认的服务执行信息，且只能返回给定字段白名单中的 field_code。',
  '【时间字段业务提取准则】：',
  '1. 需求时间(request_time)：服务人员初次联系客户的时间（企微首条发送消息或首次拨打电话的时间点，无论是否接通成功）。',
  '2. 应答时间(response_time)：与 request_time 完全保持一致。',
  '3. 启动服务时间(service_start_time)：企微或电话中，服务人员首次给客户推荐医生、医院方案或正式展开具体服务介入的时间点。',
  '4. 预约反馈时间(appointment_success_time)：挂号或预约成功后，服务人员在企微/短信/电话中向客户发送预约结果通知/挂号截图/就诊确认的时间点。',
  '5. 最晚取号时间(latest_ticket_time)：挂号单/预约凭证上载明的最晚取号时间或预约看诊时段起始时间（格式 YYYY-MM-DD HH:mm:ss）。',
  '6. 陪诊服务日期(escort_service_date)：挂号单/预约凭证上确定的看诊/陪诊日期（格式 YYYY-MM-DD）。',
  '【陪诊人员信息提取与渠道优先级准则（企微 > 微信）】：',
  '1. 渠道优先级铁律：若在【企业微信（企微 / wxwork）】消息中识别/派发了陪诊人员（escort_name、escort_phone），必须 100% 优先以企微中的陪诊人员信息为准（企微为官方正式协同调度渠道，具有最高权威性，直接覆盖微信中可能存在的旧/初版陪诊人）。',
  '2. 微信兜底：只有当【企业微信消息中未提及/未分配陪诊人】时，才以【微信（wechat）】派单模板中明确载明的陪诊人和电话为准。',
  '3. 若沟通记录中出现了包含“渠道/订单号/就诊人/陪诊人/陪诊人电话”的标准派单/预约通知模板卡片，按上述渠道优先级提取，escort_name 与 escort_phone 置信度设为高（confidence >= 0.95），并引用对应渠道的派单消息作为证据。',
  '4. 若在通话录音或其他非正式聊天中口头提及过其他陪诊人，一律以企微（或微信兜底）的正式派单模板为准覆盖。',
  '“计划、想约、正在约、可能”不是完成；只有明确已挂号、预约成功、已检查、已住院、已出院、已陪诊、已复诊等事实才可输出步骤事件。',
  '若信息不能确定属于当前服务类型，返回 ambiguous 字段候选且 requires_confirmation=true；不得输出自动流转事件。',
  '金额、诊断、ICD10 必须 requires_confirmation=true。',
  '【医院、科室、医生提取与缺失规范（极其重要）】：',
  '1. 缺失与未定信息全量置空原则：若沟通记录中未提及、或者处于“未定、待商量、不知道去哪、不确定挂哪个、随便哪个医生都行”等状态，绝不要生成该字段候选！严禁输出任何“未明确”、“未知”、“暂无”、“待定”、“无”、“待确认”、“不详”、“/”等占位词。',
  '2. 最终确认医院(hospital)：必须结合就医城市与上下文，直接输出在中国国家卫健委官方注册挂牌的标准官方全称（例：客户说“北京协和/协和医院”，必须规范输出为“中国医学科学院北京协和医院”；说“北医三院”，输出为“北京大学第三医院”；说“宣武医院”，输出为“首都医科大学宣武医院”；说“301医院”，输出为“中国人民解放军总医院”）。绝对不得输出口语简称或未带官方前缀的简写。',
  '3. 最终确认科室(department)：必须输出正规医学临床二级学科名称（例：“心内”输出为“心血管内科”；“消化”输出为“消化内科”；“皮科”输出为“皮肤科”）。若仅提及“大夫科室”或不明确具体专科，严禁输出，保持不提取。',
  '4. 最终确认医生(doctor)：仅提取医生的纯真实姓名（包括普通中文名、少数民族多字或带间隔号姓名如“买买提·艾力”、以及外籍/合资医院的外文名如“Smith”或“大卫”等），自动剥离前缀后缀称谓（如“李医生/张主任/王大夫”只提取“李XX”、“张XX”）。未明确具体医生姓名时（如仅提及“找专家挂号”），严禁输出“专家”、“主任”或“未明确”，医生字段必须保持不提取。',
  '5. 医生多点执业/外院坐诊地点锚定：若专家来自外院但本次在另一家医院特需坐诊（如“协和张主任在天坛普华医院坐诊”），【最终确认医院(hospital)】必须提取本次实际就诊履约的物理医院（如“北京天坛普华医院”），绝不得填错为专家的原编制医院；医生提取真实姓名，并在【服务备注(service_remark)】中载明坐诊背景。',
  '6. 专家级别(expert_level)是医生的档案属性由医生主档联动带出，若已有明确具体医生，不要单独提取专家级别；仅未提及具体医生时才可提取标准枚举之一（知名专家、主任医师、副主任医师、主治医师、住院医师），绝不得包含“教授/博士”等非标教学称谓。',
  '日期能精确时输出 YYYY-MM-DD HH:mm:ss；不能精确时保留原文，不要编造。没有明确值的字段不要输出。',
  '每个候选都必须引用消息#ID或通话#ID及其原文短句；只输出合法 JSON。',
  '【时区基准】：沟通时间线中的所有消息和通话时间均为中国东八区北京时间，提取的时间字段务必保持一致。'
] as const

export const ORDER_AI_PROMPT_INPUTS = [
  '当前订单：订单 ID、申请号、服务类型',
  '本单允许提取字段：由服务类型匹配后的字段白名单',
  '当前已保存正式值：仅用于判断变更，模型不得照搬',
  '申请号下沟通时间线：企微消息、微信消息、已完成转写的通话录音'
] as const

export const ORDER_AI_OUTPUT_DESCRIPTION = {
  candidate: 'field_candidates：字段编码、候选值、标准化值、候选类型、置信度、是否需要人工确认、消息/通话证据。',
  event: `workflow_events：仅在沟通明确证明完成或确认时输出，事件编码限定为 ${WORKFLOW_EVENT_CODES.join('、')}。`
} as const

function fieldsFor(serviceType: string): readonly OrderAiFieldDefinition[] {
  return ORDER_AI_FIELD_DEFINITIONS.filter((field) => !field.services || field.services.includes(serviceType))
}

function fmt(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  // 显式锁定中国东八区（UTC+8），保证无论运行环境为何时区输出皆一致
  const b = new Date(date.getTime() + 8 * 3600 * 1000)
  return `${b.getUTCFullYear()}-${pad(b.getUTCMonth() + 1)}-${pad(b.getUTCDate())} ${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}`
}

function timeline(messages: OrderAiSourceMessage[], calls: OrderAiSourceCall[]): string {
  const entries = [
    ...messages.map((m) => ({ at: m.occurredAt, line: `[消息#${m.id} ${fmt(m.occurredAt)} ${m.channel}/${m.senderName || '未知'}] ${m.contentText.replace(/\s+/g, ' ').trim()}` })),
    ...calls.filter((c) => (c.asrText ?? '').trim()).map((c) => ({ at: c.startedAt, line: `[通话#${c.id} ${fmt(c.startedAt)} ${c.direction === 'out' ? '去电' : '来电'}] ${(c.asrText ?? '').replace(/\s+/g, ' ').trim()}` }))
  ].filter((item) => item.line.trim())
  entries.sort((a, b) => a.at.getTime() - b.at.getTime())
  return entries.map((item) => item.line).join('\n')
}

function parseObject(content: string): Record<string, unknown> {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  try { return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown> } catch { return {} }
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function normalizeCandidates(raw: unknown, allowed: Map<string, OrderAiFieldDefinition>): OrderAiFieldCandidate[] {
  if (!Array.isArray(raw)) return []
  const latest = new Map<string, OrderAiFieldCandidate>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const fieldCode = stringValue(record.field_code)
    const definition = fieldCode ? allowed.get(fieldCode) : null
    const value = stringValue(record.value)
    if (!definition || !value) continue
    // 拦截任何占位废词，严禁进入候选池与下游业务流程
    if (/^(未明确|未知|暂无|无|待定|待确认|不详|空|none|null|undefined|\/|-)$/i.test(value.trim())) {
      continue
    }
    const candidateType = record.candidate_type === 'change_candidate' || record.candidate_type === 'ambiguous'
      ? record.candidate_type
      : 'new_or_confirmed'
    const parsedConfidence = Number(record.confidence)
    const confidence = Number.isFinite(parsedConfidence) ? Math.max(0, Math.min(1, parsedConfidence)) : 0
    const evidence = Array.isArray(record.evidence)
      ? record.evidence.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return []
          const source = entry as Record<string, unknown>
          const sourceId = stringValue(source.source_id)
          const quote = stringValue(source.quote)
          return sourceId && quote ? [{ sourceId, quote: quote.slice(0, 500) }] : []
        }).slice(0, 5)
      : []
    if (evidence.length === 0) continue
    latest.set(fieldCode!, {
      fieldCode: fieldCode!,
      fieldLabel: definition.label,
      value: value.slice(0, 2000),
      normalizedValue: record.normalized_value ?? value,
      candidateType,
      confidence,
      requiresConfirmation: definition.requiresConfirmation || record.requires_confirmation === true || candidateType !== 'new_or_confirmed',
      evidence
    })
  }
  return [...latest.values()]
}

function normalizeEvents(raw: unknown): WorkflowAnalysisEvent[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const value = item as Record<string, unknown>
    const code = stringValue(value.code)
    const evidence = stringValue(value.evidence)
    return code && evidence && (WORKFLOW_EVENT_CODES as readonly string[]).includes(code)
      ? [{ code: code as WorkflowAnalysisEvent['code'], evidence: evidence.slice(0, 1000) }]
      : []
  })
}

export async function extractOrderServiceFields(input: {
  orderId: number
  applicationNo: string | null
  serviceType: string
  currentValues: Record<string, unknown>
  messages: OrderAiSourceMessage[]
  calls: OrderAiSourceCall[]
}): Promise<OrderAiExtraction> {
  const allowedFields = fieldsFor(input.serviceType)
  const allowedMap = new Map(allowedFields.map((field) => [field.code, field]))
  const sourceTimeline = timeline(input.messages, input.calls)
  const system = [
    ...ORDER_AI_PROMPT_RULES,
    'JSON 格式：',
    JSON.stringify({
      field_candidates: [{ field_code: '白名单字段', value: '候选值', normalized_value: '可选标准化值', candidate_type: 'new_or_confirmed | change_candidate | ambiguous', confidence: 0.0, requires_confirmation: false, evidence: [{ source_id: '消息#123 或 通话#456', quote: '原文短句' }] }],
      workflow_events: [{ code: WORKFLOW_EVENT_CODES.join(' | '), evidence: '明确完成或确认的原文事实' }]
    })
  ].join('\n')
  const user = [
    `【当前订单】订单ID=${input.orderId}；申请号=${input.applicationNo || '无'}；服务类型=${input.serviceType}`,
    `【本单允许提取字段】${allowedFields.map((field) => `${field.code}（${field.label}）`).join('；')}`,
    `【当前已保存正式值，仅用于判断变更，不得照搬】${JSON.stringify(input.currentValues)}`,
    `【申请号下沟通时间线】\n${sourceTimeline || '（无可分析的企微、微信或已转写通话）'}`
  ].join('\n\n')
  const result = await chat([{ role: 'system', content: system }, { role: 'user', content: user }], { temperature: 0, maxTokens: 2600 })
  const parsed = parseObject(result.content)
  return {
    candidates: normalizeCandidates(parsed.field_candidates, allowedMap),
    workflowEvents: normalizeEvents(parsed.workflow_events),
    model: result.model,
    raw: result.content
  }
}
