console.log('[寰宇探针] Background Service Worker 已启动');

let ws: WebSocket | null = null;
const DEFAULT_BACKEND_WS_URL = 'ws://192.168.202.1:13000/ws';
const DEFAULT_EMPLOYEE_CODE = 'huanyu-field-1';
const CLIENT_TYPE = 'ext';
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let presenceTimer: ReturnType<typeof setInterval> | null = null;

// 缓存：员工信息（从后端 connection_established 拿到）
let employeeName: string | null = null;
let backendWsUrl = DEFAULT_BACKEND_WS_URL;
let employeeCode = DEFAULT_EMPLOYEE_CODE;

async function loadConfig() {
  const r = await chrome.storage.local.get(['backendWsUrl', 'employeeCode']);
  backendWsUrl = (r.backendWsUrl as string) || DEFAULT_BACKEND_WS_URL;
  employeeCode = (r.employeeCode as string) || DEFAULT_EMPLOYEE_CODE;
}

// ─── WebSocket 连接 ──────────────────────────────────────────
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
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
      }

      // 插件只读：不再执行任何点击/申领写操作。
      // 仅保留"抓取订单详情"这类只读指令（详情接口本身是 GET/POST 查询）。
      if (data.type === 'command' && data.action === 'fetch_detail') {
        if (data.payload?.sourceOrderNo) {
          void fetchAndReportDetail(data.payload.sourceOrderNo);
        }
      }
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

    case 'COMMAND_RESULT':
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'COMMAND_RESULT',
          payload: message.payload,
          employeeCode,
        }));
      }
      console.log('[寰宇探针] 指令执行结果:', message.payload);
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

// ─── 详情抓取并上报 ──────────────────────────────────────────
// MV3 service worker 的 fetch 不带 cookie，所以委托给 content script 在页面上下文跑
async function fetchAndReportDetail(sourceOrderNo: string) {
  console.log('[寰宇探针] 开始抓取详情:', sourceOrderNo);
  try {
    const tabs = await chrome.tabs.query({ url: '*://ccm.taikang.com/*' });
    if (tabs.length === 0 || !tabs[0].id) {
      throw new Error('未找到泰康标签页（请先在浏览器登录并打开泰康系统）');
    }
    const resp = await chrome.tabs.sendMessage(tabs[0].id, {
      type: 'FETCH_ORDER_DETAIL',
      subOrderNo: sourceOrderNo,
    });
    if (!resp?.ok) {
      throw new Error(resp?.error || '未知错误');
    }
    const result = resp.result;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'ORDER_DETAIL_FETCHED',
        payload: {
          sourceOrderNo,
          detail: result.detail,
          attachments: result.attachments,
        },
      }));
      console.log(
        `[寰宇探针] 详情已上报: ${sourceOrderNo} 附件=${result.attachments.length}`
      );
    } else {
      console.warn('[寰宇探针] WS 未连接，详情未上报');
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.error('[寰宇探针] 抓取详情失败:', err);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'ORDER_DETAIL_FETCHED',
        payload: { sourceOrderNo, error: err },
      }));
    }
  }
}

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
