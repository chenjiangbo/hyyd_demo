import assert from 'node:assert/strict'
import { mkdtempSync, openSync, closeSync, ftruncateSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyAttachmentUploadLimit, MAX_ATTACHMENT_BYTES } from './native-chat-attachment-limit'

test('keeps message attachment metadata and permanently skips files above 30 MiB', () => {
  const attachment = { sourceAttachmentId: 'id', kind: 'file' as const, fileName: '合同.pdf', state: 'not_downloaded' as const, byteSize: MAX_ATTACHMENT_BYTES + 1 }
  const result = applyAttachmentUploadLimit(attachment)
  assert.equal(result.fileName, '合同.pdf')
  assert.equal(result.byteSize, MAX_ATTACHMENT_BYTES + 1)
  assert.equal(result.sourceMetadata?.terminal, true)
  assert.equal(result.sourceMetadata?.resolutionState, 'upload_size_exceeded')
  assert.equal(applyAttachmentUploadLimit({ ...attachment, byteSize: MAX_ATTACHMENT_BYTES }).state, 'not_downloaded')
})

test('uses actual local file size over source metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'attachment-limit-'))
  try {
    const path = join(directory, 'file')
    const fd = openSync(path, 'w')
    try { ftruncateSync(fd, MAX_ATTACHMENT_BYTES + 1) } finally { closeSync(fd) }
    const result = applyAttachmentUploadLimit({ sourceAttachmentId: 'id', kind: 'file', state: 'available', localPath: path, byteSize: 1 })
    assert.equal(result.byteSize, MAX_ATTACHMENT_BYTES + 1)
    assert.equal(result.localPath, undefined)
    assert.equal(result.sourceMetadata?.terminal, true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
