import type * as Minio from 'minio'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'
import { detectAudioFormat, type AudioFormatInfo } from './audioFormat.js'

export type RecordingPlaybackStatus = 'ready' | 'transcoding' | 'failed'

export interface RecordingPlaybackInfo extends AudioFormatInfo {
  status: RecordingPlaybackStatus
  url: string | null
  expiresIn: number
  playableKey?: string
  message?: string
}

const TRANSCODE_CONCURRENCY = 1
const PLAYABLE_PREFIX = 'playable-recordings'
const running = new Map<string, Promise<void>>()
const failures = new Map<string, { message: string; at: number }>()
let active = 0
const queue: Array<() => void> = []

export async function getRecordingPlaybackInfo(
  minioClient: Minio.Client,
  minioPublicClient: Minio.Client,
  bucket: string,
  callId: number,
  sourceKey: string,
  expiresIn = 60 * 60
): Promise<RecordingPlaybackInfo> {
  const sourceFormat = await detectAudioFormat(minioClient, bucket, sourceKey)
  if (sourceFormat.browserPlayable) {
    const url = await minioPublicClient.presignedGetObject(bucket, sourceKey, expiresIn, {
      'response-content-type': sourceFormat.mimeType
    })
    return { status: 'ready', url, expiresIn, ...sourceFormat }
  }

  if (!isTranscodable(sourceFormat)) {
    return {
      status: 'failed',
      url: null,
      expiresIn,
      ...sourceFormat,
      message: `录音格式 ${sourceFormat.format} 暂不支持浏览器播放，也不在当前转码范围内`
    }
  }

  const playableKey = playableObjectKey(callId)
  if (await objectExists(minioClient, bucket, playableKey)) {
    const url = await minioPublicClient.presignedGetObject(bucket, playableKey, expiresIn, {
      'response-content-type': 'audio/mpeg'
    })
    return {
      status: 'ready',
      url,
      expiresIn,
      mimeType: 'audio/mpeg',
      format: 'mp3',
      browserPlayable: true,
      playableKey
    }
  }

  const failure = failures.get(playableKey)
  if (failure && Date.now() - failure.at < 10 * 60_000) {
    return {
      status: 'failed',
      url: null,
      expiresIn,
      ...sourceFormat,
      playableKey,
      message: failure.message
    }
  }

  startTranscodeOnce(minioClient, bucket, sourceKey, playableKey)
  return {
    status: 'transcoding',
    url: null,
    expiresIn,
    ...sourceFormat,
    playableKey,
    message: `录音格式 ${sourceFormat.format} 正在转成可播放音频`
  }
}

function playableObjectKey(callId: number): string {
  return `${PLAYABLE_PREFIX}/call-${callId}.mp3`
}

function isTranscodable(format: AudioFormatInfo): boolean {
  return format.format === 'amr' || format.format === 'amr-wb' || format.format === '3gp'
}

async function objectExists(client: Minio.Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.statObject(bucket, key)
    return true
  } catch {
    return false
  }
}

function startTranscodeOnce(
  client: Minio.Client,
  bucket: string,
  sourceKey: string,
  targetKey: string
): void {
  if (running.has(targetKey)) return
  failures.delete(targetKey)
  const task = withConcurrency(() => transcodeToMp3(client, bucket, sourceKey, targetKey))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      failures.set(targetKey, { message: `录音转码失败: ${message}`, at: Date.now() })
    })
    .finally(() => running.delete(targetKey))
  running.set(targetKey, task)
}

async function withConcurrency<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= TRANSCODE_CONCURRENCY) {
    await new Promise<void>((resolve) => queue.push(resolve))
  }
  active++
  try {
    return await fn()
  } finally {
    active--
    queue.shift()?.()
  }
}

async function transcodeToMp3(
  client: Minio.Client,
  bucket: string,
  sourceKey: string,
  targetKey: string
): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'hyyd-audio-'))
  const input = join(workDir, 'input')
  const output = join(workDir, 'output.mp3')
  try {
    await pipeline(await client.getObject(bucket, sourceKey), createWriteStream(input))
    await runFfmpeg(input, output)
    const outputStat = await stat(output)
    await client.putObject(bucket, targetKey, createReadStream(output), outputStat.size, {
      'Content-Type': 'audio/mpeg'
    })
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

function runFfmpeg(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      input,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-codec:a',
      'libmp3lame',
      '-b:a',
      '48k',
      output
    ])
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`))
    })
  })
}
