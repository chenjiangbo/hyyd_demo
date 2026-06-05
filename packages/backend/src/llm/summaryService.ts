/**
 * AI 摘要服务
 *
 * 根据订单聚合数据（通话记录、微信消息、订单详情）生成结构化摘要。
 * 目前支持三种摘要类型，对应 AiSummary.type 字段：
 *   - 'call'    : 针对单条通话的 ASR 文字转写摘要
 *   - 'message' : 微信对话摘要
 *   - 'full'    : 订单整体跟进摘要（综合通话 + 消息 + 详情）
 */

import { chat } from './gatewayClient.js'

// ── 类型定义 ─────────────────────────────────────────────────────────────────

export interface CallSummaryInput {
  /** 通话 ASR 转写文本 */
  transcript: string
  /** 通话方向 */
  direction?: 'inbound' | 'outbound'
  /** 通话时长（秒） */
  durationSec?: number
}

export interface MessageSummaryInput {
  /** 微信会话名称（客户姓名或群名） */
  conversationName: string
  /** 消息列表：{ sender, content, time }[] */
  messages: Array<{ senderName?: string | null; contentText: string; capturedAt: string }>
}

export interface FullSummaryInput {
  order: {
    customerName: string
    hospital?: string | null
    dept?: string | null
    doctor?: string | null
    status: string
    sourceOrderNo: string
  }
  callTranscripts: string[]           // 多条通话文字
  messageTexts: string[]              // 多条微信消息
  detailJson?: Record<string, unknown> | null
}

export interface SummaryResult {
  content: string
  model: string
}

// ── 通话摘要 ─────────────────────────────────────────────────────────────────

export async function summarizeCall(input: CallSummaryInput): Promise<SummaryResult> {
  const directionLabel = input.direction === 'inbound' ? '来电' : '去电'
  const duration = input.durationSec ? `（时长 ${input.durationSec} 秒）` : ''

  const result = await chat(
    [
      {
        role: 'system',
        content: [
          '你是一个医疗服务行业的助理，负责帮助员工整理通话记录。',
          '请用简洁的中文对通话内容做结构化摘要，包含：',
          '1. 通话主要事项（1-3 条）',
          '2. 客户诉求或问题',
          '3. 跟进建议（如有）',
          '输出纯文本，不要 Markdown，不要编造不在记录中的内容。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `以下是一段${directionLabel}通话的 ASR 转写${duration}，请为其生成摘要：\n\n${input.transcript}`,
      },
    ],
    { temperature: 0.3 }
  )

  return { content: result.content, model: result.model }
}

// ── 微信消息摘要 ──────────────────────────────────────────────────────────────

export async function summarizeMessages(input: MessageSummaryInput): Promise<SummaryResult> {
  const msgLines = input.messages
    .map(m => `[${m.capturedAt.substring(0, 16)}] ${m.senderName ?? '未知'}: ${m.contentText}`)
    .join('\n')

  const result = await chat(
    [
      {
        role: 'system',
        content: [
          '你是一个医疗服务行业的助理。',
          '请用简洁的中文对微信对话做结构化摘要，包含：',
          '1. 对话主要事项',
          '2. 客户关键诉求或情绪',
          '3. 待跟进事项（如有）',
          '输出纯文本，不要 Markdown。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `以下是与「${input.conversationName}」的微信对话记录，请生成摘要：\n\n${msgLines}`,
      },
    ],
    { temperature: 0.3 }
  )

  return { content: result.content, model: result.model }
}

// ── 全单摘要 ─────────────────────────────────────────────────────────────────

export async function summarizeFull(input: FullSummaryInput): Promise<SummaryResult> {
  const { order } = input

  const parts: string[] = []

  parts.push(`【订单基本信息】`)
  parts.push(`客户：${order.customerName}`)
  if (order.hospital) parts.push(`医院：${order.hospital}`)
  if (order.dept)     parts.push(`科室：${order.dept}`)
  if (order.doctor)   parts.push(`医生：${order.doctor}`)
  parts.push(`状态：${order.status}`)
  parts.push(`单号：${order.sourceOrderNo}`)

  if (input.callTranscripts.length) {
    parts.push(`\n【通话记录（共 ${input.callTranscripts.length} 条）】`)
    input.callTranscripts.forEach((t, i) => {
      parts.push(`--- 通话 ${i + 1} ---\n${t.substring(0, 800)}`) // 截断避免超 token
    })
  }

  if (input.messageTexts.length) {
    parts.push(`\n【微信消息（最近 ${input.messageTexts.length} 条）】`)
    parts.push(input.messageTexts.join('\n').substring(0, 1000))
  }

  if (input.detailJson) {
    parts.push(`\n【订单详情字段（部分）】`)
    parts.push(JSON.stringify(input.detailJson).substring(0, 500))
  }

  const result = await chat(
    [
      {
        role: 'system',
        content: [
          '你是一个医疗服务行业的订单跟进助理。',
          '请根据以下订单的全部信息，生成一份简洁的跟进总结，包含：',
          '1. 当前进展（2-4 句）',
          '2. 客户核心诉求',
          '3. 下一步建议行动',
          '输出纯文本，不要 Markdown。字数控制在 300 字以内。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: parts.join('\n'),
      },
    ],
    { temperature: 0.3 }
  )

  return { content: result.content, model: result.model }
}
