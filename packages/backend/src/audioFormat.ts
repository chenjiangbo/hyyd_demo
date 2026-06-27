import type * as Minio from 'minio'

export interface AudioFormatInfo {
  mimeType: string
  format: string
  browserPlayable: boolean
}

const DEFAULT_AUDIO_FORMAT: AudioFormatInfo = {
  mimeType: 'application/octet-stream',
  format: 'unknown',
  browserPlayable: false
}

export async function detectAudioFormat(
  client: Minio.Client,
  bucket: string,
  key: string
): Promise<AudioFormatInfo> {
  const head = await readObjectHead(client, bucket, key, 64)
  return detectAudioFormatFromBytes(head, key)
}

function detectAudioFormatFromBytes(bytes: Buffer, key: string): AudioFormatInfo {
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') {
    return { mimeType: 'audio/wav', format: 'wav', browserPlayable: true }
  }
  if (bytes.length >= 3 && bytes.toString('ascii', 0, 3) === 'ID3') {
    return { mimeType: 'audio/mpeg', format: 'mp3', browserPlayable: true }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return { mimeType: 'audio/mpeg', format: 'mp3', browserPlayable: true }
  }
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'OggS') {
    return { mimeType: 'audio/ogg', format: 'ogg', browserPlayable: true }
  }
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'fLaC') {
    return { mimeType: 'audio/flac', format: 'flac', browserPlayable: true }
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { mimeType: 'audio/webm', format: 'webm', browserPlayable: true }
  }
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 6) === '#!AMR\n') {
    return { mimeType: 'audio/amr', format: 'amr', browserPlayable: false }
  }
  if (bytes.length >= 9 && bytes.toString('ascii', 0, 9) === '#!AMR-WB\n') {
    return { mimeType: 'audio/amr-wb', format: 'amr-wb', browserPlayable: false }
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12).toLowerCase()
    if (brand.startsWith('3gp')) return { mimeType: 'audio/3gpp', format: '3gp', browserPlayable: false }
    if (brand === 'qt  ') return { mimeType: 'audio/quicktime', format: 'mov', browserPlayable: false }
    return { mimeType: 'audio/mp4', format: brand.includes('m4a') ? 'm4a' : 'mp4', browserPlayable: true }
  }

  return detectAudioFormatFromExtension(key)
}

function detectAudioFormatFromExtension(key: string): AudioFormatInfo {
  const lower = key.toLowerCase()
  if (lower.endsWith('.m4a') || lower.endsWith('.mp4') || lower.endsWith('.aac')) {
    return { mimeType: 'audio/mp4', format: lower.endsWith('.m4a') ? 'm4a' : 'mp4', browserPlayable: true }
  }
  if (lower.endsWith('.mp3')) return { mimeType: 'audio/mpeg', format: 'mp3', browserPlayable: true }
  if (lower.endsWith('.wav')) return { mimeType: 'audio/wav', format: 'wav', browserPlayable: true }
  if (lower.endsWith('.ogg')) return { mimeType: 'audio/ogg', format: 'ogg', browserPlayable: true }
  if (lower.endsWith('.webm')) return { mimeType: 'audio/webm', format: 'webm', browserPlayable: true }
  if (lower.endsWith('.flac')) return { mimeType: 'audio/flac', format: 'flac', browserPlayable: true }
  if (lower.endsWith('.amr')) return { mimeType: 'audio/amr', format: 'amr', browserPlayable: false }
  if (lower.endsWith('.3gp') || lower.endsWith('.3gpp')) return { mimeType: 'audio/3gpp', format: '3gp', browserPlayable: false }
  return DEFAULT_AUDIO_FORMAT
}

async function readObjectHead(client: Minio.Client, bucket: string, key: string, length: number): Promise<Buffer> {
  const stream = await client.getPartialObject(bucket, key, 0, length)
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    chunks.push(buf)
    total += buf.length
    if (total >= length) break
  }
  return Buffer.concat(chunks).subarray(0, length)
}
