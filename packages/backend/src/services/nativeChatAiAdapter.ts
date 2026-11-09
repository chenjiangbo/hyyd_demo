import type { PrismaClient } from '@prisma/client'

export type NativeChatAiMessage = {
  id: number
  sourceRef: string
  channel: string
  senderName: string | null
  senderId: string | null
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

function senderIdentity(channel: string, senderId: string | null, sourceMetadata: unknown): string | null {
  if (channel !== 'wechat') return senderId
  const metadata = metadataRecord(sourceMetadata)
  const username = typeof metadata?.senderUsername === 'string' ? metadata.senderUsername.trim() : ''
  if (username) return username
  const shard = typeof metadata?.shard === 'string' ? metadata.shard.trim() : ''
  return senderId && shard ? `${shard}:${senderId}` : senderId
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
      senderId: senderIdentity(row.conversation.channel, row.senderId, row.sourceMetadata),
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

/** Order-field AI reads only individually linked native messages and proof attachments. */
export async function loadNativeChatFieldAiBatch(
  prisma: PrismaClient,
  applicationNo: string | null,
  orderId: number
): Promise<NativeChatAiBatch> {
  const messageRows = await prisma.nativeChatMessage.findMany({
    where: {
      applicationLinkStatus: 'matched',
      OR: [
        ...(applicationNo ? [{ applicationNo, orderId: null }] : []),
        { orderId }
      ]
    },
    include: {
      conversation: { select: { channel: true } },
      attachments: { orderBy: { id: 'asc' } }
    },
    orderBy: [{ occurredAt: 'asc' }, { sourceItemIndex: 'asc' }, { id: 'asc' }]
  })
  const attachmentRows = await prisma.nativeChatAttachment.findMany({
    where: {
      applicationLinkStatus: 'matched',
      kind: 'image',
      orderId,
      OR: ['挂号凭证', '就诊签到记录'].map((imageType) => ({ sourceMetadata: { path: ['imageAnalysis', 'imageType'], equals: imageType } }))
    },
    include: { message: { include: { conversation: { select: { channel: true } } } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
  })

  let latestChangedAt: Date | null = null
  const messages: NativeChatAiMessage[] = []
  const voucherAttachmentIds = new Set(attachmentRows.map((row) => row.id))
  for (const row of messageRows) {
    const changedAt = [row.observedAt, row.applicationLinkedAt, ...row.attachments.map((attachment) => attachment.updatedAt)]
      .filter((value): value is Date => value !== null)
      .reduce((latest, value) => value > latest ? value : latest, row.observedAt)
    if (!latestChangedAt || changedAt > latestChangedAt) latestChangedAt = changedAt
    const evidence = [row.text?.trim() || null]
    for (const attachment of row.attachments) {
      // A registration voucher is a separately linked business material. Never
      // leak an unmatched voucher's OCR text into the containing message.
      const metadata = metadataRecord(attachment.sourceMetadata)
      const analysis = metadataRecord(metadata?.imageAnalysis)
      if (attachment.kind === 'image' && (analysis?.imageType === '挂号凭证' || analysis?.imageType === '就诊签到记录')) continue
      if (voucherAttachmentIds.has(attachment.id)) continue
      evidence.push(attachmentEvidence(attachment))
    }
    if (!evidence.some(Boolean)) evidence.push('（无文本或附件内容）')
    messages.push({
      id: row.id,
      sourceRef: `原生消息#${row.id}`,
      channel: row.conversation.channel,
      senderName: row.senderName,
      senderId: senderIdentity(row.conversation.channel, row.senderId, row.sourceMetadata),
      direction: row.direction,
      messageKind: row.kind,
      sourceTypeCode: row.sourceTypeCode,
      sourceItemIndex: row.sourceItemIndex,
      contentText: evidence.filter((value): value is string => Boolean(value)).join('\n'),
      occurredAt: row.occurredAt,
      changedAt
    })
  }

  for (const attachment of attachmentRows) {
    const changedAt = [attachment.updatedAt, attachment.applicationLinkedAt, attachment.message.observedAt]
      .filter((value): value is Date => value !== null)
      .reduce((latest, value) => value > latest ? value : latest, attachment.updatedAt)
    if (!latestChangedAt || changedAt > latestChangedAt) latestChangedAt = changedAt
    const analysis = metadataRecord(metadataRecord(attachment.sourceMetadata)?.imageAnalysis)
    const fields = Array.isArray(analysis?.visibleFields)
      ? analysis.visibleFields.map((value) => {
        const field = metadataRecord(value)
        return field && typeof field.label === 'string' && typeof field.value === 'string'
          ? `${field.label}=${field.value}`
          : null
      }).filter((value): value is string => Boolean(value))
      : []
    const manager = metadataRecord(metadataRecord(analysis?.registrationMatch)?.managerResolution)
    const contentText = [
      `独立${analysis?.imageType === '就诊签到记录' ? '就诊签到记录' : '挂号凭证'}素材`,
      attachment.fileName ? `文件名=${attachment.fileName}` : null,
      typeof analysis?.description === 'string' ? `图片描述=${analysis.description}` : null,
      typeof analysis?.visibleText === 'string' ? `图片文字=${analysis.visibleText}` : null,
      fields.length ? `识别字段=${fields.join('；')}` : null,
      typeof manager?.applicationNo === 'string' ? `人工确认申领号=${manager.applicationNo}` : null,
      typeof manager?.orderId === 'number' ? `人工确认订单=${manager.orderId}` : null
    ].filter(Boolean).join('\n')
    messages.push({
      id: -2_000_000_000 - attachment.id,
      sourceRef: `挂号凭证素材#${attachment.id}`,
      channel: attachment.message.conversation.channel,
      senderName: attachment.message.senderName,
      senderId: senderIdentity(attachment.message.conversation.channel, attachment.message.senderId, attachment.message.sourceMetadata),
      direction: 'system',
      messageKind: 'registration_proof',
      sourceTypeCode: null,
      sourceItemIndex: attachment.message.sourceItemIndex,
      contentText,
      occurredAt: attachment.message.occurredAt,
      changedAt
    })
  }
  messages.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id - b.id)
  return { messages, latestChangedAt }
}
