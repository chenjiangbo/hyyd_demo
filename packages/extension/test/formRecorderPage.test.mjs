import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const bundle = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../dist/formRecorderPage.global.js'), 'utf8')

function page() {
  const listeners = new Map()
  const messages = []
  const nativeResponse = { status: 200, headers: { get: () => 'application/json' }, clone: () => ({ text: async () => '{}' }) }
  const nativePromise = Promise.resolve(nativeResponse)
  let fetchCalls = 0
  let xhrOpenArgs
  let xhrSendCalls = 0
  let bodyText = ''
  let failBodyRead = false
  let nextId = 0
  const location = {
    href: 'https://ccm.taikang.com/#/index',
    hash: '#/index',
    origin: 'https://ccm.taikang.com'
  }
  class FakeXHR {
    addEventListener() {}
    open(...args) { xhrOpenArgs = args }
    send() { xhrSendCalls++ }
  }
  const window = {
    fetch: () => { fetchCalls++; return nativePromise },
    XMLHttpRequest: FakeXHR,
    addEventListener: (name, listener) => listeners.set(name, listener),
    postMessage(message) { messages.push(message) }
  }
  const document = {
    body: { get innerText() { if (failBodyRead) throw new Error('recording failed'); return bodyText } },
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => []
  }
  const context = {
    window, document, location,
    URL, URLSearchParams, Request, FormData, Blob, ArrayBuffer,
    File: globalThis.File || class File {},
    MutationObserver: class { observe() {} },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}` },
    performance: { now: () => 1 },
    setTimeout, clearTimeout,
    console: { error() {} }
  }
  runInNewContext(bundle, context)
  return {
    window, location, listeners, nativePromise,
    messages,
    ready: () => listeners.get('message')({ source: window, data: { source: 'HYYD_FORM_RECORDER_READY' } }),
    fetchCalls: () => fetchCalls,
    xhrOpenArgs: () => xhrOpenArgs,
    xhrSendCalls: () => xhrSendCalls,
    failRecording: () => { failBodyRead = true },
    setRoute: (hash) => {
      location.hash = hash
      location.href = `https://ccm.taikang.com/${hash}`
      listeners.get('hashchange')()
    }
  }
}

test('unrelated pages return the original fetch promise and preserve XHR arguments', () => {
  const p = page()
  const promise = p.window.fetch('/ccm-unify/test')
  assert.equal(promise, p.nativePromise)
  assert.equal(p.fetchCalls(), 1)
  const xhr = new p.window.XMLHttpRequest()
  xhr.open('GET', '/ccm-unify/test')
  xhr.send()
  assert.deepEqual(p.xhrOpenArgs(), ['GET', '/ccm-unify/test'])
  assert.equal(p.xhrSendCalls(), 1)
})

test('recording failures do not block form-page fetch or XHR', async () => {
  const p = page()
  p.setRoute('#/medicalManager/statusCommon?orderId=order-1')
  p.failRecording()
  const response = await p.window.fetch('/ccm-unify/test', { method: 'POST', body: '{}' })
  assert.equal(response.status, 200)
  assert.equal(p.fetchCalls(), 1)
  const xhr = new p.window.XMLHttpRequest()
  xhr.open('POST', '/ccm-unify/test', false)
  xhr.send('{}')
  assert.deepEqual(p.xhrOpenArgs(), ['POST', '/ccm-unify/test', false])
  assert.equal(p.xhrSendCalls(), 1)
})

test('form-page entry and Taikang fetch round trip are recorded', async () => {
  const p = page()
  p.setRoute('#/medicalManager/statusCommon?orderId=order-1')
  p.ready()
  await p.window.fetch('/ccm-unify/test', { method: 'POST', body: JSON.stringify({ hospital: '测试医院' }) })
  await new Promise(setImmediate)

  const events = p.messages.filter((message) => message.source === 'HYYD_FORM_RECORDER_V1')
  assert.deepEqual(events.map((message) => message.event.kind), ['session-start', 'request', 'request'])
  assert.deepEqual(events.map((message) => message.event.sequence), [1, 2, 3])
  assert.equal(events[0].session.sourceOrderNo, 'order-1')
  assert.equal(events[1].event.payload.method, 'POST')
  assert.equal(events[1].event.payload.requestBody.hospital, '测试医院')
  assert.equal(events[2].event.payload.status, 200)
  assert.equal(JSON.stringify(events[2].event.payload.responseBody), '{}')
  assert.equal(events[1].event.payload.requestId, events[2].event.payload.requestId)
})

test('form-page entry and resulting state request screenshots in the same sequence', async () => {
  const p = page()
  p.setRoute('#/register/registerCommon?orderId=order-2')
  p.ready()
  await new Promise((resolve) => setTimeout(resolve, 800))

  const events = p.messages.filter((message) => message.source === 'HYYD_FORM_RECORDER_V1')
  assert.deepEqual(events.map((message) => message.event.kind),
    ['session-start', 'page-state', 'screenshot', 'screenshot'])
  assert.deepEqual(events.map((message) => message.event.sequence), [1, 2, 3, 4])
  assert.equal(events[2].event.payload.relatedSequence, 1)
  assert.equal(events[3].event.payload.relatedSequence, 2)
  assert.equal(events[2].session.id, events[0].session.id)
})
