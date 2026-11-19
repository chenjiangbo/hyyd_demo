import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const sourceDir = new URL('../src/pingan/', import.meta.url);

function loadTypeScriptModule(fileName, imports = {}) {
  const source = readFileSync(new URL(fileName, sourceDir), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const loaded = { exports: {} };
  const localRequire = (specifier) => imports[specifier] ?? require(specifier);
  new Function('require', 'module', 'exports', output)(localRequire, loaded, loaded.exports);
  return loaded.exports;
}

const types = loadTypeScriptModule('types.ts');
const { PINGAN_POLL_INTERVAL_MS } = types;
const { parseOrderListPage, parsePinganIdentity, parsePinganCurrentHandler, pinganAttachmentFileKey, isPinganOrderStatusInScope, isPinganOrderCompleted, shouldCapturePinganOrderDetails, oneMonthBefore, pinganFileTokenParams, pinganOrderDetailWaitMs } = loadTypeScriptModule('api.ts', { './types': types });

function response(model) {
  return {
    stat: { code: 0, stateList: [{ code: 0 }] },
    content: [{ success: true, code: 0, model }],
  };
}

test('accepts PingAn explicit zero-result pagination model', () => {
  assert.deepEqual(parseOrderListPage(response({
    total: 0,
    current: 0,
    pageCount: 0,
    data: [],
    pageSize: 10,
  }), 1), {
    current: 0,
    pageCount: 0,
    pageSize: 10,
    total: 0,
    orders: [],
  });
});

test('keeps rejecting inconsistent empty pagination metadata', () => {
  assert.throws(() => parseOrderListPage(response({
    total: 0,
    current: 0,
    pageCount: 1,
    data: [],
    pageSize: 10,
  }), 1), /分页元数据异常|空列表分页元数据不一致/);
});

test('parses a populated page with the HAR pagination shape', () => {
  const result = parseOrderListPage(response({
    total: 1,
    current: 1,
    pageCount: 1,
    data: [{ orderId: 'example-order', orderType: 'ORDINARY_REGISTER' }],
    pageSize: 10,
  }), 1);
  assert.equal(result.total, 1);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].orderId, 'example-order');
});

test('limits VIP registration and domestic hospitalization to the confirmed statuses', () => {
  assert.equal(isPinganOrderStatusInScope('ORDINARY_REGISTER', '待预约'), true);
  assert.equal(isPinganOrderStatusInScope('ORDINARY_REGISTER', '预约成功'), true);
  assert.equal(isPinganOrderStatusInScope('ORDINARY_REGISTER', '完成'), true);
  assert.equal(isPinganOrderStatusInScope('ORDINARY_REGISTER', '退号中'), true);
  assert.equal(isPinganOrderStatusInScope('ORDINARY_REGISTER', '退号成功'), true);
  assert.equal(isPinganOrderStatusInScope('ORDINARY_REGISTER', '退号失败'), true);
  assert.equal(isPinganOrderStatusInScope('ORDINARY_REGISTER', '预约失败'), true);
  assert.equal(isPinganOrderStatusInScope('ORDINARY_REGISTER', '已取消'), false);
  assert.equal(isPinganOrderStatusInScope('ORDINARY_REGISTER', '待用户确认'), false);
  assert.equal(isPinganOrderStatusInScope('HOSPITALIZE_DOMESTIC', '待预约'), true);
  assert.equal(isPinganOrderStatusInScope('HOSPITALIZE_DOMESTIC', '预约成功'), true);
  assert.equal(isPinganOrderStatusInScope('HOSPITALIZE_DOMESTIC', '完成'), true);
  assert.equal(isPinganOrderStatusInScope('HOSPITALIZE_DOMESTIC', '预约失败'), true);
  assert.equal(isPinganOrderStatusInScope('HOSPITALIZE_DOMESTIC', '待开启'), false);
  assert.equal(isPinganOrderStatusInScope('HOSPITALIZE_DOMESTIC', '待反馈'), false);
  assert.equal(isPinganOrderStatusInScope('HOSPITALIZE_DOMESTIC', '待用户确认'), false);
  assert.equal(isPinganOrderStatusInScope('HOSPITALIZE_DOMESTIC', '已取消'), false);
  assert.throws(() => isPinganOrderStatusInScope('ORDINARY_REGISTER', ''), /缺少状态名称/);
});

