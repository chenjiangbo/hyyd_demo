import type { PrismaClient } from '@prisma/client'
import { ORDER_AI_FIELD_DEFINITIONS } from '../llm/orderAiExtraction.js'
import { DEFAULT_WORKFLOW_TEMPLATES } from '../workflow/defaultWorkflowConfig.js'

const SETTING_KEY = 'order_ai_skill_config'
const MAX_ENTRY_LENGTH = 20_000
const WORKFLOW_TEMPLATES = DEFAULT_WORKFLOW_TEMPLATES
const TASK_SKILLS = [
  { code: 'field_extraction', label: '字段提取' },
  { code: 'order_attribution', label: '订单归属' },
  { code: 'workflow_events', label: '服务事件' }
] as const

// 首次打开配置页时，将当前运行提示词中的归属和事件规则作为可编辑初始内容展示。
const INITIAL_TASK_SKILL_ENTRIES: SkillEntries = {
  'task_skill:order_attribution': [
    '沟通素材按申领号汇集。同一申领号下可能有多个 B 端订单，每个 B 端订单又可能关联多个寰宇服务单。申领号用于汇集沟通，不是最终字段或服务事件的归属目标。',
    '按完整沟通时间线理解每段对话，为每条字段候选和服务事件分别判断对应的寰宇服务单。每条输出都必须填写 huanyu_order_no，且只能从本次输入提供的寰宇服务单候选中选择；禁止编造单号或把不同服务单的信息串用。',
    '结合输入提供的订单日期、服务类型、初诊或复诊表达及前后沟通内容判断归属。微信/企微消息的发生时间、消息方向、标准化类型和原始类型码均是判断依据；消息方向未知时不得推断发送方。通话内容按其发生时间与消息共同判断。',
    '订单基础资料已由泰康同步。不要把客户姓名、证件、联系人、套餐、订单号、初始就医意向或内部人员当作沟通中新产生的字段重复提取。',
    '若证据不足以确定某条事实属于哪个寰宇服务单，不要猜测归属，也不要输出该字段候选或服务事件。每条结果须保留对应消息或通话的来源 ID 作为依据。'
  ].join('\n\n'),
  'task_skill:workflow_events': [
    '只识别沟通中已经发生或双方已经明确确认的业务事实。计划、意向、询价、正在办理、想预约、可能发生等内容不能作为已完成事件。事件必须归属到本次输入候选中的准确寰宇服务单，并输出 huanyu_order_no、code 和 evidence。',
    '事件 code 只能使用以下枚举：initial_contact_completed、pre_visit_plan_completed、registration_completed、escort_completed、check_confirmed、check_booking_completed、check_companion_completed、hospital_confirmed、hospital_followup_started、hospital_booking_completed、hospital_admitted、hospital_care_requested、care_worker_started、care_worker_end_confirmed、hospital_care_completed、hospital_companion_completed、revisit_confirmed、revisit_completed、revisit_escort_completed、service_cancelled。不得编造其他事件代码。',
    '只有明确证据表明初次有效沟通、方案确认、挂号成功、检查预约或完成、住院或出院、陪诊或复诊等事实已发生或已确认时，才输出对应事件。单纯通知、未接通呼叫、讨论备选方案、尚未落实的安排，不代表相应服务事件已完成。',
    'service_cancelled 必须有双方明确达成一致取消就医服务、退单或终止服务的证据。客户提出取消后还须有服务人员回应确认，或通话中双方明确达成取消一致。犹豫、假设、暂缓商量、改期、单次退号或挂号失败后继续沟通其他方案，都不能判为整单取消。取消事件的 evidence 必须指出具体消息/通话来源 ID，并简述明确取消事实。',
    '如果无法确认事件属于哪个服务类型或具体服务单，不输出 workflow_events；不得用待确认的字段候选替代事件，也不得据此推进流程。没有明确完成或确认事实时返回空事件列表。',
    '输出结构：workflow_events 为数组，每项包含 huanyu_order_no（候选寰宇服务单号）、code（上述枚举之一）、evidence（支持该事件的明确事实及来源依据）。'
  ].join('\n\n')
}

export type SkillEntries = Record<string, string>

type SkillState = { entries: SkillEntries; skillPromptsSeeded?: boolean; versions?: unknown }
const DEFAULT_STATE: SkillState = { entries: {}, skillPromptsSeeded: false }

