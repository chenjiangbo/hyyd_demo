console.log('[寰宇探针] Content Script 已注入');

// ─── 工具 ────────────────────────────────────────────────────
function getCellText(cell: Element): string {
  return (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function isOnTrackingPoolPage(): boolean {
  return window.location.hash.includes('/register/trackIngPoolList');
}

function buildColumnMap(): Record<string, number> {
  const map: Record<string, number> = {};
  const headers = document.querySelectorAll(
    '.el-table__header-wrapper thead tr:first-child th'
  );
  headers.forEach((th, index) => {
    const text = getCellText(th);
    if (text) map[text] = index;
  });
  return map;
}

// ─── 模式控制 ────────────────────────────────────────────────
type Mode = 'pool_reader' | 'worker';
let currentMode: Mode = 'worker';
let scanIntervalId: ReturnType<typeof setInterval> | null = null;

// 增量上报：仅上报"新增 + 状态变化"的订单
// key = sourceOrderNo,value = status（用于判断状态是否变化）
const lastReportedStatus = new Map<string, string>();

async function loadMode(): Promise<Mode> {
  const r = await chrome.storage.local.get('mode');
  return (r.mode as Mode) ?? 'worker';
}

// ─── 扫描并上报订单（仅 pool_reader） ────────────────────────
function scanOrders() {
  if (currentMode !== 'pool_reader') return;
  if (!isOnTrackingPoolPage()) return;

  const columnMap = buildColumnMap();
  if (Object.keys(columnMap).length === 0) return;

  const rows = document.querySelectorAll('.el-table__body-wrapper tbody tr');
  if (rows.length === 0) return;

  const allOrders: Record<string, string>[] = [];

  rows.forEach((row) => {
    const cells = row.querySelectorAll('td');
    const get = (colName: string) => {
      const idx = columnMap[colName];
      return idx !== undefined && cells[idx] ? getCellText(cells[idx]) : '';
    };

    const orderId = get('订单号');
    if (!orderId) return;

    allOrders.push({
      orderId,
      applyNo: get('申请号'),
      status: get('订单状态'),
      serviceType: get('服务类型'),
      patientName: get('就诊人'),
      supplier: get('供应商'),
      inPoolTime: get('入池时间'),
      applyTime: get('申请时间'),
      networkTag: get('网络标签'),
      planName: get('方案名称'),
      planAlias: get('方案别名'),
      packetName: get('套餐名称'),
      productName: get('产品名称'),
      unitItem: get('单元项'),
    });
  });

  // 增量过滤：仅保留新增 / 状态变更
  const delta = allOrders.filter((o) => {
    const prev = lastReportedStatus.get(o.orderId);
    return prev !== o.status;
  });

  if (delta.length === 0) {
    console.debug(`[寰宇探针] 扫描到 ${allOrders.length} 条订单，无变化`);
    return;
  }

  // 更新缓存
  delta.forEach((o) => lastReportedStatus.set(o.orderId, o.status));

  console.log(
    `[寰宇探针] 扫描到 ${allOrders.length} 条订单，上报增量 ${delta.length} 条 ↓`
  );
  console.table(
    delta.map((o) => ({
      订单号: o.orderId,
      状态: o.status,
      就诊人: o.patientName,
    }))
  );
  chrome.runtime.sendMessage({ type: 'SYNC_ORDERS', payload: delta });
}

// ─── 点击"详情"按钮 ──────────────────────────────────────────
function clickDetail(orderId: string) {
  if (!isOnTrackingPoolPage()) {
    console.warn('[寰宇探针] 当前不在追踪池页面，无法执行点击');
    chrome.runtime.sendMessage({
      type: 'COMMAND_RESULT',
      payload: { orderId, success: false, reason: '当前不在追踪池页面' },
    });
    return;
  }

  const columnMap = buildColumnMap();
  const orderIdIdx = columnMap['订单号'];
  if (orderIdIdx === undefined) return;

  const mainRows = Array.from(
    document.querySelectorAll('.el-table__body-wrapper tbody tr')
  );
  const rowIndex = mainRows.findIndex((row) => {
    const cells = row.querySelectorAll('td');
    return cells[orderIdIdx] && getCellText(cells[orderIdIdx]) === orderId;
  });

  if (rowIndex === -1) {
    chrome.runtime.sendMessage({
      type: 'COMMAND_RESULT',
      payload: { orderId, success: false, reason: '页面中未找到该订单' },
    });
    return;
  }

  const fixedRightRows = document.querySelectorAll(
    '.el-table__fixed-right .el-table__fixed-body-wrapper tbody tr'
  );
  const targetRow = fixedRightRows[rowIndex] ?? mainRows[rowIndex];
  const btn = targetRow.querySelector<HTMLButtonElement>('button');

  if (!btn) {
    chrome.runtime.sendMessage({
      type: 'COMMAND_RESULT',
      payload: { orderId, success: false, reason: '找不到详情按钮' },
    });
    return;
  }

  btn.click();
  console.log(`[寰宇探针] 已点击订单 ${orderId} 的"详情"按钮`);
  chrome.runtime.sendMessage({
    type: 'COMMAND_RESULT',
    payload: { orderId, success: true },
  });
}

// ─── 启停扫描调度 ────────────────────────────────────────────
function startScanLoop() {
  stopScanLoop();
  console.log('[寰宇探针] 启动扫描循环（Pool Reader 模式）');
  setTimeout(scanOrders, 500);
  setTimeout(scanOrders, 1500);
  setTimeout(scanOrders, 3000);
  scanIntervalId = setInterval(scanOrders, 10000);
}

function stopScanLoop() {
  if (scanIntervalId) {
    clearInterval(scanIntervalId);
    scanIntervalId = null;
  }
  // 模式切换时清空增量缓存
  lastReportedStatus.clear();
}

function applyMode(mode: Mode) {
  const changed = currentMode !== mode;
  currentMode = mode;
  if (changed) console.log(`[寰宇探针] 模式切换为: ${mode}`);
  if (mode === 'pool_reader') {
    startScanLoop();
  } else {
    stopScanLoop();
    console.log('[寰宇探针] Worker 模式：不扫池，仅监听指令');
  }
}

// ─── 事件监听 ────────────────────────────────────────────────
window.addEventListener('hashchange', () => {
  if (currentMode === 'pool_reader' && isOnTrackingPoolPage()) {
    setTimeout(scanOrders, 800);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'CLAIM_ORDER' && message.payload?.orderId) {
    clickDetail(message.payload.orderId);
  } else if (message.type === 'MODE_CHANGED' && message.mode) {
    applyMode(message.mode);
  }
});

// 监听 storage 直接变化（popup 改了之后也能拿到）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.mode) {
    applyMode(changes.mode.newValue ?? 'worker');
  }
});

// ─── 初始化 ──────────────────────────────────────────────────
loadMode().then(applyMode);
