console.log('[寰宇探针] Background Service Worker 已启动');

let ws: WebSocket | null = null;
const BACKEND_WS_URL = 'ws://localhost:13000/ws';
const EMPLOYEE_TOKEN = 'test-employee-token';
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// ─── WebSocket 连接 ──────────────────────────────────────────
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  console.log('[寰宇探针] 连接后端:', BACKEND_WS_URL);
  ws = new WebSocket(`${BACKEND_WS_URL}?token=${EMPLOYEE_TOKEN}`);

  ws.onopen = () => {
    console.log('[寰宇探针] 已连接后端');
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('[寰宇探针] 收到后端指令:', data);

      // 后端发来 CLAIM_ORDER 指令 → 转发给 content script
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
    reconnectTimer = setTimeout(connectWebSocket, 5000);
  };

  ws.onerror = (err) => {
    console.error('[寰宇探针] WebSocket 错误:', err);
  };
}

// ─── 监听 Content Script 消息 ────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender) => {
  switch (message.type) {
    // Content Script 上报的订单列表 → 转发给后端
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

    // Content Script 报告按钮点击结果 → 转发给后端
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
  }
});

// ─── 将指令转发给泰康标签页的 Content Script ─────────────────
async function forwardToTaikangTab(message: unknown) {
  // 查询所有泰康标签（不限制 active，因为员工可能没焦点在这个 tab）
  const tabs = await chrome.tabs.query({ url: '*://ccm.taikang.com/*' });
  if (tabs.length === 0) {
    console.warn('[寰宇探针] 未找到泰康标签页，请先打开 ccm.taikang.com');
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
