console.log('[寰宇探针] Background Service Worker 已启动');

let ws: WebSocket | null = null;
// MVP: Chrome 跑在 Windows VM 里，后端跑在 Mac 上，必须用 Mac IP 而不是 localhost
// 如果后端跑在同机，改成 ws://localhost:13000/ws
const BACKEND_WS_URL = 'ws://192.168.202.1:13000/ws';
const EMPLOYEE_TOKEN = 'huanyu_test_token_123'; // 对应 prisma/seed.ts 里的员工
const CLIENT_TYPE = 'ext';
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let presenceTimer: ReturnType<typeof setInterval> | null = null;

// 缓存：员工信息（从后端 connection_established 拿到）
let employeeName: string | null = null;
let currentMode: 'pool_reader' | 'worker' = 'worker';

// ─── 当前模式 ────────────────────────────────────────────────
async function loadMode(): Promise<'pool_reader' | 'worker'> {
  const r = await chrome.storage.local.get('mode');
  return (r.mode as 'pool_reader' | 'worker') ?? 'worker';
}
loadMode().then((m) => (currentMode = m));

// ─── WebSocket 连接 ──────────────────────────────────────────
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const url = `${BACKEND_WS_URL}?token=${EMPLOYEE_TOKEN}&client=${CLIENT_TYPE}`;
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

      // 后端推送格式: { type: 'command', action: 'claim', payload: { sourceOrderNo, ... } }
      if (data.type === 'command' && data.action === 'claim') {
        forwardToTaikangTab({
          type: 'CLAIM_ORDER',
          commandId: data.commandId,
          payload: { orderId: data.payload?.sourceOrderNo },
        });
      }
      // 兼容直接格式
      if (data.type === 'CLAIM_ORDER') {
        forwardToTaikangTab(data);
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
  const trackingTab = tabs.find((t) => t.url?.includes('trackIngPoolList'));
  const payload = {
    type: 'PRESENCE',
    taikangTabOpen: tabs.length > 0,
    trackingPoolPageActive: !!trackingTab,
    mode: currentMode,
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
          token: EMPLOYEE_TOKEN,
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
          token: EMPLOYEE_TOKEN,
        }));
      }
      console.log('[寰宇探针] 指令执行结果:', message.payload);
      break;

    case 'MODE_CHANGED':
      currentMode = message.mode;
      console.log('[寰宇探针] 模式变更:', currentMode);
      // 立即推送一次 presence，让后端看到新模式
      sendPresence();
      break;

    case 'GET_STATUS': {
      // Popup 查询当前状态
      const resp = {
        wsConnected: ws?.readyState === WebSocket.OPEN,
        employeeName,
        mode: currentMode,
      };
      sendResponse(resp);
      return true; // 表示异步响应
    }
  }
});

// ─── 监听 mode 变化 ──────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.mode) {
    currentMode = changes.mode.newValue ?? 'worker';
    sendPresence();
  }
});

// ─── 转发指令到泰康标签 ──────────────────────────────────────
async function forwardToTaikangTab(message: unknown) {
  const tabs = await chrome.tabs.query({ url: '*://ccm.taikang.com/*' });
  if (tabs.length === 0) {
    console.warn('[寰宇探针] 未找到泰康标签页');
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'COMMAND_RESULT',
        payload: { success: false, reason: '员工未打开泰康标签页' },
      }));
    }
    return;
  }
  const tab = tabs[0];
  if (tab.id) {
    chrome.tabs.sendMessage(tab.id, message);
    console.log('[寰宇探针] 指令已转发到标签页:', tab.id);
  }
}

// ─── 启动 ─────────────────────────────────────────────────────
connectWebSocket();
