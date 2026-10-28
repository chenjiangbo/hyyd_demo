import type * as Minio from 'minio'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

const BUCKET = 'materials'
const PREVIEW_PREFIX = 'native-chat-image-previews'
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
  const targetKey = previewKey(attachmentId)
  if (await objectExists(client, targetKey)) await client.removeObject(BUCKET, targetKey)
}

async function transcodeWxgfToJpeg(client: Minio.Client, sourceKey: string, targetKey: string): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'hyyd-native-chat-image-'))
  const sourcePath = join(workDir, 'source.wxgf')
  const hevcPath = join(workDir, 'source.hevc')
  const outputPath = join(workDir, 'preview.jpg')
  try {
    await pipeline(await client.getObject(BUCKET, sourceKey), createWriteStream(sourcePath))
    const source = await readFile(sourcePath)
    if (source.subarray(0, 4).toString('ascii') !== 'wxgf') {
      throw new Error('微信图片附件不是可识别的 WXGF 格式')
    }
    const start = annexBStart(source)
    if (start < 0) throw new Error('WXGF 图片中缺少 HEVC 图像流')
    await writeFile(hevcPath, source.subarray(start))
    await runFfmpeg(hevcPath, outputPath)
    const output = await readFile(outputPath)
    if (output.length < 3 || output[0] !== 0xff || output[1] !== 0xd8 || output[2] !== 0xff) {
      throw new Error('WXGF 图片没有生成有效的 JPEG 图像')
    }
    await client.putObject(BUCKET, targetKey, createReadStream(outputPath), output.length, {
      'Content-Type': 'image/jpeg'
    })
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

function annexBStart(data: Buffer): number {
  const fourByte = data.indexOf(Buffer.from([0, 0, 0, 1]))
  const threeByte = data.indexOf(Buffer.from([0, 0, 1]))
  if (fourByte < 0) return threeByte
  if (threeByte < 0) return fourByte
  return Math.min(fourByte, threeByte)
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
