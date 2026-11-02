import { statSync } from 'fs'
import type { NativeChatAttachment } from '@huanyu/shared-types'

export const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024

export function applyAttachmentUploadLimit(attachment: NativeChatAttachment): NativeChatAttachment {
  const bytes = attachment.localPath ? statSync(attachment.localPath).size : attachment.byteSize
  if (bytes == null || bytes <= MAX_ATTACHMENT_BYTES) return attachment
  const { localPath: _localPath, ...metadata } = attachment
  return {
    ...metadata,
    byteSize: bytes,
    state: 'unsupported',
    sourceMetadata: {
      ...attachment.sourceMetadata,
      resolutionState: 'upload_size_exceeded',
      terminal: true,
      ...(attachment.kind === 'image' ? { nonThumbnailState: 'expired' } : {})
    }
  }
}
