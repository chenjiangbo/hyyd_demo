console.log('[寰宇探针] Background Service Worker 已启动');

let ws: WebSocket | null = null;
const DEFAULT_BACKEND_WS_URL = 'ws://47.95.14.233:9093/ws';
const CLIENT_TYPE = 'ext';
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let presenceTimer: ReturnType<typeof setInterval> | null = null;

type TaikangUser = {
  userId: number;
  userName: string;
  nickName: string | null;
};

// 缓存：泰康账号来自当前已登录页面，员工信息来自后端绑定结果。
let employeeName: string | null = null;
let backendWsUrl = DEFAULT_BACKEND_WS_URL;
let taikangUser: TaikangUser | null = null;
let connectionError: string | null = null;
let reconnectDelayMs = 5_000;

async function loadConfig() {
  const r = await chrome.storage.local.get(['backendWsUrl']);
  backendWsUrl = (r.backendWsUrl as string) || DEFAULT_BACKEND_WS_URL;
}

// ─── WebSocket 连接 ──────────────────────────────────────────
async function getTaikangUser(): Promise<TaikangUser | null> {
  const tabs = await chrome.tabs.query({ url: '*://ccm.taikang.com/*' });
  if (tabs.length === 0) {
    taikangUser = null;
    connectionError = '未检测到已打开的泰康系统页面';
    return null;
  }

  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_TAIKANG_USER' });
      const user = response?.user;
      if (response?.ok && typeof user?.userId === 'number' && typeof user?.userName === 'string' && user.userName.trim()) {
        taikangUser = {
          userId: user.userId,
          userName: user.userName.trim(),
          nickName: typeof user.nickName === 'string' ? user.nickName : null,
        };
        if (connectionError === '未检测到已打开的泰康系统页面' || connectionError === '未获取到泰康登录账号，请确认已登录并刷新泰康页面') {
          connectionError = null;
        }
        return taikangUser;
      }
    } catch {
      // 页面尚未注入 content script 时继续检查其他泰康标签页。
    }
  }

  taikangUser = null;
  connectionError = '未获取到泰康登录账号，请确认已登录并刷新泰康页面';
  return null;
}

async function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const user = await getTaikangUser();
  if (!user) {
    return;
  }

  const url = `${backendWsUrl}?taikangAccount=${encodeURIComponent(user.userName)}&taikangUserId=${encodeURIComponent(String(user.userId))}&client=${CLIENT_TYPE}`;
  console.log(`[寰宇探针] 以泰康账号 ${user.userName} 连接后端`);
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
        connectionError = null;
        reconnectDelayMs = 5_000;
        // 连接建立后主动拉一次基线（覆盖"content 早于 WS 连上时发的请求丢失"）
        requestFingerprintBaseline();
      }

      if (data.type === 'EMPLOYEE_BINDING_NOT_FOUND' || data.type === 'EMPLOYEE_BINDING_AMBIGUOUS') {
        employeeName = null;
        connectionError = data.error || '当前泰康账号未绑定寰宇员工';
        reconnectDelayMs = 60_000;
        console.error('[寰宇探针] 员工绑定失败:', connectionError);
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
    console.log(`[寰宇探针] 与后端断开，${reconnectDelayMs / 1000}s 后重连...`);
    ws = null;
    if (presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
    reconnectTimer = setTimeout(() => void connectWebSocket(), reconnectDelayMs);
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
          taikangAccount: taikangUser?.userName,
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
          taikangAccount: taikangUser?.userName,
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
          taikangAccount: taikangUser?.userName,
        }));
      }
      break;

    case 'GET_STATUS': {
      void (async () => {
        if (!taikangUser) await getTaikangUser();
        sendResponse({
          wsConnected: ws?.readyState === WebSocket.OPEN,
          employeeName,
          backendWsUrl,
          taikangAccount: taikangUser?.userName ?? null,
          taikangNickName: taikangUser?.nickName ?? null,
          connectionError,
        });
      })();
      return true;
    }
  }
});

// ─── 指纹基线（增量起点） ────────────────────────────────────
function requestFingerprintBaseline() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'GET_FINGERPRINTS', taikangAccount: taikangUser?.userName }));
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
  if (changes.backendWsUrl) {
    backendWsUrl = changes.backendWsUrl?.newValue ?? backendWsUrl;
    if (ws) ws.close();
    void connectWebSocket();
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
    void connectWebSocket();
  } else if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'ping' }));
    } catch {/* ignore */}
  }
});

// ─── 启动 ─────────────────────────────────────────────────────
void loadConfig().then(() => connectWebSocket()).catch((error) => {
  console.error('[寰宇探针] 加载后端配置失败:', error);
});
