console.log('[寰宇探针] Content Script 已注入');

// ─── 工具函数 ────────────────────────────────────────────────
// 用 textContent 而非 innerText，前者不受 display:none 影响
// Element UI 固定列表格中，"订单号"列在主体区是 is-hidden，
// innerText 会返回空；textContent 能正确读取
function getCellText(cell: Element): string {
  return (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
}

// ─── 判断是否在追踪池页面 ──────────────────────────────────────
function isOnTrackingPoolPage(): boolean {
  return window.location.hash.includes('/register/trackIngPoolList');
}

// ─── 构建列名 → 列索引映射 ────────────────────────────────────
// 从主表头区读取（el-table__header-wrapper），用 textContent 保证
// is-hidden 的 "订单号"、"操作" 列也能被正确识别
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

// ─── 扫描并上报订单 ──────────────────────────────────────────
function scanOrders() {
  if (!isOnTrackingPoolPage()) return;

  const columnMap = buildColumnMap();
  if (Object.keys(columnMap).length === 0) {
    console.debug('[寰宇探针] 表头未就绪，等待下次扫描');
    return;
  }

  // 从主体区读行（包含所有列，is-hidden 列用 textContent 也能读到）
  const rows = document.querySelectorAll(
    '.el-table__body-wrapper tbody tr'
  );
  if (rows.length === 0) return;

  const orders: Record<string, string>[] = [];

  rows.forEach((row) => {
    const cells = row.querySelectorAll('td');

    const get = (colName: string) => {
      const idx = columnMap[colName];
      if (idx !== undefined && cells[idx]) {
        return getCellText(cells[idx]);
      }
      return '';
    };

    const orderId = get('订单号');
    if (!orderId) return;

    orders.push({
      orderId,
      applyNo:     get('申请号'),
      status:      get('订单状态'),
      serviceType: get('服务类型'),
      patientName: get('就诊人'),
      supplier:    get('供应商'),
      inPoolTime:  get('入池时间'),
      applyTime:   get('申请时间'),
      networkTag:  get('网络标签'),
      planName:    get('方案名称'),
      planAlias:   get('方案别名'),
      packetName:  get('套餐名称'),
      productName: get('产品名称'),
      unitItem:    get('单元项'),
    });
  });

  if (orders.length > 0) {
    console.log(`[寰宇探针] 扫描到 ${orders.length} 条订单`);
    chrome.runtime.sendMessage({ type: 'SYNC_ORDERS', payload: orders });
  }
}

// ─── 点击某订单的"详情"按钮 ──────────────────────────────────
// Element UI 固定列表格有三份 DOM：主体 / fixed-left / fixed-right
// "操作"列固定在右侧（fixed-right），只有那里的按钮是可见的
// 主体区的"操作"列是 is-hidden，click() 能触发但不够可靠
// 所以优先点击 fixed-right 里的按钮
function clickDetail(orderId: string) {
  if (!isOnTrackingPoolPage()) {
    console.warn('[寰宇探针] 当前不在追踪池页面，无法执行点击');
    return;
  }

  const columnMap = buildColumnMap();
  const orderIdIdx = columnMap['订单号'];
  if (orderIdIdx === undefined) {
    console.warn('[寰宇探针] 找不到订单号列索引');
    return;
  }

  // 在主体区找到匹配订单号的行索引
  const mainRows = Array.from(
    document.querySelectorAll('.el-table__body-wrapper tbody tr')
  );
  const rowIndex = mainRows.findIndex((row) => {
    const cells = row.querySelectorAll('td');
    return cells[orderIdIdx] && getCellText(cells[orderIdIdx]) === orderId;
  });

  if (rowIndex === -1) {
    console.warn(`[寰宇探针] 未找到订单 ${orderId} 对应的行`);
    chrome.runtime.sendMessage({
      type: 'COMMAND_RESULT',
      payload: { orderId, success: false, reason: '页面中未找到该订单' },
    });
    return;
  }

  // 用同一行索引在 fixed-right 面板里找"详情"按钮
  const fixedRightRows = document.querySelectorAll(
    '.el-table__fixed-right .el-table__fixed-body-wrapper tbody tr'
  );
  const targetRow = fixedRightRows[rowIndex];

  if (!targetRow) {
    // 降级：直接在主体区点击（display:none 按钮 click() 在 Chrome 里仍然有效）
    console.warn('[寰宇探针] fixed-right 行不存在，降级到主体区点击');
    const mainRow = mainRows[rowIndex];
    const btn = mainRow.querySelector<HTMLButtonElement>('button');
    if (btn) {
      btn.click();
      console.log(`[寰宇探针] 已点击订单 ${orderId} 的详情按钮（降级）`);
      reportCommandSuccess(orderId);
    }
    return;
  }

  const btn = targetRow.querySelector<HTMLButtonElement>('button');
  if (!btn) {
    console.warn(`[寰宇探针] 订单 ${orderId} 的操作行中找不到按钮`);
    chrome.runtime.sendMessage({
      type: 'COMMAND_RESULT',
      payload: { orderId, success: false, reason: '找不到详情按钮' },
    });
    return;
  }

  btn.click();
  console.log(`[寰宇探针] 已点击订单 ${orderId} 的"详情"按钮（行索引 ${rowIndex}）`);
  reportCommandSuccess(orderId);
}

function reportCommandSuccess(orderId: string) {
  chrome.runtime.sendMessage({
    type: 'COMMAND_RESULT',
    payload: { orderId, success: true },
  });
}

// ─── SPA 路由变化处理 ─────────────────────────────────────────
// 泰康是 hash-based SPA，路由切换不重新注入 content script
// 监听 hashchange，切回追踪池页面时立即触发一次扫描
window.addEventListener('hashchange', () => {
  if (isOnTrackingPoolPage()) {
    console.log('[寰宇探针] 检测到切换到追踪池页面，立即扫描');
    // 等 Vue 渲染完成后再扫描
    setTimeout(scanOrders, 800);
  }
});

// ─── 监听来自 Background 的指令 ──────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  console.log('[寰宇探针] 收到指令:', message);
  if (message.type === 'CLAIM_ORDER' && message.payload?.orderId) {
    // MVP 阶段：CLAIM_ORDER 映射到点击"详情"按钮进行测试
    clickDetail(message.payload.orderId);
  }
});

// ─── 启动扫描 ─────────────────────────────────────────────────
// 首次注入时延迟 1s 等待 Vue 渲染，之后每 5s 轮询一次
setTimeout(scanOrders, 1000);
setInterval(scanOrders, 5000);
