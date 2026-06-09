console.log('[寰宇探针] Background Service Worker 已启动');

let ws: WebSocket | null = null;
// backendWsUrl 给默认（同子网下基本不变）；employeeCode 不给默认 ——
// 没配置就不连 WS、不轮询，避免把数据错误归到默认员工名下。
const DEFAULT_BACKEND_WS_URL = 'ws://47.95.14.233:9093/ws';
const CLIENT_TYPE = 'ext';
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let presenceTimer: ReturnType<typeof setInterval> | null = null;

// 缓存：员工信息（从后端 connection_established 拿到）
let employeeName: string | null = null;
let backendWsUrl = DEFAULT_BACKEND_WS_URL;
let employeeCode = ''; // 空 = 未配置

async function loadConfig() {
  const r = await chrome.storage.local.get(['backendWsUrl', 'employeeCode']);
  backendWsUrl = (r.backendWsUrl as string) || DEFAULT_BACKEND_WS_URL;
  employeeCode = ((r.employeeCode as string) || '').trim();
}

// ─── WebSocket 连接 ──────────────────────────────────────────
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (!employeeCode) {
    console.warn('[寰宇探针] 员工 ID 未配置，请在插件 popup 里设置后再使用');
    return;
  }

  const url = `${backendWsUrl}?employeeCode=${encodeURIComponent(employeeCode)}&client=${CLIENT_TYPE}`;
  console.log('[寰宇探针] 连接后端:', url);
  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('[寰宇探针] 已连接后端');
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // 立即发一次 presence，之后周期性发
    sendPresence();
    if (presenceTimer) clearInterval(presenceTimer);
    presenceTimer = setInterval(sendPresence, 10_000);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('[寰宇探针] 收到后端消息:', data);

      if (data.type === 'connection_established' && data.employee) {
        employeeName = data.employee.name;
        // 连接建立后主动拉一次基线（覆盖"content 早于 WS 连上时发的请求丢失"）
        requestFingerprintBaseline();
      }

      // 后端返回的指纹基线 → 转发给泰康标签页的 content script
      if (data.type === 'FINGERPRINTS_BASELINE') {
        forwardBaselineToTabs(data.payload || {});
      }

      // 插件纯只读自动采集：个人池列表 + 订单详情都由 content script 定时
      // 轮询抓取并主动上报，后端无需下发任何指令。这里只处理后端的状态消息。
    } catch (e) {
      console.error('[寰宇探针] 解析后端消息失败', e);
    }
  };

  ws.onclose = () => {
    console.log('[寰宇探针] 与后端断开，5s 后重连...');
    ws = null;
    if (presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
    reconnectTimer = setTimeout(connectWebSocket, 5000);
  };

  ws.onerror = (err) => {
    console.error('[寰宇探针] WebSocket 错误:', err);
  };
}

// ─── PRESENCE 心跳 ───────────────────────────────────────────
async function sendPresence() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const tabs = await chrome.tabs.query({ url: '*://ccm.taikang.com/*' });
  // 挂号协助待办页（含个人池）URL 是 #/register/register
  const registerTab = tabs.find((t) => t.url?.includes('/register/register'));
  const payload = {
    type: 'PRESENCE',
    taikangTabOpen: tabs.length > 0,
    trackingPoolPageActive: !!registerTab,
    ts: Date.now(),
  };
  ws.send(JSON.stringify(payload));
}

// ─── Content Script & Popup 消息 ─────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'SYNC_ORDERS':
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'ORDERS_SYNCED',
          payload: message.payload,
          employeeCode,
        }));
        console.log(`[寰宇探针] 已上报 ${message.payload?.length ?? 0} 条订单`);
      } else {
        console.warn('[寰宇探针] 后端未连接，本次订单数据未上报');
      }
      break;

    case 'ORDER_DETAIL_FETCHED':
      // content script 抓到的订单详情，转发给后端入库
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'ORDER_DETAIL_FETCHED',
          payload: message.payload,
          employeeCode,
        }));
      } else {
        console.warn('[寰宇探针] 后端未连接，本条详情未上报');
      }
      break;

    case 'TAIKANG_TOKEN_STATUS':
      // content script 保活探测的结果，转发给后端供托盘展示
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'TAIKANG_TOKEN_STATUS',
          ok: !!message.ok,
          reason: message.reason ?? null,
          at: message.at ?? Date.now(),
        }));
      }
      break;

    case 'REQUEST_FINGERPRINT_BASELINE':
      // content 启动时请求后端指纹基线；若 WS 未就绪，连接建立后会自动补拉
      requestFingerprintBaseline();
      break;

    case 'SYNC_FINGERPRINTS':
      // content 把本地全量指纹推给后端对账
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'SYNC_FINGERPRINTS',
          payload: message.payload,
          employeeCode,
        }));
      }
      break;

    case 'GET_STATUS': {
      // Popup 查询当前状态
      const resp = {
        wsConnected: ws?.readyState === WebSocket.OPEN,
        employeeName,
        backendWsUrl,
        employeeCode,
      };
      sendResponse(resp);
      return true; // 表示异步响应
    }
  }
});

// ─── 指纹基线（增量起点） ────────────────────────────────────
function requestFingerprintBaseline() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'GET_FINGERPRINTS', employeeCode }));
  }
}

async function forwardBaselineToTabs(payload: unknown) {
  const tabs = await chrome.tabs.query({ url: '*://ccm.taikang.com/*' });
  for (const t of tabs) {
    if (t.id) {
      chrome.tabs
        .sendMessage(t.id, { type: 'FINGERPRINT_BASELINE', payload })
        .catch(() => {/* tab 无 content script 时忽略 */});
    }
  }
}

// ─── 监听配置变化 ────────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.backendWsUrl || changes.employeeCode) {
    backendWsUrl = changes.backendWsUrl?.newValue ?? backendWsUrl;
    employeeCode = changes.employeeCode?.newValue ?? employeeCode;
    if (ws) ws.close();
    connectWebSocket();
  }
});

// ─── MV3 Service Worker 保活 ─────────────────────────────────
// Chrome 会在 SW 空闲 ~30s 后休眠，导致 WS 断开、新 command 丢失。
// 用 chrome.alarms 周期性触发事件来阻止休眠，并在 WS 断开时主动重连。
chrome.alarms.create('huanyu-keepalive', { periodInMinutes: 0.25 }); // 15 秒
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'huanyu-keepalive') return;
  // 没连接就尝试连，连着就发个 ping
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    connectWebSocket();
  } else if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'ping' }));
    } catch {/* ignore */}
  }
});

// ─── 启动 ─────────────────────────────────────────────────────
loadConfig().then(connectWebSocket).catch(connectWebSocket);
