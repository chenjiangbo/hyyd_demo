import assert from 'node:assert/strict'
import { wxgfImagePartition } from './nativeChatWxgf.js'

function container(parts: Buffer[]): Buffer {
  const header = Buffer.concat([Buffer.from('wxgf'), Buffer.from([8, 0, 0, 0])])
  return Buffer.concat([header, ...parts.flatMap((part) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(part.length)
    return [length, part]
  })])
}

const marker = Buffer.from([0, 0, 0, 1])
const mask = Buffer.concat([marker, Buffer.alloc(10, 1)])
const image = Buffer.concat([marker, Buffer.alloc(100, 2)])
assert.deepEqual(wxgfImagePartition(container([mask, image])), image)
assert.deepEqual(wxgfImagePartition(container([image])), image)
assert.throws(() => wxgfImagePartition(container([image, image])), /多帧/)
assert.throws(() => wxgfImagePartition(Buffer.from('wxgf\x08bad')), /有效|未找到/)
console.log('WXGF partition selection passed')