test('keeps completed orders status-only and avoids refreshing captured details', () => {
  assert.equal(isPinganOrderCompleted('完成'), true);
  assert.equal(shouldCapturePinganOrderDetails('完成', false), false);
  assert.equal(shouldCapturePinganOrderDetails('完成', true), false);
  assert.equal(shouldCapturePinganOrderDetails('待预约', true), false);
  assert.equal(shouldCapturePinganOrderDetails('待预约', false), true);
});

test('scans a rolling calendar month and polls every five minutes', () => {
  assert.equal(oneMonthBefore('2026-11-19'), '2026-10-19');
  assert.equal(oneMonthBefore('2026-03-31'), '2026-02-28');
  assert.throws(() => oneMonthBefore('2026-02-30'), /查询日期无效/);
  assert.equal(PINGAN_POLL_INTERVAL_MS, 5 * 60 * 1000);
});

test('extracts the logged-in PingAn ID from user.getUserInfo response shape', () => {
  assert.deepEqual(parsePinganIdentity({
    stat: { code: 0, stateList: [{ code: 0 }] },
    content: [{ id: 260679470903, name: '运营账号' }],
  }), { pinganUserId: '260679470903', displayName: '运营账号' });
});

test('rejects PingAn identity payload without login ID', () => {
  assert.throws(() => parsePinganIdentity({
    stat: { code: 0, stateList: [{ code: 0 }] },
    content: [{ name: '运营账号' }],
  }), /用户 ID 缺失或无效/);
});

test('reads order ownership from the current handler fields, not login identity', () => {
  assert.deepEqual(parsePinganCurrentHandler({ handlerUserId: 261144660208, handlerName: '处理人甲(261144660208)' }, 'order-1'), {
    handlerUserId: '261144660208', handlerName: '处理人甲(261144660208)',
  });
  assert.deepEqual(parsePinganCurrentHandler({ handlerName: '', handlerUserId: '' }, 'order-2'), {
    handlerUserId: null, handlerName: null,
  });
  assert.throws(() => parsePinganCurrentHandler({ handlerUserId: 'invalid' }, 'order-3'), /当前处理人 ID 无效/);
});

test('does not treat null file-key properties as a downloadable attachment', () => {
  assert.equal(pinganAttachmentFileKey({ fileName: 'attachment.pdf', tfsKey: null, iobsKey: null }), null);
  assert.equal(pinganAttachmentFileKey({ fileName: 'attachment.pdf', tfsKey: 'stable-file-key' }), 'stable-file-key');
});

test('derives a stable IOBS attachment id from the signed download path without retaining its token', () => {
  const id = pinganAttachmentFileKey({
    fileName: 'hospital.png',
    downloadUrl: 'http://iobs.pingan.com.cn/download/ehis-hisos-new-sf-prd/file-id.png?e=expiry&token=secret',
  });
  assert.equal(id, 'iobs:/download/ehis-hisos-new-sf-prd/file-id.png');
});

test('builds file token parameters matching the captured PingAn attachment request', () => {
  assert.deepEqual(pinganFileTokenParams('captured-file-key', 1_795_073_550_438), {
    tfsGroup: '1',
    expireAt: 1_800_073_550_438,
    fileKey: 'captured-file-key',
    domainId: 9222000,
  });
  assert.throws(() => pinganFileTokenParams(' '), /fileKey 为空/);
});

test('paces order-detail groups by at least 15 seconds', () => {
  assert.equal(pinganOrderDetailWaitMs(undefined, 100_000), 0);
  assert.equal(pinganOrderDetailWaitMs(100_000, 100_001), 14_999);
  assert.equal(pinganOrderDetailWaitMs(100_000, 115_000), 0);
  assert.throws(() => pinganOrderDetailWaitMs('invalid', 100_000), /限速时间无效/);
});
