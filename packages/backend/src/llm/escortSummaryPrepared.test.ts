import assert from 'node:assert/strict'
import { addDirectEscortSummary, resolveDirectEscortSummary, usePreparedEscortSummaries, type OrderAiFieldCandidate, type OrderAiSourceMessage } from './orderAiExtraction.js'
const message: OrderAiSourceMessage = { id: 1, sourceRef: '原生消息#1', channel: 'wechat', senderName: null, contentText: '原始消息', preparedEscortSummary: '首次 AI 提炼的完整小结', occurredAt: new Date() }
const candidate: OrderAiFieldCandidate = { huanyuOrderNo: 'HYYD123456', fieldCode: 'escort_service_summary', fieldLabel: '陪诊服务小结', value: '订单 AI 的改写', normalizedValue: '订单 AI 的改写', candidateType: 'new_or_confirmed', confidence: 0.9, requiresConfirmation: false, evidence: [{ sourceId: '原生消息#1' }] }
assert.equal(usePreparedEscortSummaries([candidate], [message])[0].value, message.preparedEscortSummary)
assert.throws(() => usePreparedEscortSummaries([candidate], [{ ...message, preparedEscortSummary: undefined }]), /未能唯一对应/)
const linked = [{ linkedOrderId: 42, sourceRef: '原生消息#1', preparedEscortSummary: '首次提炼的结果' }]
const direct = resolveDirectEscortSummary(42, 'COD1', [{ orderNo: 'HYYD123456', bOrderNo: 'COD1' }], linked)
assert.equal(direct?.huanyuOrderNo, 'HYYD123456')
assert.equal(addDirectEscortSummary([], direct)[0].value, '首次提炼的结果')
assert.equal(addDirectEscortSummary([candidate], direct).length, 1)
assert.equal(resolveDirectEscortSummary(42, 'COD1', [{ orderNo: 'HYYD123456', bOrderNo: 'COD1' }, { orderNo: 'HYYD987654', bOrderNo: 'COD1' }], linked), undefined)
assert.equal(resolveDirectEscortSummary(42, 'COD1', [{ orderNo: 'HYYD123456', bOrderNo: 'COD2' }], linked), undefined)
assert.equal(resolveDirectEscortSummary(42, 'COD1', [{ orderNo: 'HYYD123456', bOrderNo: 'COD1' }], [{ ...linked[0], linkedOrderId: 43 }]), undefined)
console.log('订单字段 AI 直接使用首次提炼的小结通过')
