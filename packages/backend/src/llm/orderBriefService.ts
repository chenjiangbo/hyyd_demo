/**
 * 订单 AI 滚动简报（一次调用，两目的兼得）：
 *   - 给员工：summary 现状 / stage 阶段 / nextActions 待办 / risks 风险 / hasOpenIssue
 *   - 给系统：keyInfo 回填关键信息（占位字段，真实字段以后按泰康/寰宇 ABI 回填接口对齐）
 *
 * 输入综合 **微信/企微消息 + 通话记录 + 录音转写**，按时间排成一条线喂给 LLM。
 * 增量（滚动）：喂"上一版简报 + 水位之后的新内容"，AI 基于旧简报更新，省 token、自带记忆。
 * 铁律：LLM 只在后端调（复用 gatewayClient/百炼），说话人/结构化已在上游做好，这里只做文本理解。
 *
 * 设计详见 docs/设计_订单AI滚动简报.md。
 */
import { chat } from './gatewayClient.js'

// 跨所有绿通业务通用的粗粒度阶段（住院/护工/检查/门诊/接送/挂号/会诊…通用）
export const BRIEF_STAGES = [
  '待跟进',
  '沟通中',
  '办理中',
  '已安排已通知',
  '服务执行中',
  '已完成'
] as const
export type BriefStage = (typeof BRIEF_STAGES)[number]

// 回填关键信息字段（占位，业务通用集；真实字段以后按 ABI 回填接口对齐）
export const BRIEF_KEY_INFO_FIELDS = [
  '目标医院',
  '科室或病种',
  '意向专家',
  '期望时间',
  '客户诉求',
  '服务具体需求',
  '病情或资料补充',
  '特殊要求',
  '沟通偏好'
] as const

export interface BriefMessageInput {
  channel: string // wechat / wxwork
  senderName?: string | null
  contentText: string
  capturedAt: Date
}
export interface BriefCallInput {
  direction: string // in / out
  callStatus?: string | null
  durationSec?: number | null
  asrText?: string | null
  startedAt: Date
}
// 手工补录素材：专员粘贴/手输的过程数据。它代表无感采集的遗漏，价值高，要纳入。
// 图片素材的文字由 VLM 识图(分类+OCR)后填到 textContent，imageKind 是类型(聊天截图/单据/短信…)。
export interface BriefMaterialInput {
  type: string // 'text' | 'image'
  textContent?: string | null
  imageKind?: string | null
  createdAt: Date
}
export interface BriefContext {
  customerName?: string | null
  serviceType?: string | null // 业务类型：住院/护工/检查加急/门诊/接送/挂号/会诊…
  itemName?: string | null
  hospital?: string | null
  dept?: string | null
  doctor?: string | null
  status?: string | null
}

export interface OrderBrief {
  summary: string | null
  stage: BriefStage | null
  stageEvidence: string | null
  hasOpenIssue: boolean
  nextActions: string[]
  risks: string[]
  keyInfo: Record<string, string | null>
}

export interface OrderBriefResult extends OrderBrief {
  model: string
  raw: string
}

