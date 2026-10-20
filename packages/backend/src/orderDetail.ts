import { PrismaClient } from '@prisma/client'
import * as Minio from 'minio'

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
  attachments: AttachmentInput[]
  fingerprint?: string // 插件算的状态指纹，存下来供增量基线比对
  expectedEmployeeId?: number
  expectedBatchId?: string
}

export interface SaveDetailResult {
  orderId: number
  attachmentCount: number
  skipped: number
}

/**
 * 先逐张保存附件到 MinIO 与 DB，全部成功后才写详情完成时间和增量指纹。
 * 重试时 OrderAttachment 按 [orderId, fileId] upsert。
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
  if (input.expectedEmployeeId && order.assignedEmployeeId !== input.expectedEmployeeId) {
    throw new Error('详情订单归属与采集员工不一致')
  }

  let saved = 0
  let skipped = 0
  for (const att of input.attachments) {
    if (!att.base64 || !att.fileId) {
      throw new Error('附件缺少图片内容或文件 ID')
    }
    const buf = Buffer.from(att.base64, 'base64')
    if (buf.length === 0) {
      throw new Error('附件图片为空')
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

  // 附件全部保存后才写详情完成时间和指纹；失败重试不会留下虚假的增量基线。
  const completed = await prisma.order.updateMany({
    where: {
      id: order.id,
      ...(input.expectedEmployeeId ? { assignedEmployeeId: input.expectedEmployeeId } : {}),
      ...(input.expectedBatchId ? { rawJson: { path: ['collectionBatchId'], equals: input.expectedBatchId } } : {})
    },
    data: {
      detailJson: { ...input.detail, captureVersion: 2 } as any,
      detailFetchedAt: new Date(),
      ...(input.fingerprint ? { detailFingerprint: input.fingerprint } : {})
    }
  })
  if (completed.count !== 1) throw new Error('详情保存时订单归属发生变化')

  return { orderId: order.id, attachmentCount: saved, skipped }
}
