import type { PrismaClient } from '@prisma/client'

export type NativeChatAiMessage = {
  id: number
  sourceRef: string
  channel: string
  senderName: string | null
  direction: string
  messageKind: string
  sourceTypeCode: string | null
  sourceItemIndex: number | null
  contentText: string
  occurredAt: Date
  changedAt: Date
}

export type NativeChatAiBatch = {
  messages: NativeChatAiMessage[]
  latestChangedAt: Date | null
}

const ATTACHMENT_LABELS: Record<string, string> = {
  image: '图片',
  file: '文件',
  video: '视频',
  audio: '音频',
  voice: '语音',
  other: '附件'
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function imageAnalysisLabel(sourceMetadata: unknown): string | null {
  const metadata = metadataRecord(sourceMetadata)
  const analysis = metadataRecord(metadata?.imageAnalysis)
  if (analysis?.status !== 'completed') return null
  const kind = typeof analysis.imageType === 'string' ? analysis.imageType.trim() : ''
  const summary = typeof analysis.description === 'string' ? analysis.description.trim() : ''
  const visibleText = typeof analysis.visibleText === 'string' ? analysis.visibleText.trim() : ''
  const visibleFields = Array.isArray(analysis.visibleFields)
    ? analysis.visibleFields.map((value) => {
      const field = metadataRecord(value)
      if (!field || typeof field.label !== 'string' || typeof field.value !== 'string') return null
      return `${field.label}=${field.value}`
    }).filter((value): value is string => Boolean(value))
    : []
  const match = metadataRecord(analysis.registrationMatch)
  const matchSummary = match?.status === 'completed'
    ? [
      typeof match.applicationNo === 'string' ? `申领号候选=${match.applicationNo}` : null,
      typeof match.orderId === 'number' ? `订单候选 ID=${match.orderId}` : null,
      typeof match.reason === 'string' && match.reason.trim() ? `匹配说明=${match.reason.trim()}` : null
    ].filter(Boolean).join('；')
    : ''
  const managerResolution = metadataRecord(match?.managerResolution)
  const managerResolutionSummary = managerResolution?.status === 'manager_confirmed'
    ? [
      typeof managerResolution.applicationNo === 'string' ? `经理确认申领号=${managerResolution.applicationNo}` : null,
      typeof managerResolution.orderId === 'number' ? `经理确认订单 ID=${managerResolution.orderId}` : '经理尚未确认具体订单'
    ].filter(Boolean).join('；')
    : ''
  return [
    kind ? `类型=${kind}` : '',
    summary ? `描述=${summary}` : '',
    visibleText ? `可见文字=${visibleText}` : '',
    visibleFields.length ? `可见字段=${visibleFields.join('；')}` : '',
    matchSummary,
    managerResolutionSummary
  ].filter(Boolean).join('；') || null
}

function attachmentEvidence(attachment: {
  kind: string
  fileName: string | null
  mimeType: string | null
  byteSize: bigint | null
  state: string
  sourceMetadata: unknown
}): string {
  const parts = [`类型=${ATTACHMENT_LABELS[attachment.kind] ?? attachment.kind}`]
  if (attachment.fileName?.trim()) parts.push(`名称=${attachment.fileName.trim()}`)
  if (attachment.mimeType?.trim()) parts.push(`格式=${attachment.mimeType.trim()}`)
  if (attachment.byteSize !== null) parts.push(`大小=${attachment.byteSize.toString()} 字节`)
  parts.push(`状态=${attachment.state}`)
  const imageLabel = attachment.kind === 'image' ? imageAnalysisLabel(attachment.sourceMetadata) : null
  if (imageLabel) parts.push(`图片识别=${imageLabel}`)
  return `附件（${parts.join('；')}）`
}

/** Load all linked native messages for an application and express their metadata as text evidence for existing AI inputs. */
export async function loadNativeChatAiBatch(
  prisma: PrismaClient,
  applicationNo: string | null
): Promise<NativeChatAiBatch> {
  if (!applicationNo) return { messages: [], latestChangedAt: null }

  const rows = await prisma.nativeChatMessage.findMany({
    where: { conversation: { applicationNo, applicationLinkStatus: 'matched' } },
    include: {
      conversation: { select: { channel: true, applicationLinkedAt: true } },
      attachments: { orderBy: { id: 'asc' } }
    },
    orderBy: [{ occurredAt: 'asc' }, { sourceItemIndex: 'asc' }, { id: 'asc' }]
  })

  let latestChangedAt: Date | null = null
  const messages = rows.map((row) => {
    const changedAt = [row.observedAt, row.conversation.applicationLinkedAt, ...row.attachments.map((attachment) => attachment.updatedAt)]
      .filter((value): value is Date => value !== null)
      .reduce((latest, value) => value > latest ? value : latest, row.observedAt)
    if (!latestChangedAt || changedAt > latestChangedAt) latestChangedAt = changedAt

    const evidence = [
      row.text?.trim() || null,
      ...(row.attachments ?? []).map(attachmentEvidence)
    ].filter((value): value is string => Boolean(value))
    if (evidence.length === 0) evidence.push('（无文本或附件内容）')

    return {
      id: row.id,
      sourceRef: `原生消息#${row.id}`,
      channel: row.conversation.channel,
      senderName: row.senderName,
      direction: row.direction,
      messageKind: row.kind,
      sourceTypeCode: row.sourceTypeCode,
      sourceItemIndex: row.sourceItemIndex,
      contentText: evidence.join('\n'),
      occurredAt: row.occurredAt,
      changedAt
    }
  })

  return { messages, latestChangedAt }
}
