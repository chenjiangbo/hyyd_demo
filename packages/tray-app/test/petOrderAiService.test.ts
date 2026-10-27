import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { PetOrderAiService, type PetOrderAiPanel } from '../src/main/pet-order-ai-service'

const origin = 'chrome-extension://akaojickfipoeobmiokkdbdaimeifmoa'

async function waitFor(predicate: () => boolean): Promise<void> {
  const until = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > until) throw new Error('等待面板更新超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('订单切换时旧 AI 结果不能覆盖新面板，关闭只作用于当前订单', async () => {
  const backend = createServer(async (request, response) => {
    if (request.url?.startsWith('/api/v1/dictionaries/huanyu/order-statuses')) {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: '1', name: '待跟进' }] }))
      return
    }
    const orderNo = new URL(request.url ?? '/', 'http://localhost').searchParams.get('orderNo')
    if (orderNo === 'HYYD000001') await new Promise((resolve) => setTimeout(resolve, 200))
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ data: { fields: { hospital: orderNo === 'HYYD000001' ? '旧医院' : '新医院' } } }))
  })
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve))
  const backendPort = (backend.address() as { port: number }).port
  const panels: PetOrderAiPanel[] = []
  const hidden: string[] = []
  const service = new PetOrderAiService(
    (panel) => panels.push(panel),
    (_id, panel) => panels.push(panel),
    (id) => hidden.push(id),
    43187
  )
  service.setConfig({ backendUrl: `http://127.0.0.1:${backendPort}`, employeeCode: 'TEST' })
  service.start()
  const first = randomUUID()
  const second = randomUUID()
  const send = (event: string, token: string, orderNo: string, formOrderNo = orderNo) => fetch('http://127.0.0.1:43187/pet/order-page', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, token, tabId: 1, orderNo, formOrderNo })
  })
  try {
    assert.equal((await send('open', first, 'HYYD000001')).status, 200)
    assert.equal((await send('open', second, 'HYYD000002')).status, 200)
    await waitFor(() => panels.some((panel) => panel.kind === 'form'))
    await new Promise((resolve) => setTimeout(resolve, 230))
    const form = panels.filter((panel) => panel.kind === 'form').at(-1)
    assert.equal(form?.id, `order-ai:${second}`)
    assert.equal(form?.fields?.find((field) => field.id === 'hospital')?.value, '新医院')
    assert.equal(panels.filter((panel) => panel.kind === 'form').length, 1)
    assert.equal((await send('close', first, 'HYYD000001')).status, 200)
    assert.equal(hidden.at(-1), `order-ai:${first}`)
    assert.equal((await send('close', second, 'HYYD000002')).status, 200)
    assert.equal(hidden.at(-1), `order-ai:${second}`)
  } finally {
    service.stop()
    await new Promise<void>((resolve) => backend.close(() => resolve()))
  }
})

test('本机精灵只向扩展提供当前后台的单站点配置', async () => {
  const site = { origin: 'http://hyhomecs.51zsyl.com:8081', listResourceId: 'LIST', detailResourceId: 'DETAIL' }
  const backend = createServer((request, response) => {
    assert.equal(request.url, '/api/v1/pet/order-site-config')
    assert.equal(request.headers['x-employee-code'], 'TEST')
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ data: { site } }))
  })
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve))
  const backendPort = (backend.address() as { port: number }).port
  const service = new PetOrderAiService(() => {}, () => {}, () => {}, 43188)
  service.setConfig({ backendUrl: `http://127.0.0.1:${backendPort}`, employeeCode: 'TEST' })
  service.start()
  try {
    const read = (from: string) => fetch('http://127.0.0.1:43188/pet/order-site-config', { headers: { Origin: from } })
    assert.equal((await read('https://example.com')).status, 403)
    const response = await read(origin)
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json() as { data: { site: unknown } }).data.site, site)
  } finally {
    service.stop()
    await new Promise<void>((resolve) => backend.close(() => resolve()))
  }
})

test('详情订单号不一致时阻止表单；最小化后恢复原面板', async () => {
  const panels: PetOrderAiPanel[] = []
  const suspended: string[] = []
  const resumed: string[] = []
  const service = new PetOrderAiService(
    (panel) => panels.push(panel),
    (_id, panel) => panels.push(panel),
    () => {}, 43189,
    (id) => suspended.push(id),
    (id) => resumed.push(id)
  )
  service.start()
  const send = (event: string, token: string, orderNo: string, formOrderNo: string) => fetch('http://127.0.0.1:43189/pet/order-page', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, token, tabId: 1, orderNo, formOrderNo })
  })
  const wrong = randomUUID()
  const correct = randomUUID()
  try {
    await send('open', wrong, 'HYYD000001', 'HYYD000002')
    assert.equal(panels.at(-1)?.kind, 'error')
    assert.match(panels.at(-1)?.text ?? '', /不一致/)

    await send('open', correct, 'HYYD000003', 'HYYD000003')
    const panelId = `order-ai:${correct}`
    assert.equal(panels.at(-1)?.id, panelId)
    await send('suspend', correct, 'HYYD000003', 'HYYD000003')
    assert.deepEqual(suspended, [panelId])
    await send('open', correct, 'HYYD000003', 'HYYD000003')
    assert.deepEqual(resumed, [panelId])
  } finally {
    service.stop()
  }
})
