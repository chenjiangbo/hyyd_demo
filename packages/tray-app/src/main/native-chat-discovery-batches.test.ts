import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Module from 'node:module'

async function run(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'hyyd-discovery-test-'))
  const moduleApi = Module as unknown as { _load: (...args: unknown[]) => unknown }
  const originalLoad = moduleApi._load
  moduleApi._load = function (...args: unknown[]) {
    if (args[0] === 'electron') return { app: { getPath: () => root }, shell: {} }
    return originalLoad.apply(this, args)
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NativeChatCollectorManager, sessionActivity, discoveryFingerprint, initialHistoryCursorMatches } = require('./native-chat-collector-manager') as typeof import('./native-chat-collector-manager')
    assert.equal(initialHistoryCursorMatches('wxwork', undefined, '{"sourceRowId":0}'), true)
    assert.equal(initialHistoryCursorMatches('wxwork', undefined, '{"sourceRowId":1}'), false)
    assert.equal(initialHistoryCursorMatches('wxwork', '{"sourceRowId":2}', '{"sourceRowId":0}'), false)
    assert.equal(initialHistoryCursorMatches('wechat', undefined, '{"sortSeq":0,"shard":"","localId":0}'), true)
    const now = Date.now()
    const baseSession = { channel: 'wechat' as const, accountId: 'account', sourceConversationId: 'activity', title: '护理', kind: 'single' as const }
    const old = { ...baseSession, sourceMetadata: { lastTime: Math.floor((now - 31 * 86400_000) / 1000) } }
    const recent = { ...baseSession, sourceMetadata: { lastTime: Math.floor(now / 1000) } }
    assert.equal(sessionActivity(old, now), 'inactive')
    assert.equal(sessionActivity(recent, now), 'recent')
    assert.notEqual(discoveryFingerprint(old), discoveryFingerprint(recent), 'new activity must make a dormant session discoverable again')
    assert.equal(sessionActivity({ ...baseSession, sourceMetadata: { activityStatus: 'no_messages' } }, now), 'inactive')
    assert.equal(sessionActivity({ ...baseSession, sourceMetadata: { activityStatus: 'unknown' } }, now), 'unknown')
    for (const lastTime of [null, undefined, 0, '0', '']) {
      const empty = { ...baseSession, sourceMetadata: { lastTime } }
      assert.equal(sessionActivity(empty, now), 'inactive')
      assert.notEqual(discoveryFingerprint(empty), discoveryFingerprint(recent), 'new messages must reactivate an empty conversation')
    }
    assert.equal(sessionActivity({ ...baseSession, sourceMetadata: { lastTime: 'invalid' } }, now), 'unknown')
    assert.equal(sessionActivity({ ...baseSession, channel: 'wxwork', sourceMetadata: { lastTime: null } }, now), 'unknown')
    const manager = new NativeChatCollectorManager() as unknown as {
      request: (...args: unknown[]) => Promise<unknown>
      logStructured: (...args: unknown[]) => void
      syncSelectedConversations: (sessions: unknown[], onConfirmed: (batch: unknown[]) => void) => Promise<void>
      config: { backendUrl: string; employeeCode: string }
      discoveryProgress: Map<string, { configVersion: string; confirmed: Map<string, string> }>
      persistDiscoveryProgress: () => void
      restoreDiscoveryProgress: () => void
    }
    const calls: Array<{ ids: string[]; syncId: string; startSnapshot: boolean; lastBatch: boolean }> = []
    let failed = false
    manager.logStructured = () => {}
    manager.request = async (_method, _path, body) => {
      const input = body as { sessions: Array<{ sourceConversationId: string }>; syncId: string; startSnapshot: boolean; lastBatch: boolean }
      calls.push({ ids: input.sessions.map((session) => session.sourceConversationId), syncId: input.syncId, startSnapshot: input.startSnapshot, lastBatch: input.lastBatch })
      if (input.sessions[0].sourceConversationId === '200' && !failed) { failed = true; throw new Error('temporary failure') }
      return { data: { discovered: input.sessions.length, persisted: input.sessions.length } }
    }
    const sessions = Array.from({ length: 450 }, (_, index) => ({ channel: 'wechat', accountId: 'account', sourceConversationId: String(index), title: '会话', kind: 'group' }))
    const confirmed: number[] = []
    await manager.syncSelectedConversations(sessions, (batch) => confirmed.push(batch.length))
    assert.deepEqual(calls.map((call) => call.ids.length), [200, 200, 200, 50])
    assert.deepEqual(calls[1].ids, calls[2].ids, 'only the failed batch is retried')
    assert.deepEqual(confirmed, [200, 200, 50], 'each successful batch is activated immediately')
    assert.equal(new Set(calls.map((call) => call.syncId)).size, 1)
    assert.deepEqual(calls.map((call) => call.startSnapshot), [true, false, false, false])
    assert.deepEqual(calls.map((call) => call.lastBatch), [false, false, false, true])
    manager.config = { backendUrl: 'http://test', employeeCode: 'employee' }
    manager.discoveryProgress.set('wechat', { configVersion: '1', confirmed: new Map([['session', 'fingerprint']]) })
    manager.persistDiscoveryProgress()
    const restarted = new NativeChatCollectorManager() as unknown as typeof manager
    restarted.config = manager.config
    restarted.restoreDiscoveryProgress()
    assert.equal(restarted.discoveryProgress.get('wechat')?.confirmed.get('session'), 'fingerprint', 'confirmed progress survives restart')
    const otherBackend = new NativeChatCollectorManager() as unknown as typeof manager
    otherBackend.config = { backendUrl: 'http://other', employeeCode: 'employee' }
    otherBackend.restoreDiscoveryProgress()
    assert.equal(otherBackend.discoveryProgress.size, 0, 'progress must not carry across backend identities')
    console.log('native chat discovery: batch retry, per-batch confirmation and shared snapshot passed')
  } finally {
    moduleApi._load = originalLoad
    rmSync(root, { recursive: true, force: true })
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
