import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const bundle = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../dist/pinganPageProbe.global.js'), 'utf8');

function page() {
  const messages = [];
  const windowListeners = new Map();
  const xhrListeners = new Map();
  const originalResponse = {
    status: 200,
    json: async () => ({ stat: { code: 0, stateList: [{ code: 0 }] }, content: [{ code: 0, success: true, model: { ok: true } }] }),
    clone: () => ({ text: async () => JSON.stringify({ content: [{ code: 0, success: true, model: { ok: true } }] }) }),
  };
  const fetchCalls = [];
  let fetchCount = 0;
  let opened = null;
  class FakeXHR {
    status = 200;
    responseText = JSON.stringify({ content: [{ code: 0, success: true, model: { ok: true } }] });
    addEventListener(name, listener) { xhrListeners.set(name, listener); }
    open(method, url, ...rest) { this.openArgs = [method, url, ...rest]; }
    send() { xhrListeners.get('loadend')?.(); }
  }
  const window = {
    fetch: async (...args) => { fetchCount++; fetchCalls.push(args); return originalResponse; },
    XMLHttpRequest: FakeXHR,
    addEventListener: (name, listener) => windowListeners.set(name, listener),
    postMessage: (message) => messages.push(message),
  };
  const document = { cookie: '_wtk=session-cookie' };
  const context = {
    window,
    XMLHttpRequest: FakeXHR,
    document,
    URL,
    URLSearchParams,
    Request,
    TextEncoder,
    location: { href: 'https://www.jk.cn/supplier-center/#/goodsOrderList' },
    performance: { now: () => 20 },
    setTimeout,
    clearTimeout,
  };
  runInNewContext(bundle, context);
  return { window, messages, originalResponse, fetchCount: () => fetchCount, fetchCalls, windowListeners };
}

test('PingAn allowlisted request is observed without changing its response or exposing signatures', async () => {
  const p = page();
  const body = new URLSearchParams({
    _mt: 'roger.getOrderList',
    _sig: 'signature-secret',
    _wtk: 'session-secret',
    param: JSON.stringify({ merchantId: 42, orderType: 'ORDINARY_REGISTER', pageNum: 1, pageSize: 10 }),
  }).toString();
  const response = await p.window.fetch('https://api.jk.cn/m.api?_mt=roger.getOrderList', { method: 'POST', body });
  assert.equal(response, p.originalResponse);
  await new Promise(setImmediate);
  const apiEvents = p.messages.filter((item) => item.source === 'HYYD_PINGAN_PROBE');
  assert.equal(apiEvents.length, 1);
  assert.equal(apiEvents[0].payload.method, 'roger.getOrderList');
  assert.equal(apiEvents[0].payload.requestParam.orderType, 'ORDINARY_REGISTER');
  assert.equal(JSON.stringify(apiEvents[0]).includes('signature-secret'), false);
  assert.equal(JSON.stringify(apiEvents[0]).includes('session-secret'), false);
});

test('non-PingAn requests pass through without observation', async () => {
  const p = page();
  const response = await p.window.fetch('https://example.org/api', { method: 'POST', body: '{}' });
  assert.equal(response, p.originalResponse);
  await new Promise(setImmediate);
  assert.equal(p.fetchCount(), 1);
  assert.equal(p.messages.length, 0);
});

test('direct API request uses the page signing algorithm and returns its response', async () => {
  const p = page();
  p.windowListeners.get('message')({
    source: p.window,
    data: {
      source: 'HYYD_PINGAN_API_REQUEST',
      requestId: 'req-1',
      method: 'roger.getOrderList',
      params: { param: { merchantId: 42, pageNum: 1, pageSize: 10, orderType: 'ORDINARY_REGISTER' } },
    },
  });
  await new Promise(setImmediate);
  const [url, init] = p.fetchCalls[0];
  assert.equal(url, 'https://api.jk.cn/m.api?_mt=roger.getOrderList');
  assert.equal(init.credentials, 'include');
  assert.equal(init.body.includes('roger.getOrderList'), true);
  const fields = new URLSearchParams(init.body);
  const values = Object.fromEntries([...fields.entries()].filter(([key]) => key !== '_sig'));
  const base = Object.keys(values).sort().map((key) => `${key}=${values[key]}`).join('') + 'session-cookie';
  assert.equal(fields.get('_sig'), createHash('md5').update(base).digest('hex'));
  assert.equal(JSON.parse(fields.get('param')).orderType, 'ORDINARY_REGISTER');
  assert.equal(p.messages.at(-1).payload.kind, 'api-result');
  assert.equal(p.messages.at(-1).payload.requestId, 'req-1');
  assert.equal(p.messages.at(-1).payload.response.content[0].model.ok, true);
});
