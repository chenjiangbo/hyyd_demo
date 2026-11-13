import assert from 'node:assert/strict'
import { isEscortSummaryEligibleText, escortSummaryVisibleText } from './escortSummaryEligibility.js'

const exactly80 = '陪诊小结' + '字'.repeat(76)
assert.equal(Array.from(exactly80).length, 80)
assert.equal(isEscortSummaryEligibleText(exactly80), false)
assert.equal(isEscortSummaryEligibleText(exactly80 + '字'), true)
assert.equal(isEscortSummaryEligibleText('陪诊总结' + '字'.repeat(77)), true)
assert.equal(isEscortSummaryEligibleText('陪诊过程' + '字'.repeat(77)), true)
assert.equal(isEscortSummaryEligibleText('陪诊小结' + ' '.repeat(300)), false)
assert.equal(isEscortSummaryEligibleText('其他消息' + '字'.repeat(100)), false)
const longMetadata = 'a'.repeat(300)
const note = (body: string) => `wxid_123:\n<?xml version="1.0"?><msg><des>${body.slice(0, 10)}</des><recorditem><![CDATA[<recordinfo><datalist><dataitem><datadesc>${body}</datadesc></dataitem><dataitem><cdndataurl>${longMetadata}</cdndataurl></dataitem></datalist></recordinfo>]]></recorditem></msg>`
assert.equal(isEscortSummaryEligibleText(note(exactly80)), false)
assert.equal(isEscortSummaryEligibleText(note(exactly80 + '字')), true)
assert.equal(escortSummaryVisibleText(note(exactly80)), exactly80)
assert.throws(() => isEscortSummaryEligibleText('<?xml version="1.0"?><msg><des>陪诊小结</msg>'), /XML/)
console.log('陪诊小结文字字数及微信笔记格式检查通过')
