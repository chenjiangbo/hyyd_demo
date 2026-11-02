import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NativeChatMessage } from '@huanyu/shared-types'
import { reconcileConversationPendingMedia } from './native-chat-pending-media'

const message = (attachments: NativeChatMessage['attachments'], extra: Partial<NativeChatMessage> = {}): NativeChatMessage => ({
  channel: 'wechat', accountId: 'account', sourceConversationId: 'conversation',
  sourceMessageId: 'msg', direction: 'incoming', kind: 'file',
  occurredAt: '2026-11-01T00:00:00.000Z', observedAt: '2026-11-01T00:00:00.000Z',
  attachments, ...extra
})

test('clears only confirmed files while preserving undownloaded files and thumbnail retries', () => {
  const input = message([
    { sourceAttachmentId: 'file', kind: 'file', state: 'not_downloaded' },
    { sourceAttachmentId: 'missing', kind: 'file', state: 'not_downloaded' },
    { sourceAttachmentId: 'thumb', kind: 'image', state: 'not_downloaded', sourceMetadata: { nonThumbnailState: 'pending' } },
    { sourceAttachmentId: 'full', kind: 'image', state: 'not_downloaded', sourceMetadata: { nonThumbnailState: 'available' } },
    { sourceAttachmentId: 'large', kind: 'file', state: 'unsupported', sourceMetadata: { terminal: true } }
  ])
  const existing = { msg: ['file', 'missing', 'thumb', 'full', 'large'] }
  const confirmed = new Set(['msg\u001ffile', 'msg\u001fthumb', 'msg\u001ffull'])
  assert.deepEqual(reconcileConversationPendingMedia(existing, [input], confirmed), { msg: ['missing', 'thumb'] })
  assert.equal(existing.msg.length, 5)
})

test('confirmed nested attachment clears the parent message pending entry', () => {
  const child = message([{ sourceAttachmentId: 'file', kind: 'file', state: 'not_downloaded' }], { sourceMessageId: 'child', parentSourceMessageId: 'parent' })
  assert.deepEqual(reconcileConversationPendingMedia({ parent: ['file'] }, [child], new Set(['child\u001ffile'])), {})
  assert.deepEqual(reconcileConversationPendingMedia({ parent: ['file'] }, [child], new Set()), { parent: ['file'] })
})
