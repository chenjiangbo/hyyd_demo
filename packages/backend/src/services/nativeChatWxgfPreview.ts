import type * as Minio from 'minio'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wxgfImagePartition } from './nativeChatWxgf.js'

const BUCKET = 'materials'
const PREVIEW_PREFIX = 'native-chat-image-previews-v2'
const running = new Map<string, Promise<void>>()

function previewKey(attachmentId: number): string {
  return `${PREVIEW_PREFIX}/${attachmentId}.jpg`
}

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  const code = (error as { code?: unknown }).code
  return code === 'NoSuchKey' || code === 'NotFound'
}

async function objectExists(client: Minio.Client, key: string): Promise<boolean> {
  try {
    await client.statObject(BUCKET, key)
    return true
  } catch (error) {
    if (isMissingObject(error)) return false
    throw error
  }
}

export async function getNativeChatWxgfPreviewUrl(
  client: Minio.Client,
  publicClient: Minio.Client,
  attachmentId: number,
  sourceKey: string,
  expiresIn = 60 * 60
): Promise<string> {
  const targetKey = previewKey(attachmentId)
  if (!(await objectExists(client, targetKey))) {
    let task = running.get(targetKey)
    if (!task) {
      task = transcodeWxgfToJpeg(client, sourceKey, targetKey)
      running.set(targetKey, task)
      void task.then(() => running.delete(targetKey), () => running.delete(targetKey))
    }
    await task
  }
  return publicClient.presignedGetObject(BUCKET, targetKey, expiresIn, {
    'response-content-type': 'image/jpeg'
  })
}

export async function removeNativeChatWxgfPreview(client: Minio.Client, attachmentId: number): Promise<void> {
  for (const targetKey of [previewKey(attachmentId), `native-chat-image-previews/${attachmentId}.jpg`]) {
    if (await objectExists(client, targetKey)) await client.removeObject(BUCKET, targetKey)
  }
}

async function transcodeWxgfToJpeg(client: Minio.Client, sourceKey: string, targetKey: string): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of await client.getObject(BUCKET, sourceKey)) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const output = await convertNativeChatWxgfToJpeg(Buffer.concat(chunks))
  await client.putObject(BUCKET, targetKey, output, output.length, { 'Content-Type': 'image/jpeg' })
}

export async function convertNativeChatWxgfToJpeg(source: Buffer): Promise<Buffer> {
  const workDir = await mkdtemp(join(tmpdir(), 'hyyd-native-chat-image-'))
  const hevcPath = join(workDir, 'source.hevc')
  const outputPath = join(workDir, 'preview.jpg')
  try {
    await writeFile(hevcPath, wxgfImagePartition(source))
    await runFfmpeg(hevcPath, outputPath)
    const output = await readFile(outputPath)
    if (output.length < 3 || output[0] !== 0xff || output[1] !== 0xd8 || output[2] !== 0xff) {
      throw new Error('WXGF 图片没有生成有效的 JPEG 图像')
    }
    return output
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

function runFfmpeg(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-f', 'hevc', '-i', input,
      '-frames:v', '1', '-q:v', '2', output
    ])
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `WXGF 图片转码失败，ffmpeg 退出码 ${code}`))
    })
  })
}