interface TimelineItem {
  at: Date
  line: string
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
function fmt(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 把新增消息 + 通话 + 手工补录合并成一条按时间排序的"带角色 + 时间"文本时间线 */
function buildTimeline(
  messages: BriefMessageInput[],
  calls: BriefCallInput[],
  materials: BriefMaterialInput[]
): string {
  const items: TimelineItem[] = []
  for (const m of messages) {
    const text = (m.contentText || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const who = m.senderName?.trim() || '消息'
    items.push({ at: m.capturedAt, line: `[${fmt(m.capturedAt)} ${who}] ${text}` })
  }
  for (const c of calls) {
    const dir = c.direction === 'out' ? '去电' : '来电'
    const dur = c.durationSec ? `时长${c.durationSec}秒` : ''
    const asr = (c.asrText || '').replace(/\s+/g, ' ').trim()
    const body = asr ? `转写：${asr}` : `（${c.callStatus || '无转写'}）`
    items.push({ at: c.startedAt, line: `[${fmt(c.startedAt)} ${dir} ${dur}] ${body}` })
  }
  for (const mat of materials) {
    const text = (mat.textContent || '').replace(/\s+/g, ' ').trim()
    // 手工补录是专员主动记录的关键信息（补无感采集之漏），权重高。
    // 图片已由 VLM 识图：textContent=提取的文字，imageKind=类型；无文字则标注存在。
    let body: string
    if (mat.type === 'image') {
      const kind = mat.imageKind || '图片'
      body = text ? `（${kind}）${text}` : `[手工补录${kind}，无可提取文字]`
    } else {
      body = text
    }
    if (!body) continue
    items.push({ at: mat.createdAt, line: `[${fmt(mat.createdAt)} 专员手工补录] ${body}` })
  }
  items.sort((a, b) => a.at.getTime() - b.at.getTime())
  return items.map((i) => i.line).join('\n')
}

function buildSchema(): string {
  return JSON.stringify({
    summary: '一句话现状',
    stage: BRIEF_STAGES.join(' | '),
    stageEvidence: '判此阶段的依据',
    hasOpenIssue: 'true/false：客户是否有未解决的问题',
    nextActions: ['下一步待办'],
    risks: ['风险/需关注，无则空数组'],
    keyInfo: Object.fromEntries(BRIEF_KEY_INFO_FIELDS.map((k) => [k, '值或null']))
  })
}

export async function buildOrderBrief(
  context: BriefContext,
  prevBrief: OrderBrief | null,
  newMessages: BriefMessageInput[],
  newCalls: BriefCallInput[],
  newMaterials: BriefMaterialInput[] = []
): Promise<OrderBriefResult> {
  const timeline = buildTimeline(newMessages, newCalls, newMaterials)

  const ctxLine =
    `客户=${context.customerName ?? '?'}，业务类型=${context.serviceType ?? context.itemName ?? '?'}，` +
    `医院=${context.hospital ?? '?'}，科室=${context.dept ?? '?'}，医生=${context.doctor ?? '?'}，当前状态=${context.status ?? '?'}`

  const system = [
    '你是寰宇医疗绿色通道服务的"订单助理"。下面是某订单的服务专员与客户之间的沟通记录，',
    '来自四个来源：微信/企业微信消息、电话通话记录、通话录音的转写文字，以及"专员手工补录"。',
    '其中"专员手工补录"是专员主动记录的关键信息（补无感采集之漏），可信度高，请重点采纳。',
    '注意：',
    '- 文字来自屏幕 OCR 和语音转写，可能有错别字或个别识别错误，请按语义合理理解，不要被个别错字带偏。',
    '- 通话里 [去电]/[来电] 表示方向，转写文字未必分得清谁说的，按上下文判断。',
    '- 绿通业务类型很多（住院/护工/检查加急/门诊/接送/挂号/会诊…），请结合"业务类型"理解阶段，',
    '  例如"办理中"对挂号=约号、对护工=派护工、对接送=排车。',
    '你的任务：基于"上一版简报"和"本次新增的沟通"，更新这份订单简报，产出一个 JSON。',
    '要求：',
    '- 只输出一个 JSON 对象，不要解释、不要 Markdown、不要代码块标记。',
    '- 给员工的部分(summary/stage/nextActions/risks)要具体、可执行，用中文短句。',
    `- stage 只能取下面之一：${BRIEF_STAGES.join(' / ')}。`,
    '- hasOpenIssue：客户有未解决的问题/异议/投诉=true，否则 false。',
    `- keyInfo 的键固定如下，没有的填 null，绝不编造：${BRIEF_KEY_INFO_FIELDS.join(' / ')}。`,
    '- 增量更新：保留上一版里已确认的信息，只在有新证据时修正或补充；不要无依据地清空已知字段。',
    'JSON 结构如下（键固定）：',
    buildSchema()
  ].join('\n')

  const user =
    `【已知订单信息（参考，不要照搬）】${ctxLine}\n\n` +
    `【上一版简报（首次为空）】\n${prevBrief ? JSON.stringify(prevBrief, null, 2) : '（无）'}\n\n` +
    `【本次新增沟通（按时间先后）】\n${timeline || '（无新增）'}`

  const result = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    { temperature: 0 }
  )

  const parsed = parseLenient(result.content)
  return { ...normalizeBrief(parsed, prevBrief), model: result.model, raw: result.content }
}

function normalizeBrief(parsed: Record<string, unknown> | null, prev: OrderBrief | null): OrderBrief {
  const p = parsed ?? {}
  const stageRaw = typeof p.stage === 'string' ? p.stage.trim() : null
  const stage = (BRIEF_STAGES as readonly string[]).includes(stageRaw ?? '')
    ? (stageRaw as BriefStage)
    : (prev?.stage ?? null)

  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []

  const keyInfo: Record<string, string | null> = {}
  const pk = (p.keyInfo ?? {}) as Record<string, unknown>
  for (const k of BRIEF_KEY_INFO_FIELDS) {
    const v = pk[k]
    const cur = typeof v === 'string' && v.trim() && v.trim() !== 'null' ? v.trim() : null
    // 增量合并：本轮没给值时，保留上一版已确认的（不无依据清空）
    keyInfo[k] = cur ?? prev?.keyInfo?.[k] ?? null
  }

  return {
    summary: typeof p.summary === 'string' ? p.summary.trim() : (prev?.summary ?? null),
    stage,
    stageEvidence: typeof p.stageEvidence === 'string' ? p.stageEvidence.trim() : null,
    hasOpenIssue: typeof p.hasOpenIssue === 'boolean' ? p.hasOpenIssue : !!prev?.hasOpenIssue,
    nextActions: strArr(p.nextActions),
    risks: strArr(p.risks),
    keyInfo
  }
}

// 容错解析：去 ```fence```，截第一个 { 到最后一个 }
function parseLenient(content: string): Record<string, unknown> | null {
  if (!content) return null
  let s = content.trim()
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}
