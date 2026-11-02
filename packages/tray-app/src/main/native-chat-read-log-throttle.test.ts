import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NativeChatReadLogThrottle } from './native-chat-read-log-throttle'

test('idle read logs are limited independently per conversation and report suppressed entries', () => {
  const throttle = new NativeChatReadLogThrottle(300_000)
  assert.equal(throttle.take('wechat-account-session-a', 1_000), 0)
  assert.equal(throttle.take('wechat-account-session-a', 2_000), null)
  assert.equal(throttle.take('wechat-account-session-b', 2_000), 0)
  assert.equal(throttle.take('wechat-account-session-a', 300_999), null)
  assert.equal(throttle.take('wechat-account-session-a', 301_000), 2)
})
