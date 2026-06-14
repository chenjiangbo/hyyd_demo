/**
 * 关键信息抽取（路线1 的 AI 环节）：输入"带说话人的对话文本"，让文本 LLM 抽出
 * "可回填到工单系统"的关键字段。**不是 VLM**——说话人已由 sidecar 用 OCR+颜色确定性判好，
 * 这里只做文本抽取（LLM 最擅长的）。调用方=后端（铁律：LLM 调用只在后端，不在 tray/sidecar）。
 *
 * 现阶段：接口建好、可独立调（body 直接传 messages），但不自动触发——先专心测 sidecar 结构化效果。
 */
import { chat } from './gatewayClient.js'

export interface KeyInfoMessage {
  speaker: string // 'self'（专员）| 'other'（客户/群成员）| 'system'
  name?: string | null // 群里对方昵称（有则带上）
  text: string
}

export interface KeyInfoContext {
  customerName?: string
  source?: string // 泰康 / 平安…
  hospital?: string
  dept?: string
  serviceType?: string
}

export interface KeyInfoResult {
  fields: Record<string, string | null>
  summary: string | null
  model: string
  raw: string
}

// 默认抽取字段（可回填工单用）。没有的填 null，禁止编造。后续可按真实回填字段增减。
const FIELD_KEYS = [
  '意向医院',
  '意向科室',
  '意向医生',
  '期望就诊时间',
  '客户主诉或诉求',
  '病情或诊断补充',
  '特殊要求',
  '联系或沟通偏好',
  '其它关键点'
]

export async function extractKeyInfo(
  messages: KeyInfoMessage[],
  context?: KeyInfoContext
): Promise<KeyInfoResult> {
  const dialogue = messages
    .filter((m) => m.text && m.text.trim())
    .map((m) => {
      const who =
        m.speaker === 'self'
          ? '专员'
          : m.speaker === 'system'
            ? '系统'
            : m.name
              ? `客户(${m.name})`
              : '客户'
      return `${who}: ${m.text.trim()}`
    })
    .join('\n')

  const ctx = context
    ? `已知工单信息（供参考，不要照搬）：客户=${context.customerName ?? '?'}，来源=${context.source ?? '?'}，` +
      `意向医院=${context.hospital ?? '?'}，科室=${context.dept ?? '?'}，业务=${context.serviceType ?? '?'}。\n\n`
    : ''

  const schema = JSON.stringify({
    fields: Object.fromEntries(FIELD_KEYS.map((k) => [k, '值或null'])),
    summary: '一句话小结'
  })

  const result = await chat(
    [
      {
        role: 'system',
        content: [
          '你是医疗绿色通道服务的信息抽取助手。下面是寰宇"服务专员(self)"与"客户(other)"的微信/企业微信对话。',
          '注意：对话文字来自屏幕 OCR 识别，可能有错别字或个别字识别错误，请按语义合理理解，不要因个别错字影响判断。',
          '请从对话中抽取"可回填到工单系统"的关键信息。',
          '严格只输出一个 JSON 对象，不要解释、不要 Markdown、不要代码块标记。',
          '没有的字段填 null，绝不编造；只写对话里明确出现或可合理确认的信息。',
          'JSON 结构如下（键固定）：',
          schema
        ].join('\n')
      },
      {
        role: 'user',
        content: ctx + '对话如下：\n' + dialogue
      }
    ],
    { temperature: 0 }
  )

  const parsed = parseLenient(result.content)
  const fields: Record<string, string | null> = {}
  for (const k of FIELD_KEYS) {
    const v = parsed?.fields && (parsed.fields as Record<string, unknown>)[k]
    fields[k] = typeof v === 'string' && v.trim() && v.trim() !== 'null' ? v.trim() : null
  }
  const summary = typeof parsed?.summary === 'string' ? parsed.summary : null
  return { fields, summary, model: result.model, raw: result.content }
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
