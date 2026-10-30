import { PrismaClient } from '@prisma/client'
import * as Minio from 'minio'
import { enqueueGreenPassIdCardOcr } from './services/greenPassIdCardOcr.js'

export const ATTACHMENT_BUCKET = 'order-attachments'

// 插件抓详情统一只调 recommendations 接口，所有绿通业务返回结构一致的大对象，
// 已全量塞进来。旧的 caseInfo / intendClinicInfo / hospitalAddr / exceInfo
// 子结构都是 recommendations 内部字段，无需单独建顶层属性。
export interface DetailBundle {
  recommendations?: any
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
  expectedEmployeeId?: number
  expectedBatchId?: string
}

export interface SaveDetailResult {
  orderId: number
}

export interface SaveOrderAttachmentsInput {
  sourceOrderNo: string
  source?: string
  attachments: AttachmentInput[]
  attachmentsComplete: boolean
  fingerprint: string
  expectedEmployeeId?: number
  expectedBatchId?: string
  enqueueGreenPassIdCard?: boolean
}

export interface SaveOrderAttachmentsResult {
  orderId: number
  attachmentCount: number
  skipped: number
  attachmentsComplete: boolean
}

/**
 * 只保存 recommendations 详情正文。附件由独立事件异步保存，不阻挡正文保存与远程建单。
 */
export async function saveOrderDetailBundle(
  prisma: PrismaClient,
  input: SaveDetailInput
): Promise<SaveDetailResult> {
  const source = input.source ?? 'taikang'
  const order = await prisma.order.findUnique({
    where: { source_sourceOrderNo: { source, sourceOrderNo: input.sourceOrderNo } }
  })
  if (!order) {
    throw new Error(`订单不存在: source=${source} sourceOrderNo=${input.sourceOrderNo}`)
  }
  if (input.expectedEmployeeId && order.assignedEmployeeId !== input.expectedEmployeeId) {
    throw new Error('详情订单归属与采集员工不一致')
  }

  const saved = await prisma.order.updateMany({
    where: {
      id: order.id,
      ...(input.expectedEmployeeId ? { assignedEmployeeId: input.expectedEmployeeId } : {}),
      ...(input.expectedBatchId ? { rawJson: { path: ['collectionBatchId'], equals: input.expectedBatchId } } : {})
    },
    data: {
      detailJson: { ...input.detail, captureVersion: 2 } as any,
      detailFetchedAt: new Date()
    }
  })
  if (saved.count !== 1) throw new Error('详情保存时订单归属发生变化')
  return { orderId: order.id }
}

/** 附件独立保存；失败时不写入新指纹，插件后续可重抓并重传。 */
export async function saveOrderAttachments(
  prisma: PrismaClient,
  minioClient: Minio.Client,
  input: SaveOrderAttachmentsInput
): Promise<SaveOrderAttachmentsResult> {
  const source = input.source ?? 'taikang'
  const order = await prisma.order.findUnique({
    where: { source_sourceOrderNo: { source, sourceOrderNo: input.sourceOrderNo } }
  })
  if (!order) throw new Error(`订单不存在: source=${source} sourceOrderNo=${input.sourceOrderNo}`)
  if (input.expectedEmployeeId && order.assignedEmployeeId !== input.expectedEmployeeId) {
    throw new Error('附件订单归属与采集员工不一致')
  }

  let saved = 0
  let skipped = 0
  let attachmentsComplete = input.attachmentsComplete
  for (const att of input.attachments) {
    try {
      if (!att.base64 || !att.fileId) throw new Error('附件缺少图片内容或文件 ID')
      const buf = Buffer.from(att.base64, 'base64')
      if (buf.length === 0) throw new Error('附件图片为空')
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
    } catch (error) {
      attachmentsComplete = false
      skipped++
      console.warn(`[orderDetail] attachment save failed for order ${order.id}:`, error)
    }
  }

  // 仅在详情正文与附件均完整落库后推进指纹；否则插件会在下一轮重试。
  if (attachmentsComplete) {
    await prisma.$transaction(async (tx) => {
      const fingerprintSaved = await tx.order.updateMany({
        where: {
          id: order.id,
          ...(input.expectedEmployeeId ? { assignedEmployeeId: input.expectedEmployeeId } : {}),
          ...(input.expectedBatchId ? { rawJson: { path: ['collectionBatchId'], equals: input.expectedBatchId } } : {})
        },
        data: { detailFingerprint: input.fingerprint }
      })
      if (fingerprintSaved.count !== 1) throw new Error('保存详情指纹时订单归属发生变化')
      if (input.enqueueGreenPassIdCard) await enqueueGreenPassIdCardOcr(tx, order.id)
    })
  }

  return { orderId: order.id, attachmentCount: saved, skipped, attachmentsComplete }
}
