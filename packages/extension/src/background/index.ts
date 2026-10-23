import { countFormEvents, deleteFormEvent, nextFormEvent, queueFormEvent } from './formRecorderOutbox';
import { DEFAULT_BACKEND_WS_URL, configuredBackendWsUrl } from '../backendConnection';

console.log('[寰宇探针] Background Service Worker 已启动');

let ws: WebSocket | null = null;
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
let socketAccount: TaikangUser | null = null;
let connectionError: string | null = null;
let reconnectDelayMs = 5_000;
let socketReady = false;
let connectionAttempt: Promise<void> | null = null;
let collectorTabId: number | null = null;
let collectorGeneration = crypto.randomUUID();
let collectorHeartbeatAt = 0;
const COLLECTOR_LEASE_MS = 180_000;
type PendingMessage = { resolve: (value: any) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout>; socket: WebSocket };
const pendingMessages = new Map<string, PendingMessage>();
const pendingFormEvents = new Map<string, { resolve: (value: any) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let flushingFormEvents = false;
let formRecorderUploadError: string | null = null;
let screenshotQueue: Promise<void> = Promise.resolve();
let lastScreenshotAt = 0;
const connectionWaiters = new Set<{ resolve: () => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();

async function captureFormScreenshot(windowId: number, tabId: number, expectedUrl: string): Promise<string> {
  const capture = screenshotQueue.then(async () => {
    const wait = Math.max(0, lastScreenshotAt + 550 - Date.now());
    if (wait) await new Promise<void>((resolve) => setTimeout(resolve, wait));
    const selected = await chrome.tabs.query({ active: true, windowId });
    if (selected[0]?.id !== tabId || selected[0]?.url !== expectedUrl) {
      throw new Error('页面已切换，无法截取原操作画面');
    }
    lastScreenshotAt = Date.now();
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 85 });
    const stillSelected = await chrome.tabs.query({ active: true, windowId });
    if (stillSelected[0]?.id !== tabId || stillSelected[0]?.url !== expectedUrl) {
      throw new Error('截图期间页面已切换');
    }
    if (!dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('截图格式无效');
    return dataUrl;
  });
  screenshotQueue = capture.then(() => undefined, () => undefined);
  return capture;
}

function failPending(reason: string): void {
  for (const [id, pending] of pendingFormEvents) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingFormEvents.delete(id);
  }
  for (const [id, pending] of pendingMessages) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingMessages.delete(id);
  }
  for (const waiter of connectionWaiters) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(reason));
    connectionWaiters.delete(waiter);
  }
}

function resetCollector(): void {
  collectorGeneration = crypto.randomUUID();
  failPending('采集任务或登录账号已经变化');
  socketReady = false;
  employeeName = null;
  taikangUser = null;
  socketAccount = null;
  if (ws) { const old = ws; ws = null; old.close(); }
}

function isCurrentCollector(tabId: number | undefined, generation: string): boolean {
  return !!tabId && tabId === collectorTabId && generation === collectorGeneration &&
    Date.now() - collectorHeartbeatAt < COLLECTOR_LEASE_MS;
}

async function loadConfig() {
  const r = await chrome.storage.local.get(['backendWsUrl']);
  backendWsUrl = configuredBackendWsUrl(r.backendWsUrl);
}

