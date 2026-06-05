console.log('[寰宇探针] Content Script 已注入');

// ─── 工具 ────────────────────────────────────────────────────
function getCellText(cell: Element): string {
  return (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
}

// 订单号在单元格里是 <article><a class="applyNo">COD...</a><i.../></article>，
// 直接 textContent 会把复制图标等噪声带进来，优先读 a.applyNo。
function getOrderIdFromCell(cell: Element): string {
  const a = cell.querySelector('a.applyNo');
  if (a) return (a.textContent ?? '').trim();
  return getCellText(cell);
}

// 挂号协助待办页 URL 是 #/register/register，公共池 / 个人池切换不改变 URL。
// 个人池对应 #pane-2，激活时其 display 不为 none。
function isOnPersonalPoolPage(): boolean {
  if (!window.location.hash.includes('/register/register')) return false;
  const pane2 = document.getElementById('pane-2');
  return !!pane2 && pane2.style.display !== 'none';
}

// 个人池表格 scope 在 #pane-2 内，避免误读公共池(#pane-1)的表格
function getPersonalPoolTable(): Element | null {
  const pane2 = document.getElementById('pane-2');
  if (!pane2) return null;
  return pane2.querySelector('.el-table');
}

function buildColumnMap(table: Element): Record<string, number> {
  const map: Record<string, number> = {};
  const headers = table.querySelectorAll(
    '.el-table__header-wrapper thead tr:first-child th'
  );
  headers.forEach((th, index) => {
    const text = getCellText(th);
    if (text) map[text] = index;
  });
  return map;
}

// ─── 采集状态 ────────────────────────────────────────────────
// 个人池每个员工各自不同、永不重复，因此每台机器都应采集，无需模式开关。
let scanIntervalId: ReturnType<typeof setInterval> | null = null;

// 增量上报：仅上报"新增 + 状态变化"的订单
// key = sourceOrderNo,value = status（用于判断状态是否变化）
const lastReportedStatus = new Map<string, string>();

// ─── 扫描并上报订单 ──────────────────────────────────────────
function scanOrders() {
  if (!isOnPersonalPoolPage()) return;

  const table = getPersonalPoolTable();
  if (!table) return;

  const columnMap = buildColumnMap(table);
  if (Object.keys(columnMap).length === 0) return;

  const rows = table.querySelectorAll('.el-table__body-wrapper tbody tr');
  if (rows.length === 0) return;

  const allOrders: Record<string, string>[] = [];

  rows.forEach((row) => {
    const cells = row.querySelectorAll('td');
    const get = (colName: string) => {
      const idx = columnMap[colName];
      return idx !== undefined && cells[idx] ? getCellText(cells[idx]) : '';
    };

    const orderIdIdx = columnMap['订单号'];
    const orderId =
      orderIdIdx !== undefined && cells[orderIdIdx]
        ? getOrderIdFromCell(cells[orderIdIdx])
        : '';
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

// 注：插件只做只读采集，不再点击任何按钮（原 clickDetail 已移除）。

// ─── 扫描调度 ────────────────────────────────────────────────
function startScanLoop() {
  if (scanIntervalId) clearInterval(scanIntervalId);
  console.log('[寰宇探针] 启动个人池扫描循环');
  setTimeout(scanOrders, 500);
  setTimeout(scanOrders, 1500);
  setTimeout(scanOrders, 3000);
  scanIntervalId = setInterval(scanOrders, 10000);
}

// ─── 事件监听 ────────────────────────────────────────────────
window.addEventListener('hashchange', () => {
  if (isOnPersonalPoolPage()) {
    setTimeout(scanOrders, 800);
  }
});

// 切换"公共池/个人池"标签页不会改变 URL（无 hashchange），
// 改用 MutationObserver 监听 #pane-2 的 display 变化触发扫描。
function watchPersonalPoolTab() {
  const pane2 = document.getElementById('pane-2');
  if (!pane2) {
    // pane-2 可能还没渲染，稍后重试
    setTimeout(watchPersonalPoolTab, 1000);
    return;
  }
  new MutationObserver(() => {
    if (isOnPersonalPoolPage()) {
      setTimeout(scanOrders, 800);
    }
  }).observe(pane2, { attributes: true, attributeFilter: ['style'] });
}
watchPersonalPoolTab();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'FETCH_ORDER_DETAIL' && message.subOrderNo) {
    // 从 background 委托过来的详情抓取（在页面上下文跑，自动带 cookie）
    fetchOrderDetailInPage(message.subOrderNo)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true; // 异步响应
  }
});

// ─── 详情抓取（页面上下文，cookie 自动带） ───────────────────
const TAIKANG_API_BASE = 'https://ccm.taikang.com/ccm-unify/ccm-unify/ccm-unify';
const FETCH_FILE_TYPES = ['40', '41', '5000', '5001'];

// 泰康用自定义 header `access_token: xxx` 做认证。
// 真实 token 存在 cookie `Admin-Token` 里，前端 axios 拦截器读出来后
// 改名为 `access_token` 当 header 发。我们模仿这个行为。
function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function findTaikangToken(): string | null {
  // 优先 cookie
  const fromCookie = readCookie('Admin-Token') ?? readCookie('access_token') ?? readCookie('token');
  if (fromCookie) return fromCookie;
  // 兜底：localStorage / sessionStorage
  const keys = ['access_token', 'token', 'Admin-Token', 'accessToken', 'Authorization'];
  for (const k of keys) {
    const v = localStorage.getItem(k) ?? sessionStorage.getItem(k);
    if (v && v.length > 0) return v;
  }
  return null;
}

async function postWithTimeout(path: string, body: any, timeoutMs = 8000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const token = findTaikangToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['access_token'] = token;
    const resp = await fetch(`${TAIKANG_API_BASE}/${path}`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (resp.status === 401 || resp.status === 302) throw new Error('NEED_LOGIN');
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${path}`);
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

async function safe<T>(p: Promise<T>): Promise<T | null> {
  try { return await p; } catch (e) {
    console.warn('[寰宇探针][content] 子接口失败（已忽略）:', e);
    return null;
  }
}

async function fetchOrderDetailInPage(subOrderNo: string): Promise<any> {
  console.log('[寰宇探针][content] 抓取详情:', subOrderNo);
  const caseInfoResp = await postWithTimeout('medicalmanager/caseInfo', { subOrderNo });
  const caseData = caseInfoResp?.data ?? null;
  if (!caseData) {
    console.warn('[寰宇探针][content] caseInfo 空返回 raw:', caseInfoResp);
    // 错误分类，前端能展示对应引导
    const code = caseInfoResp?.code;
    const msg = (caseInfoResp?.message ?? '') as string;
    if (code === 401102 || /TOKEN_EXPIRED/i.test(msg)) {
      throw new Error('TOKEN_EXPIRED: 泰康登录已过期，请在浏览器中重新登录后重试');
    }
    if (code === 401103 || /token/i.test(msg)) {
      throw new Error('NEED_LOGIN: 未检测到泰康登录态，请确认浏览器已登录泰康系统');
    }
    if (code === 200 || caseInfoResp?.success === true) {
      throw new Error('EMPTY_DATA: 泰康未返回该订单详情（可能订单不在当前账号权限范围内）');
    }
    throw new Error('UNKNOWN: ' + JSON.stringify(caseInfoResp).slice(0, 200));
  }

  const caseId = caseData.caseId ?? null;
  const hospitalId = caseData.hospitalId ?? null;
  const hospitalName = caseData.intendHos ?? '';

  const [intend, latest, exce, hospAddr] = await Promise.all([
    caseId ? safe(postWithTimeout('register/getIntendClinicInfo', { caseId: String(caseId) })) : Promise.resolve(null),
    safe(postWithTimeout('register/getLatestRegisterInfo', { subOrderNo })),
    safe(postWithTimeout('register/ExceInfo', { subOrderNo })),
    hospitalId
      ? safe(postWithTimeout('api/hospitalAddr', { hospitalId, supplierId: '3', hospitalName }))
      : Promise.resolve(null),
  ]);

  const imgPages = await Promise.all(
    FETCH_FILE_TYPES.map((ft) =>
      safe(postWithTimeout('ecm/getImage', { subOrderNo, fileType: ft, pageNum: 1, pageSize: 5 }))
    )
  );
  const attachments: any[] = [];
  imgPages.forEach((page, idx) => {
    const ft = FETCH_FILE_TYPES[idx];
    const list: any[] = page?.data?.list ?? [];
    for (const item of list) {
      if (!item?.fileUrl || !item?.fileId) continue;
      const { fileUrl, ...rawMeta } = item;
      attachments.push({
        fileType: ft,
        fileId: String(item.fileId),
        fileName: item.fileName || `${item.fileId}.${item.fileDataType || 'jpg'}`,
        mimeType: `image/${item.fileDataType || 'jpeg'}`,
        base64: fileUrl,
        rawJson: rawMeta,
      });
    }
  });

  return {
    detail: {
      caseInfo: caseData,
      intendClinicInfo: intend?.data ?? null,
      latestRegisterInfo: latest?.data ?? null,
      hospitalAddr: hospAddr?.data ?? null,
      exceInfo: exce?.data ?? null,
    },
    attachments,
  };
}

// ─── 泰康 token 保活 ─────────────────────────────────────────
// 泰康 ~30 分钟过期，假设是滑动过期：定时调一次轻量接口重置过期计时器。
// 用 GET /api/getDictList/EXPERT_TITLE（无参数、响应 ~1KB，最便宜）。
//
// 策略（用自调度 setTimeout 而非固定 setInterval，便于按结果动态决定下一次时机）：
//  - 正常续期间隔 8 分钟（相对 30 分钟过期留足余量）
//  - 续期失败（网络异常 / 非过期类 HTTP 错误）走指数退避快速重试：30s→60s→120s，
//    最多 3 次，避免一次网络抖动直接拖到过期；重试用尽后回到正常间隔
//  - 一旦确认 token 过期：在页面顶部注入醒目红条提示员工，并切到 60s 间隔快探测，
//    员工重新登录后能在 1 分钟内自动恢复（红条自动消失）
const KEEPALIVE_INTERVAL_MS = 8 * 60 * 1000;
const KEEPALIVE_EXPIRED_RECHECK_MS = 60 * 1000;
const KEEPALIVE_RETRY_DELAYS = [30_000, 60_000, 120_000];

let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleKeepalive(delayMs: number, retryIndex = 0) {
  if (keepaliveTimer) clearTimeout(keepaliveTimer);
  keepaliveTimer = setTimeout(() => void runKeepalive(retryIndex), delayMs);
}

// 单次探测结果：ok 续期成功 | expired 已过期 | retry 临时失败需重试 | skip 无 token
async function keepaliveProbe(): Promise<'ok' | 'expired' | 'retry' | 'skip'> {
  const token = findTaikangToken();
  if (!token) {
    console.log('[寰宇探针][keepalive] 未找到 token，跳过本次保活');
    return 'skip';
  }
  try {
    const resp = await fetch(`${TAIKANG_API_BASE}/api/getDictList/EXPERT_TITLE`, {
      method: 'GET',
      credentials: 'include',
      headers: { access_token: token },
    });
    if (resp.status === 401 || resp.status === 302) {
      console.warn('[寰宇探针][keepalive] 保活返回未授权，判定过期');
      return 'expired';
    }
    if (!resp.ok) {
      console.warn(`[寰宇探针][keepalive] 保活请求 HTTP ${resp.status}，稍后重试`);
      return 'retry';
    }
    const j = await resp.json();
    if (j?.code === 401102 || /TOKEN_EXPIRED/i.test(j?.message ?? '')) {
      console.warn('[寰宇探针][keepalive] token 已过期，需要重新登录');
      return 'expired';
    }
    console.log(`[寰宇探针][keepalive] ✓ token 续活成功 @ ${new Date().toLocaleTimeString('zh-CN')}`);
    return 'ok';
  } catch (e) {
    console.warn('[寰宇探针][keepalive] 保活请求异常，稍后重试:', e);
    return 'retry';
  }
}

async function runKeepalive(retryIndex: number): Promise<void> {
  const result = await keepaliveProbe();
  switch (result) {
    case 'ok':
      removeExpiredBanner();
      chrome.runtime.sendMessage({ type: 'TAIKANG_TOKEN_STATUS', ok: true, at: Date.now() });
      scheduleKeepalive(KEEPALIVE_INTERVAL_MS);
      break;
    case 'expired':
      showExpiredBanner();
      chrome.runtime.sendMessage({ type: 'TAIKANG_TOKEN_STATUS', ok: false, reason: 'TOKEN_EXPIRED' });
      // 过期后快探测，员工重登后能尽快恢复；不做指数退避（重试也没用）
      scheduleKeepalive(KEEPALIVE_EXPIRED_RECHECK_MS);
      break;
    case 'retry':
      if (retryIndex < KEEPALIVE_RETRY_DELAYS.length) {
        const delay = KEEPALIVE_RETRY_DELAYS[retryIndex];
        console.log(`[寰宇探针][keepalive] 第 ${retryIndex + 1} 次重试将在 ${delay / 1000}s 后`);
        scheduleKeepalive(delay, retryIndex + 1);
      } else {
        console.warn('[寰宇探针][keepalive] 重试用尽，回到正常间隔');
        chrome.runtime.sendMessage({ type: 'TAIKANG_TOKEN_STATUS', ok: false, reason: 'KEEPALIVE_FAILED' });
        scheduleKeepalive(KEEPALIVE_INTERVAL_MS);
      }
      break;
    case 'skip':
      scheduleKeepalive(KEEPALIVE_INTERVAL_MS);
      break;
  }
}

// ─── 登录过期提示条（注入泰康页面顶部） ──────────────────────
const EXPIRED_BANNER_ID = 'huanyu-token-expired-banner';

function showExpiredBanner() {
  if (document.getElementById(EXPIRED_BANNER_ID)) return;
  const bar = document.createElement('div');
  bar.id = EXPIRED_BANNER_ID;
  bar.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
    'background:#e53e3e', 'color:#fff', 'font-size:14px', 'line-height:1.5',
    'padding:10px 36px 10px 16px', 'text-align:center', 'box-sizing:border-box',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'box-shadow:0 2px 6px rgba(0,0,0,0.2)',
  ].join(';');
  bar.textContent = '⚠ 泰康登录已过期，寰宇采集已暂停。请重新登录泰康系统，登录后将自动恢复。';
  const close = document.createElement('span');
  close.textContent = '✕';
  close.style.cssText =
    'position:absolute;top:50%;right:16px;transform:translateY(-50%);cursor:pointer;font-weight:bold';
  close.onclick = () => bar.remove();
  bar.appendChild(close);
  (document.body || document.documentElement).appendChild(bar);
}

function removeExpiredBanner() {
  document.getElementById(EXPIRED_BANNER_ID)?.remove();
}

// 启动后等 30 秒先探一次（确认 token 可用），之后进入自调度循环
scheduleKeepalive(30_000);

// ─── 初始化 ──────────────────────────────────────────────────
// 个人池无需开关，注入后即开始扫描上报
startScanLoop();
