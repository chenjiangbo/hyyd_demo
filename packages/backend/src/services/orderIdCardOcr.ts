import type { PrismaClient } from '@prisma/client'
import type * as Minio from 'minio'
import { visionChat } from '../llm/gatewayClient.js'
import { getEnv } from '../env.js'

type HuanyuIdentity = { DDBH: string; JZR_ZJHM: string | null; JZR_ZJLX: string | null; JZR_XM: string | null }

// 插件批量采集时避免同时读取大量证件照片并发起过多视觉模型请求。
let activeJobs = 0
const waitingJobs: Array<() => void> = []
const scheduledJobs = new Map<number, Promise<void>>()

export function scheduleOrderIdCardOcr(prisma: PrismaClient, minio: Minio.Client, orderId: number): Promise<void> {
  const existing = scheduledJobs.get(orderId)
  if (existing) return existing
  const job = new Promise<void>((resolve, reject) => {
    const run = (): void => {
      activeJobs++
      void recognizeOrderIdCardOnce(prisma, minio, orderId)
        .then(resolve, reject)
        .finally(() => {
          activeJobs--
          waitingJobs.shift()?.()
        })
    }
    if (activeJobs < 2) run()
    else waitingJobs.push(run)
  })
  scheduledJobs.set(orderId, job)
  void job.finally(() => scheduledJobs.delete(orderId)).catch(() => undefined)
  return job
}

/** OCR 尝试记录不存证件号码；真实号码只写本地寰宇主表。 */
export async function ensureOrderIdCardOcrTable(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS order_id_card_ocr_attempts (
      order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
      attempted_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
      result VARCHAR(24) NOT NULL DEFAULT 'pending'
    )
  `)
}

export function isValidMainlandIdCard(value: string): boolean {
  const id = value.toUpperCase()
  if (!/^\d{17}[\dX]$/.test(id)) return false
  const year = Number(id.slice(6, 10))
  const month = Number(id.slice(10, 12))
  const day = Number(id.slice(12, 14))
  const birth = new Date(Date.UTC(year, month - 1, day))
  if (birth.getUTCFullYear() !== year || birth.getUTCMonth() !== month - 1 || birth.getUTCDate() !== day) return false
  if (year < 1900 || birth.getTime() > Date.now()) return false
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const checks = '10X98765432'
  const sum = weights.reduce((total, weight, index) => total + Number(id[index]) * weight, 0)
  return checks[sum % 11] === id[17]
}

function matchesMaskedId(masked: string, full: string): boolean {
  const normalized = masked.trim().toUpperCase().replace(/[＊●•]/g, '*')
  if (!normalized || !normalized.includes('*')) return true
  if (normalized.length !== 18) return false
  return [...normalized].every((char, index) => char === '*' || char === full[index])
}

function parseOcrResult(content: string): { name: string; idNumber: string } | null {
  try {
    const body = JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim())
    const name = String(body.name ?? '').trim().replace(/\s/g, '')
    const idNumber = String(body.idNumber ?? '').trim().toUpperCase().replace(/\s/g, '')
    return name && idNumber ? { name, idNumber } : null
  } catch {
    return null
  }
}

/** 幂等：只有附件和本地寰宇订单都已存在才占用一次自动识别机会。 */
export async function recognizeOrderIdCardOnce(prisma: PrismaClient, minio: Minio.Client, orderId: number): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: {
    source: true, sourceOrderNo: true, huanyuOrderNo: true, customerName: true
  } })
  if (!order || order.source !== 'taikang') return
  const attachments = (await prisma.orderAttachment.findMany({ where: { orderId, fileType: '40' }, orderBy: { id: 'asc' } }))
    .filter((attachment) => attachment.mimeType.startsWith('image/') && attachment.byteSize > 0 && attachment.byteSize <= 10 * 1024 * 1024)
  if (!attachments.length) return

  const rows = await prisma.$queryRawUnsafe<HuanyuIdentity[]>(`
    SELECT "DDBH", "JZR_ZJHM", "JZR_ZJLX", "JZR_XM"
    FROM "HY_FACT_DDCX_NEW"
    WHERE "DDBH" = $1 OR "BDQD_DDBH" = $2
    ORDER BY CASE WHEN "DDBH" = $1 THEN 0 ELSE 1 END
    LIMIT 1
  `, order.huanyuOrderNo || '', order.sourceOrderNo)
  const huanyu = rows[0]
  if (!huanyu || (huanyu.JZR_ZJLX && !['身份证', '儿童身份证'].includes(huanyu.JZR_ZJLX))) return
  const existing = (huanyu.JZR_ZJHM || '').trim()
  if (existing && !/[\*＊●•]/.test(existing)) return // 人工或既有完整值优先
  if (!process.env.HYYD_VLM_API_KEY?.trim() && !getEnv().dashscopeApiKey) return // 未配置模型凭证时保留机会

  const claimed = await prisma.$executeRawUnsafe(`
    INSERT INTO order_id_card_ocr_attempts (order_id) VALUES ($1)
    ON CONFLICT (order_id) DO NOTHING
  `, orderId)
  if (!claimed) return

  let result = 'rejected'
  try {
    const images: string[] = []
    for (const attachment of attachments.slice(0, 4)) {
      const stream = await minio.getObject(attachment.minioBucket, attachment.minioKey)
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.from(chunk))
      const buffer = Buffer.concat(chunks)
      if (buffer.length > 0 && buffer.length <= 10 * 1024 * 1024) {
        images.push(`data:${attachment.mimeType};base64,${buffer.toString('base64')}`)
      }
    }
    if (!images.length) return
    const response = await visionChat(
      '你只提取中国居民身份证人像面上的姓名和18位公民身份号码。国徽面不含号码，必须忽略。看不清或没有人像面时返回空字符串；不得猜测或补全。只返回 JSON 对象 {"name":"","idNumber":""}。',
      '这些是同一订单的身份证附件，请仅根据清晰的人像面提取姓名和身份证号码。',
      images,
      { temperature: 0, maxTokens: 120 }
    )
    const parsed = parseOcrResult(response.content)
    const expectedName = [huanyu.JZR_XM, order.customerName]
      .map((name) => (name || '').trim().replace(/\s/g, ''))
      .find((name) => name && !name.includes('*')) || ''
    if (!parsed || !isValidMainlandIdCard(parsed.idNumber) ||
        (expectedName && !expectedName.includes('*') && parsed.name !== expectedName) ||
        !matchesMaskedId(existing, parsed.idNumber)) return

    const updated = await prisma.$executeRawUnsafe(`
      UPDATE "HY_FACT_DDCX_NEW"
      SET "JZR_ZJHM" = $1
      WHERE "DDBH" = $2 AND (
        "JZR_ZJHM" IS NULL OR BTRIM("JZR_ZJHM") = '' OR "JZR_ZJHM" ~ '[*＊●•]'
      )
    `, parsed.idNumber, huanyu.DDBH)
    if (updated) result = 'saved'
  } catch {
    result = 'failed'
  } finally {
    await prisma.$executeRawUnsafe('UPDATE order_id_card_ocr_attempts SET result = $1 WHERE order_id = $2', result, orderId)
  }
}