// ─── WebSocket 连接 ──────────────────────────────────────────
async function getTaikangUser(): Promise<TaikangUser | null> {
  const allTabs = await chrome.tabs.query({ url: '*://ccm.taikang.com/*' });
  const tabs = collectorTabId ? allTabs.filter((tab) => tab.id === collectorTabId) : allTabs;
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

async function connectWebSocket(): Promise<void> {
  if (connectionAttempt) return connectionAttempt;
  connectionAttempt = (async () => {
  const user = await getTaikangUser();
  if (!user) {
    if (ws) resetCollector();
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    if (socketAccount?.userName === user.userName && socketAccount?.userId === user.userId) return;
    resetCollector();
  }

  taikangUser = user;
  socketAccount = user;
  const url = `${backendWsUrl}?taikangAccount=${encodeURIComponent(user.userName)}&taikangUserId=${encodeURIComponent(String(user.userId))}&client=${CLIENT_TYPE}`;
  console.log(`[寰宇探针] 以泰康账号 ${user.userName} 连接后端`);
  const socket = new WebSocket(url);
  ws = socket;
  socketReady = false;

  socket.onopen = () => {
    if (ws !== socket) return;
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

  socket.onmessage = (event) => {
    if (ws !== socket) return;
    try {
      const data = JSON.parse(event.data);
      console.log('[寰宇探针] 收到后端消息:', data);

      if (data.type === 'connection_established' && data.employee) {
        if (data.taikangAccount !== user.userName) { socket.close(); return; }
        employeeName = data.employee.name;
        socketReady = true;
        for (const waiter of connectionWaiters) {
          clearTimeout(waiter.timer);
          waiter.resolve();
          connectionWaiters.delete(waiter);
        }
        connectionError = null;
        reconnectDelayMs = 5_000;
        // 连接建立后主动拉一次基线（覆盖"content 早于 WS 连上时发的请求丢失"）
        requestFingerprintBaseline();
        void flushFormEvents();
      }

      if (data.type === 'EMPLOYEE_BINDING_NOT_FOUND' || data.type === 'EMPLOYEE_BINDING_AMBIGUOUS') {
        employeeName = null;
        connectionError = data.error || '当前泰康账号未绑定寰宇员工';
        reconnectDelayMs = 60_000;
        console.error('[寰宇探针] 员工绑定失败:', connectionError);
        failPending(connectionError);
      }

      if ((data.type === 'ORDERS_SYNCED_ACK' || data.type === 'ORDER_DETAIL_ACK') && typeof data.requestId === 'string') {
        const pending = pendingMessages.get(data.requestId);
        if (pending && pending.socket === socket) {
          clearTimeout(pending.timer);
          pendingMessages.delete(data.requestId);
          pending.resolve(data);
        }
      }

      if (data.type === 'TAIKANG_FORM_EVENT_ACK' && typeof data.requestId === 'string') {
        const pending = pendingFormEvents.get(data.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingFormEvents.delete(data.requestId);
          pending.resolve(data);
        }
      }

      // 后端返回的指纹基线 → 转发给泰康标签页的 content script
      if (data.type === 'FINGERPRINTS_BASELINE') {
        forwardBaselineToTabs(data.payload || {}, user.userName, data.requestId);
      }

      // 仅支持这一条显式白名单指令：按子订单号定位并打开订单。
      // 不携带表单字段，content script 也不会保存或提交。
      if (data.type === 'command' && data.action === 'open_taikang_order') {
        void forwardOpenTaikangOrderCommand(data);
      }
    } catch (e) {
      console.error('[寰宇探针] 解析后端消息失败', e);
    }
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    console.log(`[寰宇探针] 与后端断开，${reconnectDelayMs / 1000}s 后重连...`);
    ws = null;
    socketReady = false;
    socketAccount = null;
    failPending('后台连接已断开');
    if (presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
    reconnectTimer = setTimeout(() => void connectWebSocket(), reconnectDelayMs);
  };

  socket.onerror = (err) => {
    console.error('[寰宇探针] WebSocket 错误:', err);
  };
  })();
  try {
    await connectionAttempt;
  } finally {
    connectionAttempt = null;
  }
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

async function flushFormEvents(): Promise<void> {
  if (flushingFormEvents || !socketReady || ws?.readyState !== WebSocket.OPEN || !socketAccount) return;
  flushingFormEvents = true;
  try {
    for (;;) {
      const account = socketAccount;
      const socket = ws;
      if (!socket || !socketReady || socket.readyState !== WebSocket.OPEN || !account) return;
      const queued = await nextFormEvent(account.userName);
      if (!queued) {
        formRecorderUploadError = null;
        return;
      }
      if (queued.userId !== account.userId) {
        formRecorderUploadError = '录制账号与当前泰康账号不一致';
        return;
      }
      const response = await new Promise<any>((resolve, reject) => {
        const requestId = queued.eventId;
        const timer = setTimeout(() => {
          pendingFormEvents.delete(requestId);
          reject(new Error('后台未确认填报记录'));
        }, 30_000);
        pendingFormEvents.set(requestId, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify({
            type: 'TAIKANG_FORM_EVENT',
            requestId,
            taikangAccount: queued.account,
            taikangUserId: queued.userId,
            session: queued.session,
            event: queued.event,
            ...(queued.imageDataUrl ? { imageDataUrl: queued.imageDataUrl } : {}),
          }));
        } catch (error) {
          clearTimeout(timer);
          pendingFormEvents.delete(requestId);
          reject(error);
        }
      });
      if (!response?.ok) throw new Error(response?.error || '后台拒绝了填报记录');
      await deleteFormEvent(queued.eventId);
      formRecorderUploadError = null;
    }
  } catch (error) {
    formRecorderUploadError = error instanceof Error ? error.message : String(error);
    console.error('[寰宇探针][填报记录] 上传失败:', formRecorderUploadError);
  } finally {
    flushingFormEvents = false;
  }
}

async function ensureBackend(account: string, userId: number): Promise<WebSocket> {
  await connectWebSocket();
  if (socketAccount?.userName !== account || socketAccount.userId !== userId || !ws) {
    throw new Error('后台连接账号与本轮采集账号不一致');
  }
  const socket = ws;
  if (socketReady && socket.readyState === WebSocket.OPEN) return socket;
  await new Promise<void>((resolve, reject) => {
    const waiter = {
      resolve, reject,
      timer: setTimeout(() => {
        connectionWaiters.delete(waiter);
        reject(new Error('等待后台账号绑定超时'));
      }, 20_000),
    };
    connectionWaiters.add(waiter);
  });
  if (ws !== socket || !socketReady) throw new Error('后台连接已切换');
  return socket;
}

async function forwardCollection(message: any, tabId: number | undefined): Promise<any> {
  if (message.protocolVersion !== 2 || !isCurrentCollector(tabId, message.generation)) {
    throw new Error('旧采集任务已失效');
  }
  if (typeof message.account !== 'string' || !Number.isInteger(message.userId) ||
      typeof message.batchId !== 'string' || typeof message.requestId !== 'string') {
    throw new Error('采集消息缺少账号或批次');
  }
  const current = await getTaikangUser();
  if (current?.userName !== message.account || current.userId !== message.userId) {
    resetCollector();
    throw new Error('泰康实时账号与采集账号不一致');
  }
  const socket = await ensureBackend(message.account, message.userId);
  if (!isCurrentCollector(tabId, message.generation)) throw new Error('采集任务在等待连接期间失效');
  return new Promise((resolve, reject) => {
    const requestId = message.requestId;
    const timer = setTimeout(() => {
      pendingMessages.delete(requestId);
      reject(new Error('等待后台入库确认超时'));
    }, 300_000);
    pendingMessages.set(requestId, { resolve, reject, timer, socket });
    try {
      socket.send(JSON.stringify({
        type: message.type === 'SYNC_ORDERS' ? 'ORDERS_SYNCED' : 'ORDER_DETAIL_FETCHED',
        protocolVersion: 2,
        taikangAccount: message.account,
        taikangUserId: message.userId,
        batchId: message.batchId,
        requestId,
        payload: message.payload,
      }));
    } catch (error) {
      clearTimeout(timer);
      pendingMessages.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// ─── Content Script & Popup 消息 ─────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'RECORD_TAIKANG_FORM_EVENT':
    case 'RECORD_TAIKANG_FORM_SCREENSHOT': {
      void (async () => {
        const tabId = sender.tab?.id;
        if (!tabId || !sender.tab?.url?.startsWith('https://ccm.taikang.com/') ||
            typeof message.account !== 'string' || !Number.isInteger(message.userId) ||
            typeof message.event?.id !== 'string' ||
            typeof message.session?.startedAt !== 'string' ||
            !Number.isSafeInteger(message.event?.sequence) || message.event.sequence < 1) {
          throw new Error('录制页面或泰康账号无效');
        }
        const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_TAIKANG_USER' });
        if (!response?.ok || response.user?.userName !== message.account || response.user?.userId !== message.userId) {
          throw new Error('录制账号与泰康当前登录账号不一致');
        }
        let event = message.event;
        let imageDataUrl: string | undefined;
        let captureError: string | null = null;
        if (message.type === 'RECORD_TAIKANG_FORM_SCREENSHOT') {
          if (event.kind !== 'screenshot') throw new Error('截图事件格式无效');
          try {
            if (typeof event.payload?.href !== 'string') throw new Error('截图页面地址无效');
            imageDataUrl = await captureFormScreenshot(sender.tab.windowId, tabId, event.payload.href);
            event = { ...event, payload: { ...event.payload, capturedAt: new Date().toISOString() } };
          } catch (error) {
            captureError = error instanceof Error ? error.message : String(error);
            event = { ...event, kind: 'capture-error', payload: { ...event.payload, error: `截图失败：${captureError}` } };
          }
        }
        await queueFormEvent({
          eventId: event.id,
          queuedAt: Date.now(),
          account: message.account,
          userId: message.userId,
          session: message.session,
          event,
          ...(imageDataUrl ? { imageDataUrl } : {}),
        });
        sendResponse(captureError ? { ok: false, error: captureError } : { ok: true });
        void flushFormEvents();
      })().catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        formRecorderUploadError = detail;
        sendResponse({ ok: false, error: detail });
      });
      return true;
    }
    case 'CLAIM_COLLECTOR': {
      const tabId = sender.tab?.id;
      if (!tabId) { sendResponse({ ok: false }); return false; }
      if (collectorTabId !== tabId && (!collectorTabId || Date.now() - collectorHeartbeatAt >= COLLECTOR_LEASE_MS)) {
        if (collectorTabId) resetCollector();
        collectorTabId = tabId;
      }
      if (collectorTabId === tabId) collectorHeartbeatAt = Date.now();
      sendResponse({ ok: collectorTabId === tabId, generation: collectorGeneration });
      return false;
    }
    case 'INVALIDATE_COLLECTOR':
      if (isCurrentCollector(sender.tab?.id, message.generation)) resetCollector();
      sendResponse({ ok: true });
      return false;
    case 'SYNC_ORDERS':
    case 'ORDER_DETAIL_FETCHED':
      void forwardCollection(message, sender.tab?.id)
        .then((ack) => sendResponse(ack))
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;

    case 'TAIKANG_TOKEN_STATUS':
      // content script 保活探测的结果，转发给后端供托盘展示
      if (isCurrentCollector(sender.tab?.id, message.generation) &&
          message.account === socketAccount?.userName && socketReady && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'TAIKANG_TOKEN_STATUS',
          ok: !!message.ok,
          reason: message.reason ?? null,
          at: message.at ?? Date.now(),
        }));
      }
      break;

    case 'REQUEST_FINGERPRINT_BASELINE':
      if (isCurrentCollector(sender.tab?.id, message.generation)) {
        void ensureBackend(message.account, message.userId)
          .then(() => requestFingerprintBaseline(message.requestId)).catch(() => {});
      }
      break;

    case 'SYNC_FINGERPRINTS':
      // 旧版缓存不可证明详情完整，禁止回填指纹。
      break;

    case 'GET_STATUS': {
      void (async () => {
        if (!taikangUser) await getTaikangUser();
        const formRecorderPendingCount = await countFormEvents();
        sendResponse({
          wsConnected: socketReady && ws?.readyState === WebSocket.OPEN,
          employeeName,
          backendWsUrl,
          taikangAccount: socketAccount?.userName ?? taikangUser?.userName ?? null,
          taikangNickName: socketAccount?.nickName ?? taikangUser?.nickName ?? null,
          connectionError,
          formRecorderPendingCount,
          formRecorderUploadError,
        });
      })().catch((error) => sendResponse({
        error: error instanceof Error ? error.message : String(error),
        formRecorderUploadError: '填报记录状态读取失败'
      }));
      return true;
    }
  }
});

