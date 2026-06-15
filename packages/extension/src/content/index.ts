console.log('[寰宇探针] Content Script 已注入');

// ════════════════════════════════════════════════════════════
// 个人池采集（接口直采，不解析 DOM）
//
// 工作流（每 5 分钟一轮，纯自动、只读）：
//   1. getInfo 拿泰康 userId（缓存）
//   2. 翻页拉全个人池列表 registerIndividualPool
//   3. 上报列表给后端（基础信息 + 状态，后端 upsert）
//   4. 对每条算「状态指纹」，与本地缓存比对：
//        新订单 / 状态变化 → 抓该单详情（recommendations + 辅助 + 图片）→ 上报
//        无变化 → 跳过，不重复抓详情
//
// 所有请求在 content script（页面上下文）发出，自动带泰康 cookie。
// ════════════════════════════════════════════════════════════

const UNIFY_BASE = 'https://ccm.taikang.com/ccm-unify/ccm-unify/ccm-unify';
const SYSTEM_BASE = 'https://ccm.taikang.com/ccm-unify/hssrmp';
// 挂号协助有独立的池接口；其余所有绿通业务走通用 individualPool。
const REGISTER_SERVICE_TYPE = '2000709';
// 与泰康订单详情页一致拉取常见附件类型。HAR 实测详情页会请求这些 fileType；
// 空结果由泰康接口正常返回，插件只保存真正带 fileUrl/fileId 的附件。
const FETCH_FILE_TYPES = ['40', '41', '5000', '5001', '5002', '100', '99', '5010', '5008', '5009'];

const POLL_INTERVAL_MS = 2 * 60 * 1000;
const POLL_FIRST_DELAY_MS = 3000;
const DETAIL_THROTTLE_MS = 3000; // 相邻订单详情抓取间隔，放慢到接近人工浏览，降低风控风险
const PAGE_SIZE = 20;
const MAX_PAGES = 50;

// ─── token 读取 ──────────────────────────────────────────────
// 泰康用 header `access_token` 认证，值存在 cookie `Admin-Token` 里。
function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function findTaikangToken(): string | null {
  const fromCookie =
    readCookie('Admin-Token') ?? readCookie('access_token') ?? readCookie('token');
  if (fromCookie) return fromCookie;
  const keys = ['access_token', 'token', 'Admin-Token', 'accessToken', 'Authorization'];
  for (const k of keys) {
    const v = localStorage.getItem(k) ?? sessionStorage.getItem(k);
    if (v && v.length > 0) return v;
  }
  return null;
}

// ─── 通用请求 ────────────────────────────────────────────────
class TaikangAuthError extends Error {}

// 泰康鉴权失败时 HTTP 仍返回 200，靠业务 code 区分。实测失效码（success:false）：
//   401101 ACCESS_DENIED        token 无效 / 被拒
//   401102 TOKEN_EXPIRED        token 过期（推测，同段）
//   401103 could not found token 未带 token
// 统一按 4011xx 鉴权段判定，正常响应 code=200 不会命中；
// 绝不用文本匹配（失效 message 含 "token"，正常响应也可能含敏感词，会互相误伤）。
function classifyByPayload(j: any): void {
  const code = Number(j?.code);
  if (code >= 401100 && code <= 401199) {
    const msg = j?.message ?? j?.msg ?? '';
    throw new TaikangAuthError(`${j?.code}:${msg}`);
  }
}

