import { PrismaClient } from '@prisma/client'
import * as Minio from 'minio'

export const ATTACHMENT_BUCKET = 'order-attachments'

export interface DetailBundle {
  caseInfo?: any
  intendClinicInfo?: any
  latestRegisterInfo?: any
  hospitalAddr?: any
  exceInfo?: any
}

export interface AttachmentInput {
  fileType: string
  fileId: string
  fileName: string
  mimeType: string
  base64: string
  rawJson?: any
}

export interface SaveDetailInput {
  sourceOrderNo: string
  source?: string // 默认 'taikang'
  detail: DetailBundle
  attachments: AttachmentInput[]
}

export interface SaveDetailResult {
  orderId: number
  attachmentCount: number
  skipped: number
}

/**
 * 把插件回传的"订单详情 + 附件"写入 DB + MinIO。
 * - detail 整体写入 Order.detailJson
 * - 每张附件 base64 解码后 putObject 到 MinIO，OrderAttachment 按 [orderId, fileId] upsert
 */
export async function saveOrderDetailBundle(
  prisma: PrismaClient,
  minioClient: Minio.Client,
  input: SaveDetailInput
): Promise<SaveDetailResult> {
  const source = input.source ?? 'taikang'
  const order = await prisma.order.findUnique({
    where: { source_sourceOrderNo: { source, sourceOrderNo: input.sourceOrderNo } }
  })
  if (!order) {
    throw new Error(`订单不存在: source=${source} sourceOrderNo=${input.sourceOrderNo}`)
  }

  await prisma.order.update({
    where: { id: order.id },
    data: {
      detailJson: input.detail as any,
      detailFetchedAt: new Date()
    }
  })

  let saved = 0
  let skipped = 0
  for (const att of input.attachments) {
    if (!att.base64 || !att.fileId) {
      skipped++
      continue
    }
    const buf = Buffer.from(att.base64, 'base64')
    if (buf.length === 0) {
      skipped++
      continue
    }
    const ext = att.fileName.split('.').pop() || 'bin'
    const minioKey = `orders/${order.id}/${att.fileType}/${att.fileId}.${ext}`
    await minioClient.putObject(ATTACHMENT_BUCKET, minioKey, buf, buf.length, {
      'Content-Type': att.mimeType
    })

    await prisma.orderAttachment.upsert({
      where: { orderId_fileId: { orderId: order.id, fileId: String(att.fileId) } },
      update: {
        fileType: att.fileType,
        fileName: att.fileName,
        mimeType: att.mimeType,
        minioBucket: ATTACHMENT_BUCKET,
        minioKey,
        byteSize: buf.length,
        rawJson: att.rawJson ?? undefined
      },
      create: {
        orderId: order.id,
        fileType: att.fileType,
        fileId: String(att.fileId),
        fileName: att.fileName,
        mimeType: att.mimeType,
        minioBucket: ATTACHMENT_BUCKET,
        minioKey,
        byteSize: buf.length,
        rawJson: att.rawJson ?? undefined
      }
    })
    saved++
  }

  return { orderId: order.id, attachmentCount: saved, skipped }
}
