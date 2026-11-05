import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Module from 'node:module'

const root = mkdtempSync(join(tmpdir(), 'wechat-restart-'))
const resource = join(root, 'native-chat-collectors', 'wechat')
mkdirSync(resource, { recursive: true })
writeFileSync(join(resource, 'hyyd-wechat-collector.exe'), '')
const moduleApi = Module as unknown as { _load: (...args: unknown[]) => unknown }
const originalLoad = moduleApi._load
const originalNow = Date.now
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const resources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
let now = 1_000_000
let starts = 0
let child: EventEmitter
moduleApi._load = function (...args: unknown[]) {
  if (args[0] === 'electron') return { app: { isPackaged: true, getPath: () => root }, shell: {} }
  if (args[0] === './wxwork-context') return { resolveWxworkContext: () => { throw new Error('未启动') }, resolveWxworkContextAtRoot: () => { throw new Error('未启动') } }
  if (args[0] === 'child_process') {
    const real = originalLoad.apply(this, args) as Record<string, unknown>
    return { ...real, spawn: () => {
      starts++
      child = new EventEmitter()
      const stream = () => Object.assign(new EventEmitter(), { setEncoding: () => {}, write: () => true })
      Object.assign(child, { stdin: stream(), stdout: stream(), stderr: stream() })
      return child
    } }
  }
  return originalLoad.apply(this, args)
}
Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
Object.defineProperty(process, 'resourcesPath', { configurable: true, value: root })
Date.now = () => now
try {
  const { NativeChatCollectorManager } = require('./native-chat-collector-manager') as typeof import('./native-chat-collector-manager')
  const manager = new NativeChatCollectorManager() as unknown as { config: unknown; ensureChildren(): void; stop(): void }
  manager.config = { backendUrl: 'http://test', employeeCode: 'test' }
  manager.ensureChildren()
  assert.equal(starts, 1)
  child!.emit('exit', 1, null)
  now += 5_000
  manager.ensureChildren()
  assert.equal(starts, 1, 'other refreshes cannot bypass the restart delay')
  now += 54_999
  manager.ensureChildren()
  assert.equal(starts, 1)
  now += 1
  manager.ensureChildren()
  assert.equal(starts, 2, 'wechat starts again after one minute')
  manager.stop()
  console.log('wechat restart: repeated checks respect one-minute cooldown')
} finally {
  Date.now = originalNow
  Object.defineProperty(process, 'platform', platform)
  if (resources) Object.defineProperty(process, 'resourcesPath', resources)
  else Reflect.deleteProperty(process, 'resourcesPath')
  moduleApi._load = originalLoad
  rmSync(root, { recursive: true, force: true })
}
