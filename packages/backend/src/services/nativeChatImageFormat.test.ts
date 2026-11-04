import assert from 'node:assert/strict'
import { imageDataUrl } from './nativeChatImageAnalysis.js'

const formats: Array<[string, string]> = [
  ['ffd8ffe00000', 'image/jpeg'],
  ['89504e470d0a1a0a0000', 'image/png'],
  ['4749463839610000', 'image/gif'],
  ['424d0000', 'image/bmp'],
  ['524946460000000057454250', 'image/webp'],
]
for (const [hex, mime] of formats) {
  assert.ok(imageDataUrl(null, Buffer.from(hex, 'hex')).startsWith(`data:${mime};base64,`))
  assert.ok(imageDataUrl('image/jpeg', Buffer.from(hex, 'hex')).startsWith(`data:${mime};base64,`))
}
assert.throws(() => imageDataUrl(null, Buffer.from('not an image')), /无法识别图片文件格式/)
console.log('图片格式识别测试通过')
