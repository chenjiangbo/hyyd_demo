import type { Prisma, PrismaClient } from '@prisma/client'
import type * as Minio from 'minio'
import { getEnv } from '../env.js'
import { readRemoteOrderIdentity, updateRemoteOrderIdentity } from '../huanyuMysqlPush.js'
import { visionChat } from '../llm/gatewayClient.js'
import { isValidMainlandIdCard } from './orderIdCardOcr.js'

let activeJobs = 0
const waiters: Array<() => void> = []

// 此任务只记录状态，不持久化证件号码。所有时间由数据库 Asia/Shanghai 连接写入无时区列。
export async function ensureGreenPassIdCardJobs(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS green_pass_id_card_jobs (
    order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
    status VARCHAR(24) NOT NULL DEFAULT 'pending',
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS green_pass_sync_retries (
    order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)
}

export function matchesMaskedId(masked: string, full: string): boolean {
  const value = masked.trim().toUpperCase().replace(/[＊●•]/g, '*')
  if (!value) return true
  if (!value.includes('*')) return value === full
  return value.length === full.length && [...value].every((c, i) => c === '*' || c === full[i])
}

function sourceCard(raw: unknown, detail: unknown): string {
  const obj = (x: unknown): Record<string, any> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, any> : {}
  const r = obj(raw), d = obj(obj(detail).recommendations), original = obj(r.taikangRawJson ?? r.rawJson)
  return String(d.cardId ?? r.cardId ?? original.cardId ?? '').trim()
}

export async function enqueueGreenPassIdCardOcr(prisma: PrismaClient | Prisma.TransactionClient, orderId: number): Promise<void> {
  // 只有存在实际图片时创建任务；无附件不消耗识别机会。
  await prisma.$executeRaw`
    INSERT INTO green_pass_id_card_jobs (order_id, status)
    SELECT ${orderId}, 'pending' WHERE EXISTS (SELECT 1 FROM orders WHERE id = ${orderId} AND detail_fingerprint IS NOT NULL) AND EXISTS (
      SELECT 1 FROM order_attachments WHERE order_id = ${orderId} AND file_type = '40'
        AND byte_size > 0 AND byte_size <= 10485760 AND mime_type LIKE 'image/%'
    ) ON CONFLICT (order_id) DO NOTHING
  `
}

export async function runGreenPassIdCardOcr(prisma: PrismaClient, minio: Minio.Client, orderId: number): Promise<void> {
  if (activeJobs >= 2) await new Promise<void>(resolve => waiters.push(resolve))
  else activeJobs++
  try { await runClaimedJob(prisma, minio, orderId) }
  finally {
    const next = waiters.shift()
    if (next) next()
    else activeJobs--
  }
}

async function runClaimedJob(prisma: PrismaClient, minio: Minio.Client, orderId: number): Promise<void> {
  const claimed = await prisma.$executeRaw`
    UPDATE green_pass_id_card_jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP
    WHERE order_id = ${orderId} AND (status = 'pending' OR (status = 'failed' AND updated_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes') OR
      (status = 'running' AND updated_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'))
  `
  if (!claimed) return
  let status = 'failed'
  try {
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { source: true, sourceOrderNo: true, huanyuOrderNo: true, customerName: true, rawJson: true, detailJson: true } })
    if (!order || order.source !== 'taikang') { status = 'rejected'; return }
    if (!order.huanyuOrderNo) { status = 'pending'; return }
    const remote = await readRemoteOrderIdentity(order.huanyuOrderNo, order.sourceOrderNo)
    if (!remote) { status = 'pending'; return }
    const existing = remote.documentNo.trim()
    if (existing && !/[\*＊●•]/.test(existing)) { status = 'existing'; return }
    if (remote.documentType && !['身份证', '儿童身份证'].includes(remote.documentType)) { status = 'rejected'; return }
    if (!process.env.HYYD_VLM_API_KEY?.trim() && !getEnv().dashscopeApiKey) return
    const attachments = (await prisma.orderAttachment.findMany({ where: { orderId, fileType: '40' }, orderBy: { id: 'asc' } }))
      .filter(a => a.mimeType.startsWith('image/') && a.byteSize > 0 && a.byteSize <= 10 * 1024 * 1024)
    if (!attachments.length) { status = 'pending'; return }
    const images: string[] = []
    for (const attachment of attachments.slice(0, 4)) {
      const stream = await minio.getObject(attachment.minioBucket, attachment.minioKey)
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.from(chunk))
      const buffer = Buffer.concat(chunks)
      if (buffer.length && buffer.length <= 10 * 1024 * 1024) images.push(`data:${attachment.mimeType};base64,${buffer.toString('base64')}`)
    }
    if (!images.length) return
    const response = await visionChat('你只提取中国居民身份证人像面上的姓名和18位公民身份号码。国徽面不含号码，必须忽略。看不清或没有人像面时返回空字符串；不得猜测或补全。只返回 JSON 对象 {"name":"","idNumber":""}。', '这些是同一订单的身份证附件，请仅根据清晰的人像面提取姓名和身份证号码。', images, { temperature: 0, maxTokens: 120 })
    let parsed: { name?: unknown; idNumber?: unknown }
    try { parsed = JSON.parse(response.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()) } catch { status = 'rejected'; return }
    const name = String(parsed.name ?? '').replace(/\s/g, '')
    const id = String(parsed.idNumber ?? '').trim().toUpperCase().replace(/\s/g, '')
    const expectedName = [remote.name, order.customerName].map(n => (n || '').replace(/\s/g, '')).find(n => n && !n.includes('*')) || ''
    const source = sourceCard(order.rawJson, order.detailJson)
    if (!name || !isValidMainlandIdCard(id) || (expectedName && name !== expectedName) || !matchesMaskedId(existing, id) || !matchesMaskedId(source, id)) { status = 'rejected'; return }
    status = await updateRemoteOrderIdentity(order.huanyuOrderNo, order.sourceOrderNo, remote, id) ? 'saved' : 'pending'
  } catch (error) {
    // 不记录图片、识别内容或证件号。
    console.warn(`[green-pass-id-ocr] 订单 ${orderId} 识别或写入失败`, error instanceof Error ? error.name : 'Error')
  } finally {
    await prisma.$executeRaw`UPDATE green_pass_id_card_jobs SET status = ${status}, updated_at = CURRENT_TIMESTAMP WHERE order_id = ${orderId} AND status = 'running'`
  }
}

/** 只重试已经由采集流程创建的任务，不扫描历史订单。 */
export function startGreenPassIdCardRetries(prisma: PrismaClient, minio: Minio.Client): () => void {
  let running = false
  const tick = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      const rows = await prisma.$queryRaw<Array<{ order_id: number }>>`
        SELECT order_id FROM green_pass_id_card_jobs
        WHERE (status IN ('pending', 'failed') AND updated_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes')
           OR (status = 'running' AND updated_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes')
        ORDER BY updated_at LIMIT 20`
      for (const row of rows) await runGreenPassIdCardOcr(prisma, minio, row.order_id)
    } catch (error) { console.warn('[green-pass-id-ocr] 重试扫描失败', error instanceof Error ? error.name : 'Error') }
    finally { running = false }
  }
  const timer = setInterval(() => { void tick() }, 60_000)
  timer.unref()
  return () => clearInterval(timer)
}