function parseEntries(value: unknown): SkillEntries {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI Skill 配置内容格式错误')
  const result: SkillEntries = {}
  for (const [key, content] of Object.entries(value)) {
    if (typeof content !== 'string') throw new Error(`AI Skill 配置项格式错误：${key}`)
    result[key] = content
  }
  return result
}

function parseState(value: unknown): SkillState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI Skill 配置数据格式错误')
  const state = value as Record<string, unknown>
  // 兼容页面简化前保存的草稿内容，读取后由下一次保存迁移为单份配置。
  return {
    entries: parseEntries(state.entries ?? state.draft ?? {}),
    skillPromptsSeeded: state.skillPromptsSeeded === true,
    ...(Array.isArray(state.versions) ? { versions: state.versions } : {})
  }
}

function validEntry(scope: unknown, key: unknown): boolean {
  if (typeof key !== 'string' || !key.trim()) return false
  switch (scope) {
    case 'common': return key === 'overview' || key === 'common'
    case 'service_type': return WORKFLOW_TEMPLATES.some((item) => item.serviceType === key)
    case 'step': return WORKFLOW_TEMPLATES.some((item) => item.steps.some((step) => step.code !== 'end' && step.code === key))
    case 'field': return ORDER_AI_FIELD_DEFINITIONS.some((field) => field.code === key)
    case 'task_skill': return TASK_SKILLS.some((skill) => skill.code === key)
    default: return false
  }
}

function validateEntries(input: unknown): SkillEntries {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置内容格式错误')
  const entries: SkillEntries = {}
  for (const [entryKey, content] of Object.entries(input)) {
    const separator = entryKey.indexOf(':')
    const scope = entryKey.slice(0, separator)
    const key = entryKey.slice(separator + 1)
    if (separator < 1 || !validEntry(scope, key)) throw new Error(`配置范围或条目无效：${entryKey}`)
    if (typeof content !== 'string') throw new Error(`业务说明必须是文本：${entryKey}`)
    if (content.length > MAX_ENTRY_LENGTH) throw new Error(`单条业务说明不能超过 ${MAX_ENTRY_LENGTH} 个字符：${entryKey}`)
    if (content.trim()) entries[entryKey] = content
  }
  return entries
}

async function readState(prisma: PrismaClient): Promise<SkillState> {
  const rows = await prisma.$queryRaw<Array<{ value: unknown }>>`
    SELECT value FROM sys_settings WHERE key = ${SETTING_KEY}
  `
  return rows.length ? parseState(rows[0].value) : { entries: {} }
}

export function skillDictionaries() {
  return {
    serviceTypes: WORKFLOW_TEMPLATES.map((item) => ({
      value: item.serviceType,
      label: item.serviceType,
      steps: item.steps.filter((step) => step.code !== 'end').map((step) => ({ code: step.code, name: step.name }))
    })),
    fields: ORDER_AI_FIELD_DEFINITIONS.map((field) => ({
      code: field.code,
      label: field.label,
      system: field.system ?? 'ABI',
      serviceTypes: field.services ? [...field.services] : WORKFLOW_TEMPLATES.map((item) => item.serviceType)
    })),
    taskSkills: TASK_SKILLS.map((skill) => ({ ...skill }))
  }
}

export async function getOrderAiSkillConfig(prisma: PrismaClient) {
  const state = await readState(prisma)
  const entries = state.skillPromptsSeeded
    ? state.entries
    : { ...INITIAL_TASK_SKILL_ENTRIES, ...state.entries }
  return { entries, ...skillDictionaries() }
}

export async function saveOrderAiSkillConfig(prisma: PrismaClient, input: unknown) {
  const entries = validateEntries(input)
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO sys_settings (key, value, updated_at)
      VALUES (${SETTING_KEY}, ${JSON.stringify(DEFAULT_STATE)}::jsonb, NOW())
      ON CONFLICT (key) DO NOTHING
    `
    const rows = await tx.$queryRaw<Array<{ value: unknown }>>`
      SELECT value FROM sys_settings WHERE key = ${SETTING_KEY} FOR UPDATE
    `
    const previous = rows.length ? parseState(rows[0].value) : DEFAULT_STATE
    await tx.$executeRaw`
      UPDATE sys_settings SET value = ${JSON.stringify({ ...previous, entries, skillPromptsSeeded: true })}::jsonb, updated_at = NOW()
      WHERE key = ${SETTING_KEY}
    `
  })
  return entries
}