type OpenTaikangOrderSearchPlan = 'register_personal' | 'green_then_case_service';

function isOpenTaikangOrderSearchPlan(value: unknown): value is OpenTaikangOrderSearchPlan {
  return value === 'register_personal' || value === 'green_then_case_service';
}

async function forwardOpenTaikangOrderCommand(data: unknown): Promise<void> {
  const command = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const commandId = Number(command.commandId);
  const payload = command.payload && typeof command.payload === 'object'
    ? command.payload as Record<string, unknown>
    : {};
  const sourceOrderNo = typeof payload.sourceOrderNo === 'string' ? payload.sourceOrderNo.trim() : '';
  const searchPlan = payload.searchPlan;
  if (!Number.isInteger(commandId) || commandId <= 0 || !sourceOrderNo || !isOpenTaikangOrderSearchPlan(searchPlan)) {
    console.error('[寰宇探针] 忽略格式无效的泰康订单定位指令', data);
    return;
  }

  let ok = false;
  let result: unknown = undefined;
  let error: string | null = null;
  try {
    const tabs = await chrome.tabs.query({ url: '*://ccm.taikang.com/*' });
    const tab = tabs.find((item) => item.active && item.id) || tabs.find((item) => item.id);
    if (!tab?.id) throw new Error('未检测到已打开的泰康系统页面');
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'OPEN_TAIKANG_ORDER_ENTRY',
      sourceOrderNo,
      searchPlan,
    });
    if (!response?.ok) throw new Error(typeof response?.error === 'string' ? response.error : '泰康页面未能定位订单');
    ok = true;
    result = response.result;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    console.error('[寰宇探针] 泰康订单定位失败', { commandId, sourceOrderNo, error });
  }

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'TAIKANG_ORDER_OPEN_RESULT',
      commandId,
      ok,
      result,
      error,
    }));
  } else {
    console.warn('[寰宇探针] 泰康订单定位已结束但后端连接断开，结果未上报', { commandId, ok });
  }
}

// ─── 指纹基线（增量起点） ────────────────────────────────────
function requestFingerprintBaseline(requestId?: string) {
  if (socketReady && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'GET_FINGERPRINTS', taikangAccount: socketAccount?.userName, requestId }));
  }
}

async function forwardBaselineToTabs(payload: unknown, account: string, requestId?: string) {
  if (!collectorTabId || socketAccount?.userName !== account) return;
  await chrome.tabs.sendMessage(collectorTabId, { type: 'FINGERPRINT_BASELINE', account, requestId, payload })
    .catch(() => {/* 采集标签页已关闭 */});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== collectorTabId) return;
  collectorTabId = null;
  collectorHeartbeatAt = 0;
  resetCollector();
});

// ─── 监听配置变化 ────────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.backendWsUrl) {
    backendWsUrl = configuredBackendWsUrl(changes.backendWsUrl.newValue);
    resetCollector();
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
    void flushFormEvents();
  }
});

// ─── 启动 ─────────────────────────────────────────────────────
void loadConfig().then(() => connectWebSocket()).catch((error) => {
  console.error('[寰宇探针] 加载后端配置失败:', error);
});