async function apiRequest(
  base: string,
  path: string,
  init: RequestInit,
  timeoutMs = 8000
): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const token = findTaikangToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (token) headers['access_token'] = token;
    const resp = await fetch(`${base}/${path}`, {
      credentials: 'include',
      ...init,
      headers,
      signal: ctrl.signal,
    });
    // 注：泰康即便鉴权失败也返回 HTTP 200（失效信号在业务 code，见 classifyByPayload）。
    // 这里的 401/302 仅作网关层兜底，正常不会命中。
    if (resp.status === 401 || resp.status === 302) {
      throw new TaikangAuthError(`HTTP_${resp.status}`);
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${path}`);
    const j = await resp.json();
    classifyByPayload(j);
    return j;
  } finally {
    clearTimeout(t);
  }
}

const apiPost = (base: string, path: string, body: unknown, timeoutMs?: number) =>
  apiRequest(base, path, { method: 'POST', body: JSON.stringify(body) }, timeoutMs);

const apiGet = (base: string, path: string, timeoutMs?: number) =>
  apiRequest(base, path, { method: 'GET' }, timeoutMs);

// 子接口失败不阻塞主流程（但鉴权错误要往上抛，触发红条）
async function safe<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof TaikangAuthError) throw e;
    console.warn('[寰宇探针] 子接口失败（已忽略）:', e);
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── 用户身份（泰康 userId / userName） ──────────────────────
let cachedUserId: number | null = null;
let cachedUserName: string | null = null; // 接口入参用的登录名（如 syx）
let cachedNickName: string | null = null; // 展示用（如 孙艳霞）

async function getUser(): Promise<{ userId: number; userName: string } | null> {
  if (cachedUserId && cachedUserName) {
    return { userId: cachedUserId, userName: cachedUserName };
  }
  const j = await apiGet(SYSTEM_BASE, 'system/user/getInfo');
  cachedUserId = j?.data?.userid ?? null;
  cachedUserName = j?.data?.username ?? null;
  cachedNickName = j?.data?.nickName ?? j?.data?.sysUser?.nickName ?? cachedUserName;
  if (cachedUserId && cachedUserName) {
    console.log(`[寰宇探针] 泰康用户: ${cachedNickName} (userId=${cachedUserId}, userName=${cachedUserName})`);
    return { userId: cachedUserId, userName: cachedUserName };
  }
  return null;
}

// ─── 个人池列表 ──────────────────────────────────────────────
// 通用翻页拉全：传入接口 path 和基础 body（不含 pageNum/pageSize）
// poolType: 挂号协助走 register；其余绿通业务（陪诊/住院/...）走 general。
// 给每条订单打上 __poolType 标签，后续合并去重不丢失来源信息。
async function fetchPoolAll(
  path: string,
  baseBody: Record<string, unknown>,
  poolType: 'register' | 'general'
): Promise<any[]> {
  const all: any[] = [];
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const j = await apiPost(UNIFY_BASE, path, { ...baseBody, pageNum, pageSize: PAGE_SIZE });
    const data = j?.data;
    const list: any[] = data?.list ?? [];
    for (const o of list) {
      if (o) (o as any).__poolType = poolType;
    }
    all.push(...list);
    if (!data?.hasNextPage) break;
  }
  return all;
}

// 同时拉两套池：挂号协助(registerIndividualPool) + 其余绿通业务(individualPool)，
// 按 subOrderNo 去重合并。同号不同池时优先保留挂号侧（rare 但偶发）。
async function fetchAllOrders(userId: number, userName: string): Promise<any[]> {
  const [register, others] = await Promise.all([
    fetchPoolAll(
      'medicalmanager/registerIndividualPool',
      { userId, serviceType: REGISTER_SERVICE_TYPE },
      'register'
    ),
    fetchPoolAll(
      'medicalmanager/individualPool',
      { userId, userName },
      'general'
    ),
  ]);
  const byOrderNo = new Map<string, any>();
  for (const o of [...others, ...register]) {
    // register 后写入会覆盖 general，保证挂号优先
    if (o?.subOrderNo) byOrderNo.set(o.subOrderNo, o);
  }
  return [...byOrderNo.values()];
}

// ─── 单订单详情 ──────────────────────────────────────────────
// 统一只调 recommendations（所有业务返回结构一致的大对象）+ ecm/getImage。
// 各业务专属辅助接口的数据基本都已包含在 recommendations 的子结构里，
// 不再按业务类型分支调用，一套逻辑通吃所有绿通业务。
async function fetchOrderDetail(userId: number, order: any): Promise<any> {
  const subOrderNo = order.subOrderNo;
  const applyNo = order.applyNo;
  // 两种业务的入参不同（挂号协助用 caseStatus，其余用 orderState），列表项里都有，
  // 一并带上以兼容所有业务。
  const recResp = await apiPost(UNIFY_BASE, 'medicalmanager/recommendations', {
    userId,
    subOrderNo,
    applyNo,
    orderState: order.orderState == null ? '' : String(order.orderState),
    caseStatus: order.caseStatus == null ? 'null' : String(order.caseStatus),
  });
  const rec = recResp?.data ?? null;
  if (!rec) {
    throw new Error('EMPTY_DETAIL: recommendations 未返回详情数据');
  }

  // 证件图片：每种 fileType 各拉一次，fileUrl 实际是 base64
  const imgPages = await Promise.all(
    FETCH_FILE_TYPES.map((ft) =>
      safe(apiPost(UNIFY_BASE, 'ecm/getImage', { subOrderNo, fileType: ft, pageNum: 1, pageSize: 5 }))
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
    detail: { recommendations: rec },
    attachments,
  };
}

// ─── 列表项 → 上报给后端的精简结构 ──────────────────────────
function toReportedOrder(o: any) {
  return {
    sourceOrderNo: o.subOrderNo,
    orderId: o.subOrderNo, // 兼容旧字段
    poolType: o.__poolType, // 'register' | 'general'，给 trayapp 分 tab 用
    applyNo: o.applyNo,
    crmApplyNo: o.crmApplyNo,
    caseId: o.caseId,
    status: o.orderStateName,
    orderState: o.orderState,
    caseStatus: o.caseStatus,
    serviceType: o.serviceName || o.itemName, // 业务可读名（陪诊/住院/挂号协助...）
    patientName: o.patientName,
    insurName: o.insurName,
    sex: o.sex,
    // 客户手机号：泰康个人池列表里多个字段名都见过，按优先级兜底。
    // 列表接口若不返回，则为 null，等订单详情 caseInfo.paMobile 入库后补。
    paMobile:
      o.paMobile ||
      o.patientMobile ||
      o.patientPhone ||
      o.mobile ||
      o.phone ||
      o.contactPhone ||
      null,
    hospital: o.intendHos || o.clinicHos || null,
    dept: o.intendDept || o.clinicDept || null,
    doctor: o.intendDoc || null,
    intendDate: o.intendDate || null,
    intendDateAmorpm: o.intendDateAmorpm || null,
    networkTag: o.labelName,
    planName: o.planName,
    planAlias: o.planAlias,
    packetName: o.packetName,
    productName: o.productName,
    itemName: o.itemName,
    applyTime: o.applyDate || o.applicationDate || null,
    applicationDate: o.applicationDate,
    mmgrApplyDate: o.mmgrApplyDate,
    rawJson: o,
  };
}

// ─── 增量调度 ────────────────────────────────────────────────
// 状态指纹：状态码 + 状态名 + 关键时间戳，任一变化即重新抓详情。
// 持久化到 chrome.storage.local，使 content script 重启（页面刷新/重开标签）
// 后仍记得已抓过的订单及其状态，避免每次重启都全量重抓。
const FINGERPRINT_STORAGE_KEY = 'orderFingerprints';
const lastFingerprint = new Map<string, string>();

// 指纹只用订单状态机字段。时间字段（mmgrApplyDate 等）经实测要么是批量固定值、
// 要么是 null，对"判断订单是否更新"无贡献，故去掉。orderState 是状态机核心，
// 订单推进时必变，是最可靠的增量信号。
function fingerprint(o: any): string {
  return [o.orderState, o.orderStateName, o.caseStatus]
    .map((v) => (v == null ? '' : String(v)))
    .join('|');
}

async function loadFingerprints(): Promise<void> {
  try {
    const r = await chrome.storage.local.get(FINGERPRINT_STORAGE_KEY);
    const obj = r[FINGERPRINT_STORAGE_KEY];
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') lastFingerprint.set(k, v);
      }
      console.log(`[寰宇探针] 已加载 ${lastFingerprint.size} 条订单指纹缓存`);
    }
  } catch (e) {
    console.warn('[寰宇探针] 加载指纹缓存失败:', e);
  }
}

async function saveFingerprints(): Promise<void> {
  try {
    await chrome.storage.local.set({
      [FINGERPRINT_STORAGE_KEY]: Object.fromEntries(lastFingerprint),
    });
  } catch (e) {
    console.warn('[寰宇探针] 保存指纹缓存失败:', e);
  }
}

// 把本地已知的全部指纹推给后端对账（不只新抓的）。
// 否则：本地缓存命中而被跳过的订单，其指纹永远进不了后端，
// 换机/清缓存时仍要重抓这些订单。
function syncFingerprintsToBackend() {
  if (lastFingerprint.size === 0) return;
  chrome.runtime.sendMessage({
    type: 'SYNC_FINGERPRINTS',
    payload: Object.fromEntries(lastFingerprint),
  });
}

let polling = false;

async function pollOnce(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const user = await getUser();
    if (!user) {
      console.warn('[寰宇探针] 未获取到泰康用户信息，跳过本轮');
      return;
    }
    const { userId, userName } = user;

    // 列表接口能成功拉到 = 登录态有效。登录判定只看这里，
    // 详情阶段的个别失败不上升为"全局过期"。
    const orders = await fetchAllOrders(userId, userName);
    onAuthOk();

    // 1. 上报全量列表（后端 upsert）
    chrome.runtime.sendMessage({
      type: 'SYNC_ORDERS',
      payload: orders.map(toReportedOrder),
    });

    // 2. 增量筛选需要抓详情的订单
    const changed = orders.filter((o) => {
      if (!o.subOrderNo) return false;
      return lastFingerprint.get(o.subOrderNo) !== fingerprint(o);
    });
    console.log(
      `[寰宇探针] 个人池 ${orders.length} 条，需抓详情 ${changed.length} 条`
    );

    // 3. 串行抓详情（限流）。详情失败（含鉴权）只跳过该单，不报全局过期。
    // 边抓边存指纹：每 10 条落一次盘 + 结束落一次，避免首轮几百条抓到一半
    // 被刷新/抖断时整轮进度丢失、下次又全量重抓。
    let savedSinceFlush = 0;
    for (const o of changed) {
      try {
        const fp = fingerprint(o);
        const bundle = await fetchOrderDetail(userId, o);
        chrome.runtime.sendMessage({
          type: 'ORDER_DETAIL_FETCHED',
          payload: {
            sourceOrderNo: o.subOrderNo,
            detail: bundle.detail,
            attachments: bundle.attachments,
            fingerprint: fp, // 一并上报，后端存为增量基线
          },
        });
        // 仅成功才更新指纹，失败下轮重试
        lastFingerprint.set(o.subOrderNo, fp);
        savedSinceFlush++;
        console.log(
          `[寰宇探针] 详情已上报: ${o.subOrderNo} 附件=${bundle.attachments.length}`
        );
        if (savedSinceFlush >= 10) {
          await saveFingerprints();
          savedSinceFlush = 0;
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        console.error(`[寰宇探针] 抓详情失败 ${o.subOrderNo}:`, err);
        chrome.runtime.sendMessage({
          type: 'ORDER_DETAIL_FETCHED',
          payload: { sourceOrderNo: o.subOrderNo, error: err },
        });
        // 若是鉴权类错误，可能 token 刚好过期，中断本轮剩余详情，等下轮重试
        if (e instanceof TaikangAuthError) break;
      }
      await sleep(DETAIL_THROTTLE_MS);
    }
    // 收尾：把未落盘的指纹补存一次，并把全量指纹同步给后端对账
    if (savedSinceFlush > 0) await saveFingerprints();
    syncFingerprintsToBackend();
  } catch (e) {
    if (e instanceof TaikangAuthError) {
      onAuthFail(e.message);
    } else {
      console.error('[寰宇探针] 轮询异常:', e);
    }
  } finally {
    polling = false;
  }
}

// ─── 登录态状态处理 ──────────────────────────────────────────
// 泰康 access token 短命、靠前端自动 refresh 续期。我们的轮询偶尔会撞上
// "token 刚过期、前端尚未刷新"的窗口而单次失败。因此不单次失败就报警：
// 连续 N 轮（含一次 30s 快速重试）都失败才认定真过期。
const AUTH_FAIL_THRESHOLD = 2;
const AUTH_RETRY_DELAY_MS = 30_000;
let authFailStreak = 0;
let authRetryTimer: ReturnType<typeof setTimeout> | null = null;

function onAuthOk() {
  authFailStreak = 0;
  if (authRetryTimer) {
    clearTimeout(authRetryTimer);
    authRetryTimer = null;
  }
  removeExpiredBanner();
  chrome.runtime.sendMessage({ type: 'TAIKANG_TOKEN_STATUS', ok: true, at: Date.now() });
}

function onAuthFail(reason: string) {
  authFailStreak++;
  console.warn(
    `[寰宇探针] 登录态校验失败 (${authFailStreak}/${AUTH_FAIL_THRESHOLD}): ${reason}`
  );
  if (authFailStreak < AUTH_FAIL_THRESHOLD) {
    // 可能只是 token 短暂过期、前端还没 refresh —— 30s 后快速重试，先不报警
    if (authRetryTimer) clearTimeout(authRetryTimer);
    authRetryTimer = setTimeout(() => void pollOnce(), AUTH_RETRY_DELAY_MS);
    return;
  }
  // 连续多轮确认失败，才认定真过期
  cachedUserId = null;
  cachedUserName = null;
  cachedNickName = null;
  showExpiredBanner();
  chrome.runtime.sendMessage({ type: 'TAIKANG_TOKEN_STATUS', ok: false, reason });
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
  bar.textContent =
    '⚠【寰宇采集】检测到泰康登录态多次失效，采集已暂停。若你仍能正常使用泰康，可忽略本提示；否则请重新登录，登录后自动恢复。';
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

// ─── 启动 ─────────────────────────────────────────────────────
let pollingStarted = false;
function startPolling() {
  if (pollingStarted) return;
  pollingStarted = true;
  setTimeout(() => void pollOnce(), POLL_FIRST_DELAY_MS);
  setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
}

// 接收 background 经 WS 取回的后端指纹基线。
// 这是避免"刷新/换机时全量重抓泰康"的关键：本地无缓存时也能从后端拿到
// 已采订单的状态指纹，只对新增/状态变化的订单访问泰康。
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'FINGERPRINT_BASELINE' && msg.payload && typeof msg.payload === 'object') {
    let added = 0;
    for (const [k, v] of Object.entries(msg.payload)) {
      // 本地已有的指纹更"新"，不被后端覆盖
      if (typeof v === 'string' && !lastFingerprint.has(k)) {
        lastFingerprint.set(k, v);
        added++;
      }
    }
    console.log(
      `[寰宇探针] 已从后端载入指纹基线 ${Object.keys(msg.payload).length} 条（合并新增 ${added}）`
    );
    void saveFingerprints();
    // 反向对账：把本地有、后端可能缺的指纹补推给后端
    syncFingerprintsToBackend();
    startPolling();
  }
});

// 先加载本地缓存，再向后端请求基线；基线到达或 5s 兜底后开始轮询。
void (async () => {
  await loadFingerprints();
  chrome.runtime.sendMessage({ type: 'REQUEST_FINGERPRINT_BASELINE' });
  setTimeout(startPolling, 5000);
})();
