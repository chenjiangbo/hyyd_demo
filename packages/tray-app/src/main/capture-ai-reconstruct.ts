import { readFile } from 'fs/promises'

export interface ReconstructInput {
  path: string
  capturedAt: string | null
}

export interface AiReconstructMessage {
  sender: string // self | other | system
  name: string | null
  time: string | null
  content: string
  type: string // text | image | file | voice | emoji | other
}

export interface AiReconstructResult {
  model: string
  ok: boolean
  error: string | null
  latencyMs: number
  isChat: boolean | null
  conversationTitle: string | null
  messages: AiReconstructMessage[]
  rawContent: string
}

export const DEFAULT_RECONSTRUCT_MODELS = ['qwen-vl-max-latest', 'gui-plus']

const SYSTEM_PROMPT =
  '你是企业微信/微信聊天记录还原助手。【截图来自谁】这些截图来自一名【寰宇医道】公司服务人员本人的企业微信/微信账号，他负责"医疗绿通"业务。' +
  '【谁是 self】截图视角里的"自己(self)"=这名服务人员，即【提供服务的一方】。' +
  '【谁是 other】与他对话的另一方是【被服务的一方】（客户）。' +
  '截图可能是历史记录，不一定包含会话最开始。我会给你同一个聊天窗口在不同时刻、按时间先后排列的若干张截图。' +
  '请综合所有截图，还原这段聊天的消息。严格只输出一个 JSON 对象，不要输出解释、Markdown 或代码块标记。'

// 不同客户端的气泡配色不同，必须按渠道精确告知，否则模型会判错发送方
const colorRule = (channel: string): string =>
  channel === 'wechat'
    ? '本会话是【个人微信】：自己发送的消息是【浅绿色】气泡且靠右；对方发送的消息是【白色】气泡且靠左。'
    : '本会话是【企业微信】：自己发送的消息是【蓝色】气泡且靠右；对方发送的消息是【灰色】气泡且靠左。'

const userIntro = (n: number, channel: string): string =>
  `以下共 ${n} 张截图，按时间先后排列（每张前标注了序号和采集时间）。请完成：\n` +
  '1) 判断这些截图整体是否是聊天会话界面 isChat；如果是通讯录/工作台/会话列表等非聊天界面，isChat=false 且 messages 为空数组。\n' +
  '2) 还原聊天消息列表 messages，按时间从早到晚排序。\n' +
  '3) 判断发送者 sender【必须优先依据气泡颜色，颜色比左右位置更可靠，尤其消息很长时左右差别不明显，绝不能只凭左右】：' +
  colorRule(channel) +
  '判断发送者请【综合三方面：气泡颜色、左右位置、以及说话内容体现的角色】——self 是提供服务的一方、other 是被服务的一方，' +
  '服务方与被服务方说的话通常能看出区别；这三个线索一般是一致、互相印证的。' +
  '当消息很长导致左右不明显时，以气泡颜色为主、再结合语义综合判断。' +
  '撤回提示、时间分割线、"以下为新消息"等 = "system"。\n' +
  '4) 只还原【中间聊天区】里的气泡消息；忽略左侧会话/联系人列表、顶部标题栏、底部输入框里的任何文字，它们都不是消息。\n' +
  '5) 能看到对方昵称或群成员名时填 name，否则 null；conversationTitle 填会话标题（看不到填 null）。\n' +
  '6) 多张截图之间会有重复出现的消息，必须合并去重，同一条消息只输出一次。\n' +
  '7) 消息类型 type 取 text/image/file/voice/emoji/other（图片消息、文件、语音条、表情等按对应类型，content 填可读描述）。\n' +
  '8) 绝不要输出 content 为空或 null 的消息；绝不要重复输出同一条消息；messages 里每个元素都必须是真实可见、有内容的消息。\n' +
  '9) 【最重要：输入框里的草稿绝不是消息】窗口【最底部】有一个输入框区域——它是一片较大的空白输入区，' +
  '周围/下方通常有表情、附件、截图、发送按钮等工具栏图标；输入框里的文字【没有聊天气泡的背景色、也不在中间的消息流里】。' +
  '这是"还没点发送的草稿"，【绝对不要】把它当成消息输出。只有出现在中间消息流、带气泡背景的才算已发送消息。' +
  '判断某段文字算不算消息时，先看它是不是被气泡包裹、是否处于消息流中；处于最底部输入区的一律不算。' +
  '若同一段文字先出现在输入框、之后才作为气泡出现，只按已发送输出一次；若始终停在输入框、从未变成气泡，则完全不要输出。\n' +
  '只输出如下 JSON：\n' +
  '{"isChat":true,"conversationTitle":"会话标题或null","messages":[{"sender":"self|other|system","name":"昵称或null","time":"可见时间或null","content":"消息内容","type":"text"}]}'

export class CaptureAiReconstructor {
  // ⚠️ DEPRECATED：tray-app 不再持有 API key。env 字段保留只为类型兼容。
  // 真正的调用入口 resolveEndpoint() 会抛错指向后端。
  constructor(_env: NodeJS.ProcessEnv = process.env) {
    void _env
  }

