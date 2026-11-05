import assert from 'node:assert/strict'
import { parseUnderstoodImage, understandImage, IMAGE_UNDERSTANDING_PROMPT } from './imageUnderstanding.js'

const result = (imageType: unknown) => JSON.stringify({
  imageType, typeDescription: '', description: '图片内容', visibleText: '',
  visibleFields: [{ label: '姓名', value: '张三' }]
})

assert.equal(parseUnderstoodImage(result('住院病人卡片'), 'test').imageType, '住院病人卡片')
assert.equal(parseUnderstoodImage(result('滴滴打车订单截图'), 'test').imageType, '滴滴打车订单截图')
assert.equal(parseUnderstoodImage(result('挂号凭证'), 'test').imageType, '挂号凭证')
assert.throws(() => parseUnderstoodImage(result('  '), 'test'), /imageType 不能为空/)
assert.throws(() => parseUnderstoodImage(result(null), 'test'), /缺少字符串字段 imageType/)
assert.match(IMAGE_UNDERSTANDING_PROMPT, /imageType 必须准确写“挂号凭证”/)
async function run() {
  const savedFetch = globalThis.fetch
  const savedKey = process.env.HYYD_VLM_API_KEY
  process.env.HYYD_VLM_API_KEY = 'test-key'
  globalThis.fetch = async () => new Response(JSON.stringify({ model: 'test-model', choices: [{ message: { content: '不是 JSON 的原始返回' } }] }), { status: 200 })
  let recorded = ''
  try {
    await assert.rejects(understandImage('data:image/jpeg;base64,AA==', 'qwen3-vl-plus', async (response) => { recorded = response.content }), /没有返回 JSON/)
    assert.equal(recorded, '不是 JSON 的原始返回')
  } finally {
    globalThis.fetch = savedFetch
    if (savedKey === undefined) delete process.env.HYYD_VLM_API_KEY
    else process.env.HYYD_VLM_API_KEY = savedKey
  }
  console.log('imageUnderstanding: 图片类型与解析失败时保留原始返回通过')
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
