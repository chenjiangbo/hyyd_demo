import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { PetOrderAiService, type PetOrderAiPanel } from '../src/main/pet-order-ai-service'

const origin = 'chrome-extension://akaojickfipoeobmiokkdbdaimeifmoa'

test('平安精灵使用 ABI 值优先，未匹配名称参与建档核对', async () => {
  const order = { sourceOrderNo: 'PA-001', channel: '', channelService: '', orderAmount: '', hospital: '', hospitalAddress: '', department: '', doctor: '', orderStatus: '待预约', escortSummary: '' }
  const medical = { hospital: { id: '0001', name: '标准医院' }, address: { id: '000101', name: '标准地址' }, department: { id: null, name: '感染科' }, doctor: { id: null, name: '平安医生' } }
  let submitted: any
  const backend = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url?.startsWith('/api/v1/pet/order-current')) return void res.end(JSON.stringify({ data: { order, escorts: [], pinganMedical: medical } }))
    if (req.url?.startsWith('/api/v1/pet/order-ai-fields')) return void res.end(JSON.stringify({ data: { fields: { hospital: '泰康候选' }, intention: {} } }))
    if (req.url === '/api/v1/pet/huanyu-order-update') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => { submitted = JSON.parse(body); res.end(JSON.stringify({ ok: true, escortIds: [] })) })
      return
    }
    res.end(JSON.stringify({ data: [] }))
  })
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
  const panels: PetOrderAiPanel[] = []
  const service = new PetOrderAiService(p => panels.push(p), (_id, p) => panels.push(p), () => {}, 43198)
  service.setConfig({ backendUrl: `http://127.0.0.1:${(backend.address() as { port: number }).port}`, employeeCode: 'TEST' })
  service.start()
  const token = randomUUID()
  try {
    await fetch('http://127.0.0.1:43198/pet/order-page', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'open', token, tabId: 1, orderNo: 'HYYD000001', formOrderNo: 'HYYD000001' }) })
    await waitFor(() => panels.some(p => p.kind === 'form'))
    const panel = panels.filter(p => p.kind === 'form').at(-1)!
    const field = (id: string) => panel.fields?.find(f => f.id === id)
    assert.equal(field('hospital')?.value, '0001')
    assert.equal(field('hospitalAddress')?.value, '000101')
    assert.equal(field('department')?.value, '感染科')
    assert.equal(field('doctor')?.value, '平安医生')
    assert.equal(field('doctor')?.hint, undefined)
    await service.handlePanelAction(`order-ai:${token}`, 'one-click-fill', Object.fromEntries((panel.fields ?? []).map(f => [f.id, f.value])))
    assert.equal(submitted.fields.hospital, '0001')
    assert.equal(submitted.fields.department, '感染科')
    assert.equal(submitted.fields.doctor, '平安医生')
    assert.equal(submitted.expectedOrder.hospital, '')
  } finally { service.stop(); await new Promise<void>(resolve => backend.close(() => resolve())) }
})

test('平安精灵不在 ABI 已选其他医院时补入原匹配科室', async () => {
  const { pinganMedicalFields } = await import('../src/main/pingan-medical-fields')
  const item = (id: string | null, name: string) => ({ id, name })
  const medical = { hospital: item('1', '原医院'), address: item('11', '原地址'), department: item('12', '原科室'), doctor: item('13', '原医生') }
  const result = pinganMedicalFields({ hospital: '2', department: '已选科室' }, medical)
  assert.equal(result.hospital.value, '2')
  assert.equal(result.department.value, '已选科室')
  assert.equal(result.hospitalAddress.value, '')
  assert.equal(result.doctor.value, '')
})

test('订单值优先，意向写入后清除已保存字段标识', async () => {
  const order = { channel: '', channelService: '', orderAmount: '', hospital: '', department: '', orderStatus: '待跟进', escortSummary: '' }
  let submittedSummary: unknown
  const backend = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url?.startsWith('/api/v1/pet/order-current')) return void response.end(JSON.stringify({ data: { order, escorts: [] } }))
    if (request.url?.startsWith('/api/v1/pet/order-ai-fields')) return void response.end(JSON.stringify({ data: { fields: { order_status: '已取消', escort_service_summary: '陪诊小结建议' }, intention: { hospital: '意向医院', department: '意向科室' } } }))
    if (request.url === '/api/v1/pet/huanyu-order-update') {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        submittedSummary = JSON.parse(body).fields.escortSummary
        order.hospital = '医院编号'
        response.end(JSON.stringify({ ok: true, escortIds: [] }))
      })
      return
    }
    return void response.end(JSON.stringify({ data: [] }))
  })
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve))
  const panels: PetOrderAiPanel[] = []
  const service = new PetOrderAiService((panel) => panels.push(panel), (_id, panel) => panels.push(panel), () => {}, 43197)
  service.setConfig({ backendUrl: `http://127.0.0.1:${(backend.address() as { port: number }).port}`, employeeCode: 'TEST' })
  service.start()
  const token = randomUUID()
  try {
    await fetch('http://127.0.0.1:43197/pet/order-page', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'open', token, tabId: 1, orderNo: 'HYYD000001', formOrderNo: 'HYYD000001' }) })
    await waitFor(() => panels.some((panel) => panel.kind === 'form'))
    const panel = panels.filter((item) => item.kind === 'form').at(-1)!
    assert.equal(panel.fields?.find((field) => field.id === 'orderStatus')?.value, '待跟进')
    assert.equal(panel.fields?.find((field) => field.id === 'orderStatus')?.suggestion, '已取消')
    assert.equal(panel.fields?.find((field) => field.id === 'hospital')?.hint, '泰康意向')
    assert.equal(panel.fields?.find((field) => field.id === 'escortSummary')?.value, '陪诊小结建议')
    await service.handlePanelAction(`order-ai:${token}`, 'one-click-fill', Object.fromEntries((panel.fields ?? []).map((field) => [field.id, field.value])))
    assert.equal(submittedSummary, '陪诊小结建议')
    const updated = panels.at(-1)!
    assert.equal(updated.fields?.find((field) => field.id === 'hospital')?.hint, undefined)
    assert.equal(updated.fields?.find((field) => field.id === 'department')?.hint, '泰康意向')
  } finally {
    service.stop()
    await new Promise<void>((resolve) => backend.close(() => resolve()))
  }
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const until = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > until) throw new Error('等待面板更新超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('订单切换时旧 AI 结果不能覆盖新面板，关闭只作用于当前订单', async () => {
  const backend = createServer(async (request, response) => {
    if (request.url?.startsWith('/api/v1/pet/order-current')) {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ data: { order: { channel: '', channelService: '', orderAmount: '' }, escorts: [] } }))
      return
    }
    if (request.url?.startsWith('/api/v1/dictionaries/huanyu/channel-products')) {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ data: [] }))
      return
    }
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
    await send('open', correct, 'HYYD000003', 'HYYD000003')
    await new Promise((resolve) => setTimeout(resolve, 350))
    assert.deepEqual(suspended, [])
    await send('suspend', correct, 'HYYD000003', 'HYYD000003')
    await waitFor(() => suspended.length > 0)
    assert.deepEqual(suspended, [panelId])
    await send('open', correct, 'HYYD000003', 'HYYD000003')
    assert.deepEqual(resumed, [panelId])
  } finally {
    service.stop()
  }
})
