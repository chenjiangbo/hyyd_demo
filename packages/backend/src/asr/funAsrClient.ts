/**
 * 阿里云百炼 Fun-ASR 录音文件识别客户端
 * 文档: https://help.aliyun.com/zh/model-studio/fun-asr-recorded-speech-recognition-restful-api
 */
import { getEnv } from '../env.js'

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/api/v1'

export interface FunAsrCreateOptions {
  fileUrls: string[]
  /** 是否启用说话人分离（要求单声道音频） */
  diarizationEnabled?: boolean
  /** 期望说话人数；diarization 启用时给个 hint，2 = 客服+客户 */
  speakerCount?: number
  /** 自定义业务标识，落到任务里方便追踪 */
  taskKey?: string
}

export interface FunAsrCreateResult {
  taskId: string
  taskStatus: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  raw: any
}

export interface FunAsrTaskInfo {
  taskId: string
  taskStatus: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'
  // 完成时存在
  results?: Array<{
    file_url: string
    transcription_url?: string
    subtask_status?: string
    code?: string
    message?: string
  }>
  raw: any
}

/** 转写结果 JSON 结构（下载下来的 transcription_url 内容） */
export interface TranscriptionDoc {
  file_url?: string
  properties?: Record<string, any>
  transcripts?: Array<{
    channel_id?: number
    content_duration_in_milliseconds?: number
    text?: string
    sentences?: Array<{
      sentence_id?: number
      begin_time?: number
      end_time?: number
      text: string
      speaker_id?: string | number
      words?: Array<{
        begin_time?: number
        end_time?: number
        text: string
        punctuation?: string
      }>
    }>
  }>
}

function getApiKey(): string {
  return getEnv().dashscopeApiKey
}

/** 提交录音文件识别任务（异步） */
export async function createTranscription(opts: FunAsrCreateOptions): Promise<FunAsrCreateResult> {
  const body: any = {
    model: 'fun-asr',
    input: { file_urls: opts.fileUrls },
    parameters: {}
  }
  if (opts.diarizationEnabled) {
    body.parameters.diarization_enabled = true
    if (opts.speakerCount) body.parameters.speaker_count = opts.speakerCount
  }
  if (opts.taskKey) body.parameters.task_key = opts.taskKey

  const resp = await fetch(`${DASHSCOPE_BASE}/services/audio/asr/transcription`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable'
    },
    body: JSON.stringify(body)
  })
  const json: any = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    const code = json?.code || resp.status
    const msg = json?.message || resp.statusText
    throw new Error(`Fun-ASR 提交失败 ${code}: ${msg}`)
  }
  const output = json?.output ?? {}
  if (!output.task_id) {
    throw new Error('Fun-ASR 提交后未返回 task_id: ' + JSON.stringify(json).slice(0, 200))
  }
  return {
    taskId: output.task_id,
    taskStatus: output.task_status,
    raw: json
  }
}

/** 查询任务状态 */
export async function getTask(taskId: string): Promise<FunAsrTaskInfo> {
  const resp = await fetch(`${DASHSCOPE_BASE}/tasks/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${getApiKey()}` }
  })
  const json: any = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    throw new Error(`Fun-ASR 查询失败 ${resp.status}: ${json?.message || resp.statusText}`)
  }
  const output = json?.output ?? {}
  return {
    taskId: output.task_id ?? taskId,
    taskStatus: output.task_status ?? 'UNKNOWN',
    results: output.results,
    raw: json
  }
}

/** 下载转写结果 JSON */
export async function downloadTranscription(url: string): Promise<TranscriptionDoc> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`下载转写结果失败 HTTP ${resp.status}`)
  return (await resp.json()) as TranscriptionDoc
}

/**
 * 把转写 JSON 渲染成可直接展示的纯文本：
 * 每行格式 `[10:23] 说话人 1: 你好...`
 * 时间戳基于音频起点的 ms 计算
 */
export function renderTranscriptText(doc: TranscriptionDoc, speakerLabels?: Record<string, string>): string {
  const lines: string[] = []
  const labelOf = (id: string | number | undefined): string => {
    if (id === undefined || id === null) return '说话人 ?'
    const key = String(id)
    if (speakerLabels?.[key]) return speakerLabels[key]
    return `说话人 ${key}`
  }
  const fmtTs = (ms?: number): string => {
    if (ms === undefined) return '--:--'
    const s = Math.floor(ms / 1000)
    return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`
  }
  for (const t of doc.transcripts ?? []) {
    for (const s of t.sentences ?? []) {
      lines.push(`[${fmtTs(s.begin_time)}] ${labelOf(s.speaker_id)}：${s.text}`)
    }
  }
  return lines.join('\n')
}