  // ⚠️ DEPRECATED in tray-app（2026-06）
  // tray-app 不再持有任何 LLM/VLM API key（API key 必须只放在后端，
  // 避免随源码 deploy 到员工 VM 上泄露）。如果未来要恢复 sidecar 的 AI 还原
  // 能力，请在 backend 实现一个 /api/v1/admin/vlm-reconstruct 端点，
  // tray-app 通过 backend HTTP 调用该端点，由 backend 转发给 DashScope / 网关。
  // 现状：env 里这些 key 都是空字符串（VM 上没有 .env），调用会直接抛错。
  private resolveEndpoint(model: string): { url: string; headers: Record<string, string> } {
    void model
    throw new Error(
      'AI 还原已迁移到后端：tray-app 不再持有 LLM/VLM API key。' +
        '请在 backend 实现 /api/v1/admin/vlm-reconstruct 后由 tray-app 转发调用。' +
        '现场版默认不启用 sidecar，本路径不应被触发。'
    )
  }

  async reconstruct(
    inputs: ReconstructInput[],
    models: string[] = DEFAULT_RECONSTRUCT_MODELS,
    channel = 'wxwork'
  ): Promise<AiReconstructResult[]> {
    if (inputs.length === 0) throw new Error('未选择任何截图')
    // 图片只读一次，多个模型复用
    const images = await Promise.all(
      inputs.map(async (input, idx) => ({
        idx,
        capturedAt: input.capturedAt,
        dataUrl: `data:image/png;base64,${(await readFile(input.path)).toString('base64')}`
      }))
    )
    const list = models.length > 0 ? models : DEFAULT_RECONSTRUCT_MODELS
    return Promise.all(list.map((m) => this.callOne(m, images, channel)))
  }

  private async callOne(
    model: string,
    images: Array<{ idx: number; capturedAt: string | null; dataUrl: string }>,
    channel: string
  ): Promise<AiReconstructResult> {
    const started = Date.now()
    const base: AiReconstructResult = {
      model,
      ok: false,
      error: null,
      latencyMs: 0,
      isChat: null,
      conversationTitle: null,
      messages: [],
      rawContent: ''
    }

    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: userIntro(images.length, channel) }
    ]
    for (const img of images) {
      content.push({ type: 'text', text: `第${img.idx + 1}张，时间 ${img.capturedAt ?? '未知'}` })
      content.push({ type: 'image_url', image_url: { url: img.dataUrl } })
    }

    let endpoint: { url: string; headers: Record<string, string> }
    try {
      endpoint = this.resolveEndpoint(model)
    } catch (e) {
      base.error = e instanceof Error ? e.message : String(e)
      return base
    }

    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: endpoint.headers,
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content }
          ]
        })
      })
      if (!res.ok) {
        base.error = `HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`
        base.latencyMs = Date.now() - started
        return base
      }
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const raw = json.choices?.[0]?.message?.content ?? ''
      base.rawContent = raw
      base.latencyMs = Date.now() - started
      const parsed = parseLenient(raw)
      if (!parsed) {
        base.error = '无法从模型返回中解析出 JSON'
        return base
      }
      base.ok = true
      base.isChat = typeof parsed.isChat === 'boolean' ? parsed.isChat : null
      base.conversationTitle =
        typeof parsed.conversationTitle === 'string' ? parsed.conversationTitle : null
      base.messages = Array.isArray(parsed.messages)
        ? parsed.messages.map(toMessage).filter((m): m is AiReconstructMessage => m !== null)
        : []
      return base
    } catch (e) {
      base.error = e instanceof Error ? e.message : String(e)
      base.latencyMs = Date.now() - started
      return base
    }
  }
}

function toMessage(v: unknown): AiReconstructMessage | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const content = typeof o.content === 'string' ? o.content : ''
  // 丢弃空消息（模型退化时会吐大量 content 为空/null 的占位）
  if (!content.trim()) return null
  return {
    sender: typeof o.sender === 'string' ? o.sender : 'other',
    name: typeof o.name === 'string' ? o.name : null,
    time: typeof o.time === 'string' ? o.time : null,
    content,
    type: typeof o.type === 'string' ? o.type : 'text'
  }
}

// 容错解析：去掉 ```fence```，截取第一个 { 到最后一个 }；解析失败时尝试补救被截断的 JSON
function parseLenient(content: string): Record<string, unknown> | null {
  if (!content) return null
  let s = content.trim()
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  }
  const start = s.indexOf('{')
  if (start < 0) return null
  const body = s.slice(start)
  const end = body.lastIndexOf('}')
  if (end > 0) {
    try {
      return JSON.parse(body.slice(0, end + 1)) as Record<string, unknown>
    } catch {
      // 落到补救逻辑
    }
  }
  return salvageTruncated(body)
}

// 补救被截断的输出：截到最后一个完整的 } ，再尝试补上数组/对象的收尾
function salvageTruncated(body: string): Record<string, unknown> | null {
  const lastBrace = body.lastIndexOf('}')
  if (lastBrace < 0) return null
  const head = body.slice(0, lastBrace + 1)
  for (const suffix of ['', ']}', '}', ']}}', '}}']) {
    try {
      return JSON.parse(head + suffix) as Record<string, unknown>
    } catch {
      // 试下一个收尾
    }
  }
  return null
}
