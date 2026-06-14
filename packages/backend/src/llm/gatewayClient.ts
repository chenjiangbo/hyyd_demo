/**
 * LLM 客户端：直连阿里云百炼（DashScope）OpenAI 兼容端点。
 *   端点：https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
 *   凭证：DASHSCOPE_API_KEY（env，与 ASR 复用同一个 key）
 *   默认模型：qwen-plus（可用 options.model 或环境变量 HYYD_LLM_MODEL 覆盖）
 * 历史：之前走自建 BlackWhite 网关（GATEWAY_*），现改为百炼官方直连。
 * 铁律：所有 LLM 调用只在后端发起，tray-app/sidecar 不持 key。
 */
import { getEnv } from '../env.js'

const DASHSCOPE_CHAT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  model?: string
  stream?: false          // 本客户端只实现非流式，流式请用 chatStream
  maxTokens?: number
  temperature?: number
  plugins?: Array<{ id: string; engine?: string; max_results?: number }>
}

export interface ChatResult {
  content: string
  model: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// ── 配置 ────────────────────────────────────────────────────────────────────

function getConfig() {
  const env = getEnv()
  return {
    baseUrl: env.gatewayBaseUrl,
    appId: env.gatewayAppId,
    apiKey: env.gatewayApiKey
  }
}

// ── 非流式聊天 ────────────────────────────────────────────────────────────────

export async function chat(
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<ChatResult> {
  const apiKey = getEnv().dashscopeApiKey
  // 默认 qwen-plus（当前 DASHSCOPE key 已开通、可用）。
  // ⚠️ qwen-max-latest 这个 key 暂无权限(403)。想用旗舰/推理模型：先在百炼控制台「模型广场」开通，
  //    再设环境变量 HYYD_LLM_MODEL=<型号>（如 qwen-max-latest / qwen3-235b-a22b / qwq-plus），无需改代码。
  const model = options.model ?? process.env.HYYD_LLM_MODEL ?? 'qwen-plus'

  const body: Record<string, unknown> = {
    model,
    stream: false,
    messages,
  }
  if (options.maxTokens)   body.max_tokens   = options.maxTokens
  if (options.temperature !== undefined) body.temperature = options.temperature

  const res = await fetch(DASHSCOPE_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)')
    throw new Error(`百炼返回错误 ${res.status}: ${text}`)
  }

  const json = await res.json() as any
  const choice = json.choices?.[0]
  if (!choice) throw new Error('百炼响应缺少 choices')

  return {
    content: choice.message?.content ?? '',
    model:   json.model ?? model,
    usage:   json.usage,
  }
}

// ── 多模态（图片理解）─────────────────────────────────────────────────────
// 用百炼 qwen-vl 模型对图片做"看图 + 提取"。图片以 data URL(base64) 传入
// （MinIO 在内网，DashScope 抓不到 presigned URL，必须 base64 内联）。
// 模型经 HYYD_VLM_MODEL 覆盖，默认 qwen-vl-max（已验证该 key 可用）。
export async function visionChat(
  systemPrompt: string,
  userText: string,
  imageDataUrl: string,
  options: ChatOptions = {}
): Promise<ChatResult> {
  const apiKey = getEnv().dashscopeApiKey
  const model = options.model ?? process.env.HYYD_VLM_MODEL ?? 'qwen-vl-max'

  const body: Record<string, unknown> = {
    model,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      }
    ]
  }
  if (options.maxTokens) body.max_tokens = options.maxTokens
  if (options.temperature !== undefined) body.temperature = options.temperature

  const res = await fetch(DASHSCOPE_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)')
    throw new Error(`百炼 VL 返回错误 ${res.status}: ${text}`)
  }
  const json = (await res.json()) as any
  const choice = json.choices?.[0]
  if (!choice) throw new Error('百炼 VL 响应缺少 choices')
  return { content: choice.message?.content ?? '', model: json.model ?? model, usage: json.usage }
}

// ── 流式聊天（AsyncGenerator，调用方可 for-await 逐 chunk 处理）────────────

export async function* chatStream(
  messages: ChatMessage[],
  options: Omit<ChatOptions, 'stream'> = {}
): AsyncGenerator<string, void, unknown> {
  const { baseUrl, appId, apiKey } = getConfig()
  const model = options.model ?? 'google/gemini-2.5-flash-lite'

  const body: Record<string, unknown> = {
    model,
    stream: true,
    messages,
  }
  if (options.maxTokens)   body.max_tokens   = options.maxTokens
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.plugins?.length) body.plugins = options.plugins

  const res = await fetch(`${baseUrl}/proxy/openrouter/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Accept':        'text/event-stream',
      'X-App-Id':      appId,
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '(no body)')
    throw new Error(`Gateway 流式返回错误 ${res.status}: ${text}`)
  }

  const reader  = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    const lines = buf.split('\n')
    buf = lines.pop() ?? ''           // 最后一行可能还不完整，留给下次

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') return

      try {
        const chunk = JSON.parse(data)
        const delta = chunk.choices?.[0]?.delta?.content
        if (delta) yield delta
      } catch {
        // 忽略解析失败的行
      }
    }
  }
}

// ── 长任务 Job（提交后返回 job_id，适合耗时较长的请求）──────────────────────

export interface JobSubmitResult {
  jobId: string
}

export async function submitJob(
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<JobSubmitResult> {
  const { baseUrl, appId, apiKey } = getConfig()
  const model = options.model ?? 'google/gemini-2.5-flash-lite'

  const body: Record<string, unknown> = {
    model,
    stream: false,
    messages,
  }
  if (options.maxTokens)   body.max_tokens   = options.maxTokens
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.plugins?.length) body.plugins = options.plugins

  const res = await fetch(`${baseUrl}/jobs/openrouter/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'X-App-Id':      appId,
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)')
    throw new Error(`Gateway Job 提交失败 ${res.status}: ${text}`)
  }

  const json = await res.json() as any
  const jobId = json.job_id ?? json.id
  if (!jobId) throw new Error('Gateway 未返回 job_id')
  return { jobId }
}

export async function getJobResult(jobId: string): Promise<ChatResult> {
  const { baseUrl, appId, apiKey } = getConfig()

  const res = await fetch(`${baseUrl}/jobs/${jobId}/result`, {
    headers: {
      'X-App-Id':      appId,
      'Authorization': `Bearer ${apiKey}`,
    },
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)')
    throw new Error(`Gateway Job 结果获取失败 ${res.status}: ${text}`)
  }

  const json = await res.json() as any
  const choice = json.choices?.[0]
  if (!choice) throw new Error('Job 结果缺少 choices')

  return {
    content: choice.message?.content ?? '',
    model:   json.model ?? 'unknown',
    usage:   json.usage,
  }
}
