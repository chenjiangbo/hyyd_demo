/**
 * 图片手工补录的理解：用百炼 qwen-vl 一次完成"分类 + OCR/提取"。
 * 图片可能是：微信/企业微信聊天截图、单据(挂号/缴费/检查/病历…)、短信截图、或其他。
 * 输出 { kind, text }：kind=类型，text=图中文字/关键信息(尽量按语义整理)。
 * 结果由调用方缓存到 Material（识一次复用），供订单 AI 简报使用。
 * 铁律：VLM 只在后端调。
 */
import { visionChat } from './gatewayClient.js'

export type ImageKind = '聊天截图' | '单据' | '短信' | '其他'

export interface ImageUnderstandResult {
  kind: ImageKind
  text: string
  model: string
}

const SYSTEM = [
  '你是医疗绿色通道服务的图片理解助手。员工会粘贴各种截图作为订单补充材料。',
  '请判断图片类型，并提取其中的文字与关键信息。',
  '类型只能取其一：聊天截图（微信/企业微信对话）、单据（挂号单/缴费单/检查单/病历等）、短信、其他。',
  '提取要求：',
  '- 聊天截图：按"谁说了什么"的顺序整理对话文字（分得清就标注说话人）。',
  '- 单据：提取关键字段（医院、科室、医生、就诊时间、项目、金额、单号等）。',
  '- 短信：照录短信正文与发件方。',
  '- 看不清的字不要编造，照实留空或标注[不清晰]。',
  '严格只输出一个 JSON：{"kind":"聊天截图|单据|短信|其他","text":"提取到的文字与关键信息"}。',
  '不要解释、不要 Markdown、不要代码块标记。'
].join('\n')

const KINDS: ImageKind[] = ['聊天截图', '单据', '短信', '其他']

export async function understandImage(imageDataUrl: string): Promise<ImageUnderstandResult> {
  const res = await visionChat(SYSTEM, '请按要求识别这张图片，只输出 JSON。', imageDataUrl, {
    temperature: 0
  })
  const parsed = parseLenient(res.content)
  const kindRaw = typeof parsed?.kind === 'string' ? parsed.kind.trim() : ''
  const kind = (KINDS as string[]).includes(kindRaw) ? (kindRaw as ImageKind) : '其他'
  const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
  return { kind, text, model: res.model }
}

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
