import type { NativeChatMessage } from '@huanyu/shared-types'

/** Update the pending list only after the backend has confirmed the message and its uploads. */
export function reconcileConversationPendingMedia(
  conversation: Record<string, string[]>,
  messages: NativeChatMessage[],
  confirmedUploads: ReadonlySet<string>
): Record<string, string[]> {
  const result = { ...conversation }
  for (const message of messages) {
    const rootMessageId = message.parentSourceMessageId ?? message.sourceMessageId
    const pending = new Set(result[rootMessageId] ?? [])
    for (const attachment of message.attachments ?? []) {
      const attachmentId = attachment.sourceAttachmentId
      if (!attachmentId) throw new Error(`附件缺少来源 ID：${message.sourceMessageId}`)
      if (attachment.sourceMetadata?.terminal === true) {
        pending.delete(attachmentId)
        continue
      }
      const fullImagePending = attachment.kind === 'image' && attachment.sourceMetadata?.nonThumbnailState !== 'available'
      const confirmed = confirmedUploads.has(`${message.sourceMessageId}\u001f${attachmentId}`)
      if (fullImagePending) pending.add(attachmentId)
      else if (confirmed || attachment.localPath || attachment.state === 'available') pending.delete(attachmentId)
      else if (attachment.state === 'not_downloaded') pending.add(attachmentId)
      else if (attachment.state === 'ambiguous' || attachment.sourceMetadata?.resolutionState === 'invalid_resource_metadata') pending.add(attachmentId)
    }
    if (pending.size) result[rootMessageId] = [...pending].sort()
    else delete result[rootMessageId]
  }
  return result
}
