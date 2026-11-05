import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Module from 'node:module'

async function run(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'image-confirmation-policy-'))
  const api = Module as unknown as { _load: (...args: unknown[]) => unknown }
  const originalLoad = api._load
  const originalFetch = globalThis.fetch
  api._load = function (...args: unknown[]) {
    if (args[0] === 'electron') return { app: { getPath: () => root }, shell: {} }
    return originalLoad.apply(this, args)
  }
  try {
    const { IMAGE_MATCH_CONFIRMATION_ENABLED } = require('./image-match-confirmation-policy') as typeof import('./image-match-confirmation-policy')
    const { NativeChatCollectorManager } = require('./native-chat-collector-manager') as typeof import('./native-chat-collector-manager')
    const { PetIntakeService } = require('./pet-intake-service') as typeof import('./pet-intake-service')
    assert.equal(IMAGE_MATCH_CONFIRMATION_ENABLED, false)
    const manager = new NativeChatCollectorManager() as unknown as { config: unknown; get: () => Promise<unknown>; refreshPendingImageMatches: () => Promise<void>; setImageMatchListener: (listener: () => void) => void }
    manager.config = { backendUrl: 'http://test', employeeCode: 'worker' }
    let fetched = 0
    let prompted = 0
    manager.get = async () => { fetched++; return { data: [] } }
    manager.setImageMatchListener(() => { prompted++ })
    await manager.refreshPendingImageMatches()
    assert.equal(fetched, 0, '暂停时不轮询聊天图片确认提示')
    assert.equal(prompted, 0)
    const enabledManager = new NativeChatCollectorManager(true) as unknown as typeof manager
    enabledManager.config = { backendUrl: 'http://test', employeeCode: 'worker' }
    enabledManager.get = async () => ({ data: [{ attachmentId: 1, imageUrl: 'http://test/image', candidateApplications: [] }] })
    enabledManager.setImageMatchListener(() => { prompted++ })
    await enabledManager.refreshPendingImageMatches()
    await enabledManager.refreshPendingImageMatches()
    assert.equal(prompted, 1, '恢复后待确认图片重新提示，同一图片不重复通知')

    const source = join(root, 'voucher.png')
    writeFileSync(source, Buffer.from('test image'))
    let nextRecord = 0
    let uploads = 0
    let mode: 'ambiguous' | 'matched' = 'ambiguous'
    globalThis.fetch = async (url) => {
      if (String(url).includes('/materials')) { uploads++; return new Response(JSON.stringify({ data: { id: uploads } }), { status: 200 }) }
      nextRecord++
      const application = { applicationNo: 'APP1', programEvidence: [], orders: [{ orderId: 10, sourceOrderNo: 'X', customerName: '客户', serviceType: null, hospital: null, department: null, doctor: null, appointmentDate: null, status: '' }] }
      return new Response(JSON.stringify({ data: { analysisRecordId: nextRecord,
        image: { imageType: '挂号凭证', typeDescription: '', description: '', visibleText: '', visibleFields: [] },
        registrationMatch: { applicationNo: mode === 'matched' ? 'APP1' : null, applicationDecision: mode === 'matched' ? 'matched' : 'ambiguous', orderId: mode === 'matched' ? 10 : null, orderDecision: mode === 'matched' ? 'matched' : 'ambiguous', reason: '', candidateApplications: [application] }
      } }), { status: 200 })
    }
    const paused = new PetIntakeService()
    paused.setConfig({ backendUrl: 'http://test', employeeCode: 'worker' })
    assert.equal((await paused.processFile(source)).state, 'done')
    assert.equal((await paused.processFile(source)).state, 'done')
    assert.equal(paused.getPendingStatus(), null)
    assert.equal(readdirSync(join(root, 'pet-inbox')).filter((name) => name.endsWith('.pending.json')).length, 2, '不确定结果逐条保留')
    mode = 'matched'
    assert.equal((await paused.processFile(source)).state, 'done')
    assert.equal(uploads, 1, '明确匹配仍自动保存到订单')

    const resumed = new PetIntakeService(true)
    resumed.setConfig({ backendUrl: 'http://test', employeeCode: 'worker' })
    assert.equal(resumed.getPendingStatus()?.state, 'candidates')
    assert.equal((await resumed.selectOrder(10, 'APP1')).state, 'candidates', '恢复后继续处理下一条')
    assert.equal((await resumed.selectOrder(10, 'APP1')).state, 'done')
    assert.equal(resumed.getPendingStatus(), null)
    assert.equal(uploads, 3)
    console.log('image confirmation: paused prompts, preserved pending records and automatic matching passed')
  } finally {
    globalThis.fetch = originalFetch
    api._load = originalLoad
    rmSync(root, { recursive: true, force: true })
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
