import { readFile } from 'fs/promises'

export interface CaptureLayoutRegion {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface CaptureLayoutResult {
  imageWidth: number
  imageHeight: number
  regions: {
    sidebar: CaptureLayoutRegion
    title: CaptureLayoutRegion
    chat: CaptureLayoutRegion
    input: CaptureLayoutRegion
  }
  confidence: number
  rawResponse: string
  model: string
}

export class CaptureLayoutService {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly model: string

  constructor(env = process.env) {
    this.baseUrl = requireEnv(env, 'HYYD_VLM_BASE_URL')
    this.apiKey = requireEnv(env, 'HYYD_VLM_API_KEY')
    this.model = requireEnv(env, 'HYYD_VLM_MODEL')
  }

  getConfigSummary(): { baseUrl: string; model: string } {
    return { baseUrl: this.baseUrl, model: this.model }
  }

  async analyzeWindowLayout(screenshotPath: string): Promise<CaptureLayoutResult> {
    const imageBase64 = (await readFile(screenshotPath)).toString('base64')
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'system',
            content:
              '你只负责分析 Windows 桌面微信或企业微信窗口截图的界面布局。必须按照给定 JSON schema 输出，不要输出解释、动作计划、工具调用或聊天内容。'
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  '你会看到一张 Windows 桌面端微信或企业微信窗口截图。只识别窗口内部 sidebar/title/chat/input 四个主要区域，坐标相对于输入图片左上角。不要识别聊天内容，不要解释，只输出 JSON。'
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${imageBase64}`
                }
              }
            ]
          }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'wechat_window_layout',
            strict: true,
            schema: layoutJsonSchema
          }
        },
        temperature: 0
      })
    })

    if (!res.ok) {
      throw new Error(`VLM layout HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    }

    const rawJson = await res.text()
    const response = JSON.parse(rawJson) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = response.choices?.[0]?.message?.content
    if (!content) throw new Error('VLM layout 响应缺少 choices[0].message.content')

    const parsed = parseLayoutJson(content)
    validateLayout(parsed)
    return {
      ...parsed,
      rawResponse: rawJson,
      model: this.model
    }
  }
}

const rectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['x1', 'y1', 'x2', 'y2'],
  properties: {
    x1: { type: 'integer', minimum: 0 },
    y1: { type: 'integer', minimum: 0 },
    x2: { type: 'integer', minimum: 1 },
    y2: { type: 'integer', minimum: 1 }
  }
}

const layoutJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['imageWidth', 'imageHeight', 'regions', 'confidence'],
  properties: {
    imageWidth: { type: 'integer', minimum: 1 },
    imageHeight: { type: 'integer', minimum: 1 },
    regions: {
      type: 'object',
      additionalProperties: false,
      required: ['sidebar', 'title', 'chat', 'input'],
      properties: {
        sidebar: rectJsonSchema,
        title: rectJsonSchema,
        chat: rectJsonSchema,
        input: rectJsonSchema
      }
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  }
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) throw new Error(`缺少必需环境变量 ${key}`)
  return value
}

function parseLayoutJson(content: string): Omit<CaptureLayoutResult, 'rawResponse' | 'model'> {
  const trimmed = content.trim()
  const jsonText = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    : trimmed
  return JSON.parse(jsonText) as Omit<CaptureLayoutResult, 'rawResponse' | 'model'>
}

function validateLayout(layout: Omit<CaptureLayoutResult, 'rawResponse' | 'model'>): void {
  if (!Number.isFinite(layout.imageWidth) || !Number.isFinite(layout.imageHeight)) {
    throw new Error('VLM layout 缺少 imageWidth/imageHeight')
  }

  const { sidebar, title, chat, input } = layout.regions ?? {}
  for (const [name, rect] of Object.entries({ sidebar, title, chat, input })) {
    if (!rect) throw new Error(`VLM layout 缺少 ${name} 区域`)
    if (rect.x1 < 0 || rect.y1 < 0 || rect.x2 > layout.imageWidth || rect.y2 > layout.imageHeight) {
      throw new Error(`VLM layout ${name} 坐标越界`)
    }
    if (rect.x2 <= rect.x1 || rect.y2 <= rect.y1) {
      throw new Error(`VLM layout ${name} 宽高非法`)
    }
  }

  if (chat.y1 < title.y1 || input.y1 < chat.y1 || chat.x1 < sidebar.x1) {
    throw new Error('VLM layout 区域相对位置不合理')
  }

  if (layout.confidence < 0 || layout.confidence > 1) {
    throw new Error('VLM layout confidence 必须在 0 到 1 之间')
  }
}
