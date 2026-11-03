import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nativeChatStoredBeijingTimeIsEligible, parseNativeChatImageAnalysisStartAt, validateOrderAiAutomationConfig } from './orderAiAutomationConfig.js'

test('image analysis start is fixed at the configured UTC instant', () => {
  assert.equal(parseNativeChatImageAnalysisStartAt({ startAt: '2026-11-02T12:00:00.000Z' }).toISOString(), '2026-11-02T12:00:00.000Z')
  for (const value of [undefined, {}, { startAt: '2026-11-02 20:00' }, { startAt: 'invalid' }]) {
    assert.throws(() => parseNativeChatImageAnalysisStartAt(value))
  }
})

test('Beijing database clock time switches exactly at 20:00', () => {
  const start = new Date('2026-11-02T12:00:00.000Z')
  assert.equal(nativeChatStoredBeijingTimeIsEligible(new Date('2026-11-02T19:59:59.999Z'), start), false)
  assert.equal(nativeChatStoredBeijingTimeIsEligible(new Date('2026-11-02T20:00:00.000Z'), start), true)
  assert.equal(nativeChatStoredBeijingTimeIsEligible(new Date('2026-11-02T20:00:00.001Z'), start), true)
})

test('existing image AI switch remains independently configurable', () => {
  assert.equal(validateOrderAiAutomationConfig({ imageAiEnabled: false, communicationSilenceMinutes: 5 }).imageAiEnabled, false)
  assert.equal(validateOrderAiAutomationConfig({ imageAiEnabled: true, communicationSilenceMinutes: 5 }).imageAiEnabled, true)
})
