/**
 * BlackWhite AI Gateway 客户端
 *
 * hyyd_demo 的所有 LLM 调用都走这个模块，不直连 OpenRouter。
 * 凭证通过环境变量注入：
 *   GATEWAY_BASE_URL   = http://127.0.0.1:8080   （默认）
 *   GATEWAY_APP_ID     = hyyd-demo
 *   GATEWAY_API_KEY    = hyyd-demo-secret-2026
 */

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
  const baseUrl = process.env.GATEWAY_BASE_URL || 'http://127.0.0.1:8080'
  const appId   = process.env.GATEWAY_APP_ID   || 'hyyd-demo'
  const apiKey  = process.env.GATEWAY_API_KEY  || 'hyyd-demo-secret-2026'
  return { baseUrl, appId, apiKey }
}

// ── 非流式聊天 ────────────────────────────────────────────────────────────────

export async function chat(
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<ChatResult> {
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

  const res = await fetch(`${baseUrl}/proxy/openrouter/chat/completions`, {
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
    throw new Error(`Gateway 返回错误 ${res.status}: ${text}`)
  }

  const json = await res.json() as any
  const choice = json.choices?.[0]
  if (!choice) throw new Error('Gateway 响应缺少 choices')

  return {
    content: choice.message?.content ?? '',
    model:   json.model ?? model,
    usage:   json.usage,
  }
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
