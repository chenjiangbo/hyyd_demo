import { getPinganApiBusinessCode, getPinganContentItem, isPinganOrderCompleted, isPinganOrderStatusInScope, oneMonthBefore, parseOrderDetail, parseOrderListPage, parsePinganCurrentHandler, parsePinganIdentity, pinganAttachmentFileKey, pinganFileTokenParams, pinganOrderDetailWaitMs, shouldCapturePinganOrderDetails, unwrapPinganResponse } from './api';
import {
  PINGAN_ORDER_TYPES,
  PINGAN_POLL_INTERVAL_MS,
  type PinganEvent,
  type PinganOrder,
  type PinganApiProbeEvent,
  type PinganProbeMessage,
  type PinganApiRequestMessage,
  type PinganApiResultMessage,
  type PinganRunStatus,
  type PinganIdentity,
} from './types';

const LOG = '[可米探针][平安]';
const API_TIMEOUT_MS = 30_000;
const DETAIL_TIMEOUT_MS = 45_000;
const SESSION_KEEPALIVE_INTERVAL_MS = 2 * 60 * 1000;
const SESSION_KEEPALIVE_RETRY_MS = 30_000;
const PINGAN_LAST_DETAIL_START_KEY = 'pinganLastOrderDetailGroupStartedAt';
let activeRun: Promise<void> | null = null;
let loggedIn = false;
let availableOrderTypes = new Set<string>();
let loginTimer: ReturnType<typeof setTimeout> | null = null;
let lastStatus: PinganRunStatus | null = null;
let observedListPage = false;
let pinganIdentity: PinganIdentity | null = null;
let pinganBackendReady = false;
let collectorEmployeeId: number | null = null;
let sessionKeepaliveInFlight = false;
let sessionKeepaliveFailures = 0;
let sessionKeepaliveRetry: ReturnType<typeof setTimeout> | null = null;
const apiRequestWaiters = new Map<string, {
  resolve: (result: PinganApiResultMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

console.info(`${LOG} 内容脚本已加载`, location.hash.split('?')[0]);
window.addEventListener('message', (event: MessageEvent<PinganProbeMessage>) => {
  if (event.source !== window || event.data?.source !== 'HYYD_PINGAN_PROBE') return;
  if (event.data.payload.kind === 'api-result') {
    const result = event.data.payload;
    const waiter = apiRequestWaiters.get(result.requestId);
    if (waiter) {
      apiRequestWaiters.delete(result.requestId);
      clearTimeout(waiter.timer);
      if (result.error) waiter.reject(new Error(result.error));
      else waiter.resolve(result);
    }
    const code = getPinganApiBusinessCode(result.response);
    const statCode = Number((result.response as Record<string, any> | undefined)?.stat?.code);
    const apiFailed = Boolean(result.error) || (result.httpStatus ?? 0) >= 400 ||
      (code !== undefined && Number(code) !== 0) || (Number.isFinite(statCode) && statCode !== 0);
    const requestParam = result.requestParam;
    void logEvent(apiFailed ? 'error' : 'info', 'api',
      result.error ? `接口 ${result.method} 请求失败：${result.error}` : `接口 ${result.method} 返回 HTTP ${result.httpStatus}，业务码 ${String(code ?? '缺失')}`,
      {
        method: result.method,
        httpStatus: result.httpStatus,
        businessCode: code,
        durationMs: Math.round(result.durationMs),
        ...(typeof requestParam.orderId === 'string' ? { orderId: requestParam.orderId } : {}),
        ...(typeof requestParam.orderType === 'string' ? { orderType: requestParam.orderType } : {}),
        ...(Number.isInteger(Number(requestParam.pageNum)) ? { pageNum: Number(requestParam.pageNum) } : {}),
      });
    return;
  }
  void handleApiEvent(event.data.payload).catch((error) => {
    const message = safeError(error);
    console.error(`${LOG} 接口事件处理失败`, message);
    void logEvent('error', 'api_event_failed', message, { method: event.data.payload.kind === 'api-response' ? event.data.payload.method : undefined })
      .catch((logError) => console.error(`${LOG} 记录错误失败`, safeError(logError)));
    void updateStatus({ state: 'error', lastError: message, errorCount: (lastStatus?.errorCount ?? 0) + 1 });
  });
});

function runtimeMessage<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response?.ok) reject(new Error(response?.error || '扩展本机服务返回失败'));
      else resolve(response as T);
    });
  });
}

async function uploadPinganRun(run: Record<string, unknown>): Promise<void> {
  if (!pinganIdentity) return;
  await runtimeMessage({
    type: 'PINGAN_BACKEND_RUN',
    pinganUserId: pinganIdentity.pinganUserId,
    run: { ...run, collectorDisplayName: pinganIdentity.displayName },
  });
  await logEvent('info', 'backend_run_uploaded', `采集批次（${String(run.state ?? '状态更新')}）已上传到后台`);
}

async function uploadPinganPage(page: Record<string, unknown>): Promise<void> {
  if (!pinganBackendReady || !pinganIdentity) return;
  await runtimeMessage({ type: 'PINGAN_BACKEND_PAGE', pinganUserId: pinganIdentity.pinganUserId, page });
  await logEvent('info', 'backend_page_uploaded', `列表页 ${String(page.pageNum)} 已上传后台，共 ${String(page.rowCount)} 条`, {
    orderType: typeof page.orderType === 'string' ? page.orderType : undefined,
    pageNum: typeof page.pageNum === 'number' ? page.pageNum : undefined,
  });
}

async function uploadPinganOrder(order: PinganOrder): Promise<void> {
  const runId = lastStatus?.runId;
  if (!pinganBackendReady || !pinganIdentity || !runId || collectorEmployeeId === null) return;
  const response = await runtimeMessage<{
    ok: true;
    data: { outcome: 'created' | 'status_updated' | 'unchanged'; storedAttachmentIds: string[] };
  }>({ type: 'PINGAN_BACKEND_ORDER', pinganUserId: pinganIdentity.pinganUserId, runId, order });
  if (!response.data || !['created', 'status_updated', 'unchanged'].includes(response.data.outcome) ||
      !Array.isArray(response.data.storedAttachmentIds) || response.data.storedAttachmentIds.some((id) => typeof id !== 'string')) {
    throw new Error('后台未确认订单是否已入库及已存附件');
  }
  const storedAttachmentIds = new Set(response.data.storedAttachmentIds);
  await logEvent('info', response.data.outcome === 'created' ? 'backend_order_uploaded' : 'backend_order_status_checked',
    response.data.outcome === 'created' ? '新订单已上传后台' : response.data.outcome === 'status_updated' ? '后台订单状态已更新，其他信息保持不变' : '后台已有该订单，状态未变化',
    { orderId: order.orderId, orderType: order.orderType });
  for (const attachmentId of order.attachmentKeys) {
    if (storedAttachmentIds.has(attachmentId)) continue;
    await runtimeMessage({
      type: 'PINGAN_BACKEND_ATTACHMENT',
      pinganUserId: pinganIdentity.pinganUserId,
      orderId: order.orderId,
      runId,
      attachmentId,
    });
    await logEvent('info', 'backend_attachment_uploaded', `附件 ${attachmentId} 已上传后台`, {
      orderId: order.orderId,
      orderType: order.orderType,
    });
    storedAttachmentIds.add(attachmentId);
  }
  order.backendSyncedAt = new Date().toISOString();
  order.backendCollectorEmployeeId = collectorEmployeeId;
  await runtimeMessage({ type: 'PINGAN_SAVE_ORDER', order });
  await logEvent('info', 'backend_order_saved', '订单及附件已同步到后台', { orderId: order.orderId, orderType: order.orderType });
}

function requestPinganApi(method: string, params: Record<string, unknown> = {}, timeout = API_TIMEOUT_MS): Promise<PinganApiResultMessage> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      apiRequestWaiters.delete(requestId);
      reject(new Error(`等待平安接口 ${method} 超时`));
    }, timeout);
    apiRequestWaiters.set(requestId, { resolve, reject, timer });
    const message: PinganApiRequestMessage = { source: 'HYYD_PINGAN_API_REQUEST', requestId, method, params };
    window.postMessage(message, '*');
  });
}

async function keepPinganSessionAlive(): Promise<void> {
  if (!loggedIn || sessionKeepaliveInFlight) return;
  sessionKeepaliveInFlight = true;
  try {
    const result = await requestPinganApi('user.getUserInfo');
    const identity = parsePinganIdentity(result.response);
    if (pinganIdentity && identity.pinganUserId !== pinganIdentity.pinganUserId) {
      throw new Error('平安登录账号已变化');
    }
    pinganIdentity = identity;
    sessionKeepaliveFailures = 0;
    if (sessionKeepaliveRetry) {
      clearTimeout(sessionKeepaliveRetry);
      sessionKeepaliveRetry = null;
    }
  } catch (error) {
    sessionKeepaliveFailures++;
    const message = safeError(error);
    await logEvent('error', 'session_keepalive_failed', `平安登录态探测失败（${sessionKeepaliveFailures}/2）：${message}`);
    if (sessionKeepaliveFailures >= 2) {
      loggedIn = false;
      await updateStatus({ state: 'waiting_login', pinganUserId: undefined, lastError: '平安登录状态已失效，请重新登录' });
    } else if (!sessionKeepaliveRetry) {
      sessionKeepaliveRetry = setTimeout(() => {
        sessionKeepaliveRetry = null;
        void keepPinganSessionAlive();
      }, SESSION_KEEPALIVE_RETRY_MS);
    }
  } finally {
    sessionKeepaliveInFlight = false;
  }
}

async function handleApiEvent(payload: PinganApiProbeEvent): Promise<void> {
  const businessCode = getPinganApiBusinessCode(payload.response);
  const param = payload.requestParam ?? {};
  const orderId = typeof param.orderId === 'string' ? param.orderId : undefined;
  const orderType = typeof param.orderType === 'string' ? param.orderType : undefined;
  const pageNum = Number.isInteger(Number(param.pageNum)) ? Number(param.pageNum) : undefined;
  const statCode = Number((payload.response as Record<string, any> | undefined)?.stat?.code);
  const failed = payload.httpStatus < 200 || payload.httpStatus >= 300 ||
    (businessCode !== undefined && Number(businessCode) !== 0) || (Number.isFinite(statCode) && statCode !== 0);
  const event: PinganEvent = {
    id: crypto.randomUUID(),
    runId: lastStatus?.runId ?? 'page-session',
    at: payload.at,
    level: failed ? 'error' : 'info',
    kind: 'api',
    ...(orderId ? { orderId } : {}),
    ...(orderType ? { orderType } : {}),
    ...(pageNum ? { pageNum } : {}),
    method: payload.method,
    httpStatus: payload.httpStatus,
    ...(businessCode !== undefined ? { businessCode } : {}),
    durationMs: Math.round(payload.durationMs),
    ...(failed ? { message: `接口 ${payload.method} 返回失败` } : {}),
  };
  await runtimeMessage({ type: 'PINGAN_SAVE_EVENT', event });
  if ((payload.method === 'roger.getMyMerchantList' || payload.method === 'user.getUserInfo') && !failed) {
    if (payload.method === 'user.getUserInfo') pinganIdentity = parsePinganIdentity(payload.response);
    loggedIn = true;
    if (isOrderListPage()) void runIfReady();
  }
  if (payload.method === 'roger.getOrderTypeList' && !failed) {
    const dictionary = unwrapPinganResponse(payload.response, payload.method);
    if (!Array.isArray(dictionary)) throw new Error('平安订单类型字典不是数组');
    availableOrderTypes = new Set(dictionary.map((item) => String((item as Record<string, unknown>)?.code ?? '')));
    const missing = PINGAN_ORDER_TYPES.filter((item) => !availableOrderTypes.has(item.code));
    if (missing.length) throw new Error(`平安类型字典缺少已配置类型：${missing.map((item) => item.code).join(', ')}`);
    loggedIn = true;
    await runtimeMessage({ type: 'PINGAN_SAVE_RUN', run: {
      id: `types:${payload.at}`,
      capturedAt: payload.at,
      orderTypes: dictionary,
      activeOrderTypes: PINGAN_ORDER_TYPES.map((item) => item.code),
    } });
    void runIfReady();
  }
}

async function runIfReady(): Promise<void> {
  if (!loggedIn || !isOrderListPage() || activeRun) return;
  activeRun = runCollection().catch(async (error) => {
    const message = safeError(error);
    console.error(`${LOG} 本轮采集失败`, message);
    const failedType = PINGAN_ORDER_TYPES.find((item) => item.name === lastStatus?.currentType);
    await logEvent('error', 'run_failed', message, {
      ...(failedType ? { orderType: failedType.code } : {}),
      ...(lastStatus?.currentPage ? { pageNum: lastStatus.currentPage } : {}),
    });
    if (lastStatus?.runId) {
      const failedRun = {
        id: lastStatus.runId,
        startedAt: lastStatus.startedAt,
        completedAt: new Date().toISOString(),
        installDate: lastStatus.installDate,
        scanStartDate: lastStatus.scanStartDate,
        scanEndDate: lastStatus.scanEndDate,
        state: 'error',
        error: message,
      };
      await runtimeMessage({ type: 'PINGAN_SAVE_RUN', run: failedRun });
      if (pinganBackendReady && pinganIdentity) {
        await uploadPinganRun(failedRun).catch((uploadError) => {
          void logEvent('error', 'backend_run_upload_failed', safeError(uploadError));
        });
      }
    }
    return updateStatus({ state: 'error', lastError: message, errorCount: (lastStatus?.errorCount ?? 0) + 1 });
  }).finally(() => {
    activeRun = null;
  });
  await activeRun;
}

async function runCollection(): Promise<void> {
  pinganBackendReady = false;
  collectorEmployeeId = null;
  const installDate = await getInstallDate();
  const startedAt = new Date().toISOString();
  const scanEndDate = beijingDateString(new Date(startedAt));
  const scanStartDate = oneMonthBefore(scanEndDate);
  const runId = crypto.randomUUID();
  const initialRun = {
    id: runId, startedAt, installDate, scanStartDate, scanEndDate,
    state: 'running', orderTypes: PINGAN_ORDER_TYPES.map((item) => item.code),
  };
  await runtimeMessage({ type: 'PINGAN_SAVE_RUN', run: initialRun });
  await updateStatus({
    state: 'running', installDate, scanStartDate, scanEndDate, startedAt, runId, currentType: undefined,
    currentPage: 0, pageCount: 0, listCount: 0, detailCount: 0,
    decryptedFieldCount: 0, attachmentCount: 0, errorCount: 0, lastError: undefined,
    pinganUserId: undefined, backendAccountState: undefined, backendError: undefined,
  });

  const identityResponse = await requestPinganApi('user.getUserInfo');
  pinganIdentity = parsePinganIdentity(identityResponse.response);
  await updateStatus({ pinganUserId: pinganIdentity.pinganUserId });
  try {
    const identity = await runtimeMessage<{ ok: true; data: { pinganUserId: string; collectorEmployeeId: number } }>({
      type: 'PINGAN_BACKEND_IDENTIFY',
      pinganUserId: pinganIdentity.pinganUserId,
      displayName: pinganIdentity.displayName,
    });
    if (!Number.isInteger(identity.data.collectorEmployeeId) || identity.data.collectorEmployeeId <= 0) {
      throw new Error('后台没有返回有效的采集员工');
    }
    collectorEmployeeId = identity.data.collectorEmployeeId;
    await uploadPinganRun(initialRun);
    pinganBackendReady = true;
    await updateStatus({ backendAccountState: 'registered' });
    await logEvent('info', 'backend_account_registered', '平安采集账号已登记，订单将按当前处理人归属');
  } catch (error) {
    pinganBackendReady = false;
    await updateStatus({ backendAccountState: 'offline', backendError: safeError(error) });
    await logEvent('error', 'backend_identify_failed', `后台账号登记失败：${safeError(error)}`);
    await logEvent('error', 'backend_upload_blocked', '平安账号登记未成功，本轮采集数据不会上传后台');
  }

  const merchantResult = await requestPinganApi('roger.getMyMerchantList');
  const merchantModel = unwrapPinganResponse(merchantResult.response, 'roger.getMyMerchantList');
  if (!Array.isArray(merchantModel)) throw new Error('商户列表接口返回非数组');
  const selectedMerchantText = localStorage.getItem('myMerchant');
  if (!selectedMerchantText) throw new Error('平安页面没有已选商户 myMerchant');
  let selectedMerchant: Record<string, unknown>;
  try {
    selectedMerchant = JSON.parse(selectedMerchantText) as Record<string, unknown>;
  } catch {
    throw new Error('平安页面已选商户 myMerchant 不是有效 JSON');
  }
  const merchantId = selectedMerchant.merchantId;
  if (merchantId == null || String(merchantId) === '') throw new Error('当前商户记录缺少 merchantId');
  if (merchantModel.filter((item) => String((item as Record<string, unknown>)?.merchantId ?? '') === String(merchantId)).length !== 1) {
    throw new Error('页面已选商户与平安商户接口列表不匹配');
  }

  const typeResult = await requestPinganApi('roger.getOrderTypeList');
  const typeModel = unwrapPinganResponse(typeResult.response, 'roger.getOrderTypeList');
  if (!Array.isArray(typeModel)) throw new Error('平安订单类型字典不是数组');
  availableOrderTypes = new Set(typeModel.map((item) => String((item as Record<string, unknown>)?.code ?? '')));
  const missing = PINGAN_ORDER_TYPES.filter((item) => !availableOrderTypes.has(item.code));
  if (missing.length) throw new Error(`未确认订单类型字典包含：${missing.map((item) => item.code).join(', ')}`);
  let listCount = 0;
  let detailCount = 0;
  let decryptedFieldCount = 0;
  let attachmentCount = 0;
  let errorCount = 0;
  let uniqueOrderCount = 0;
  for (const type of PINGAN_ORDER_TYPES) {
    const typeOrderIds = new Set<string>();
    await updateStatus({ currentType: type.name, currentPage: 0, pageCount: 0 });
    await logEvent('info', 'query_started', `开始查询 ${type.name}，创建日期 ${scanStartDate} 至 ${scanEndDate}`, { orderType: type.code });
    await updateStatus({ currentPage: 1 });
    let listResponse = await queryList(type.code, 1, scanStartDate, scanEndDate, startedAt, merchantId);
    let page = 1;
    let expectedPageCount = 0;
    let typeTotal = -1;
    while (true) {
      const parsed = parseOrderListPage(listResponse.response, page);
      if (parsed.orders.some((order) => order.orderType !== type.code)) {
        throw new Error(`${type.name} 查询返回了其他订单类型`);
      }
      if (typeTotal < 0) {
        typeTotal = parsed.total;
        expectedPageCount = parsed.pageCount;
      } else if (typeTotal !== parsed.total || expectedPageCount !== parsed.pageCount) {
        throw new Error(`${type.name} 扫描期间总量或页数发生变化，当前批次未完成`);
      }
      const pageRecord = {
        id: `${runId}:${type.code}:${page}`,
        runId,
        orderType: type.code,
        pageNum: page,
        pageCount: parsed.pageCount,
        pageSize: parsed.pageSize,
        total: parsed.total,
        rowCount: parsed.orders.length,
        orderIds: parsed.orders.map((order) => order.orderId),
        query: {
          merchantId: listResponse.requestParam.merchantId,
          orderType: listResponse.requestParam.orderType,
          status: listResponse.requestParam.status ?? null,
          createTimeStart: listResponse.requestParam.createTimeStart,
          createTimeEnd: listResponse.requestParam.createTimeEnd,
          pageNum: listResponse.requestParam.pageNum,
          pageSize: listResponse.requestParam.pageSize,
        },
        state: 'list_saved',
        capturedAt: listResponse.at,
      };
      await runtimeMessage({ type: 'PINGAN_SAVE_PAGE', page: pageRecord });
      await uploadPinganPage(pageRecord).catch((error) => {
        void logEvent('error', 'backend_page_upload_failed', safeError(error), { orderType: type.code, pageNum: page });
      });
      await logEvent('info', 'list_page_saved', parsed.total === 0
        ? `${type.name} 当前查询范围无订单`
        : `列表页 ${page}/${parsed.pageCount} 已保存，共 ${parsed.orders.length} 条`, { orderType: type.code, pageNum: page });
      await updateStatus({ currentPage: page, pageCount: parsed.pageCount });
      listCount += parsed.orders.length;
      await updateStatus({ listCount });

      const filteredStatuses = new Map<string, number>();
      for (const row of parsed.orders) {
        typeOrderIds.add(row.orderId);
        if (!isPinganOrderStatusInScope(type.code, row.statusStr)) {
          const statusName = String(row.statusStr).trim();
          filteredStatuses.set(statusName, (filteredStatuses.get(statusName) ?? 0) + 1);
          continue;
        }
        const previous = await runtimeMessage<{ ok: true; order?: PinganOrder }>({
          type: 'PINGAN_GET_ORDER', pinganUserId: pinganIdentity!.pinganUserId, orderId: row.orderId,
        });
        const listFingerprint = await fingerprint(row);
        const changed = !previous.order || previous.order.listFingerprint !== listFingerprint;
        const hasStoredDetail = Boolean(previous.order?.detailJson);
        const detailAlreadyCaptured = previous.order?.captureState === 'complete' &&
          Boolean(previous.order.detailFingerprint) && hasStoredDetail;
        const now = new Date().toISOString();
        const { handlerUserId, handlerName } = parsePinganCurrentHandler(row, row.orderId);
        const order: PinganOrder = previous.order ?? {
          pinganUserId: pinganIdentity!.pinganUserId,
          orderId: row.orderId,
          orderType: type.code,
          orderTypeStr: String(row.orderTypeStr ?? type.name),
          status: String(row.status ?? ''),
          statusStr: String(row.statusStr ?? ''),
          handlerUserId,
          handlerName,
          listJson: row,
          decryptedFields: {},
          listFingerprint,
          attachmentKeys: [],
          captureState: 'list',
          attachmentState: 'not_captured',
          attachmentErrors: [],
          errors: [],
          firstSeenAt: now,
          lastSeenAt: now,
        };
        order.listJson = hasStoredDetail && previous.order
          ? {
            ...previous.order.listJson,
            status: row.status,
            statusStr: row.statusStr,
            handlerUserId,
            handlerName,
          }
          : row;
        order.listFingerprint = listFingerprint;
        order.orderTypeStr = String(row.orderTypeStr ?? type.name);
        order.status = String(row.status ?? '');
        order.statusStr = String(row.statusStr ?? '');
        order.handlerUserId = handlerUserId;
        order.handlerName = handlerName;
        order.attachmentErrors ??= [];
        order.attachmentState ??= order.captureState === 'complete' ? 'complete' : 'not_captured';
        order.lastSeenAt = now;
        const missingHandlerError = '当前处理人 ID 缺失';
        const missingHandlerAlreadyReported = order.captureState === 'partial_failure' && order.errors.includes(missingHandlerError);
        order.errors = [];
        if (!handlerUserId) {
          order.captureState = 'partial_failure';
          order.errors = [missingHandlerError];
          delete order.backendSyncedAt;
          await runtimeMessage({ type: 'PINGAN_SAVE_ORDER', order });
          errorCount++;
          if (!missingHandlerAlreadyReported) {
            await logEvent('error', 'handler_missing', `订单当前处理人 ID 为空（状态 ${order.status || '未知'} / ${order.statusStr || '未知'}），已保留本机待核实且未上传`, {
              orderId: order.orderId,
              orderType: type.code,
              pageNum: page,
            });
          }
          await updateStatus({ errorCount });
          continue;
        }
        if (isPinganOrderCompleted(order.statusStr)) {
          if (!hasStoredDetail) {
            order.captureState = 'list';
            order.attachmentState = 'not_captured';
            order.attachmentKeys = [];
            order.attachmentErrors = [];
            order.errors = [];
          } else {
            order.errors = previous.order?.errors ?? [];
          }
          if (changed) delete order.backendSyncedAt;
          await runtimeMessage({ type: 'PINGAN_SAVE_ORDER', order });
          if (!previous.order || previous.order.statusStr !== order.statusStr) {
            await logEvent('info', 'completed_order_status_only', hasStoredDetail
              ? '订单已完成，仅更新订单状态，保留此前采集的详情和附件'
              : '订单已完成，仅采集列表和状态；详情附件在当前状态下不可获取', {
              orderId: order.orderId,
              orderType: type.code,
              pageNum: page,
            });
          }
          if (pinganBackendReady && (!order.backendSyncedAt || order.backendCollectorEmployeeId !== collectorEmployeeId)) {
            try {
              await uploadPinganOrder(order);
            } catch (error) {
              errorCount++;
              await logEvent('error', 'backend_order_upload_failed', safeError(error), { orderId: order.orderId, orderType: type.code, pageNum: page });
              await updateStatus({ errorCount });
            }
          }
          continue;
        }
        if (!shouldCapturePinganOrderDetails(order.statusStr, detailAlreadyCaptured) && detailAlreadyCaptured) {
          let retryAttachments = false;
          if (order.attachmentState !== 'complete') {
            try {
              const savedKeysBeforeRetry = new Set(order.attachmentKeys);
              const storedDetail = order.detailJson as Record<string, unknown>;
              const storedOrderInfo = storedDetail.orderInfo;
              if (!storedOrderInfo || typeof storedOrderInfo !== 'object' || Array.isArray(storedOrderInfo)) {
                throw new Error('已采集详情缺少 orderInfo，不能重试附件');
              }
              await waitForOrderDetailSlot(order.orderId, type.code, page);
              order.attachmentErrors = [];
              await captureAttachments(order, storedOrderInfo as Record<string, unknown>);
              attachmentCount += order.attachmentKeys.filter((key) => !savedKeysBeforeRetry.has(key)).length;
              retryAttachments = true;
              if (order.attachmentErrors.length) {
                errorCount++;
                await logEvent('error', 'attachment_capture_partial', `${order.attachmentErrors.length} 个附件尚未成功下载`, { orderId: order.orderId, orderType: type.code, pageNum: page });
              }
            } catch (error) {
              order.attachmentErrors = [...(order.attachmentErrors ?? []), safeError(error)];
              order.attachmentState = 'partial_failure';
              errorCount++;
              await runtimeMessage({ type: 'PINGAN_SAVE_ORDER', order });
              await logEvent('error', 'attachment_retry_failed', safeError(error), { orderId: order.orderId, orderType: type.code, pageNum: page });
            }
          }
          if (changed || retryAttachments) delete order.backendSyncedAt;
          await runtimeMessage({ type: 'PINGAN_SAVE_ORDER', order });
          if (pinganBackendReady && (!order.backendSyncedAt || order.backendCollectorEmployeeId !== collectorEmployeeId)) {
            try {
              await uploadPinganOrder(order);
            } catch (error) {
              errorCount++;
              await logEvent('error', 'backend_order_upload_failed', safeError(error), { orderId: order.orderId, orderType: type.code, pageNum: page });
              await updateStatus({ errorCount });
            }
          }
          continue;
        }
        if (!changed && order.captureState === 'complete' && order.attachmentState === 'complete') {
          await runtimeMessage({ type: 'PINGAN_SAVE_ORDER', order });
          if (pinganBackendReady && (!order.backendSyncedAt || order.backendCollectorEmployeeId !== collectorEmployeeId)) {
            try {
              await uploadPinganOrder(order);
            } catch (error) {
              errorCount++;
              await logEvent('error', 'backend_order_upload_failed', safeError(error), { orderId: order.orderId, orderType: type.code, pageNum: page });
              await updateStatus({ errorCount });
            }
          }
          continue;
        }
        if (changed || order.captureState !== 'complete' || order.attachmentState !== 'complete') delete order.backendSyncedAt;
        await runtimeMessage({ type: 'PINGAN_SAVE_ORDER', order });
        try {
          await waitForOrderDetailSlot(order.orderId, type.code, page);
          await captureOrderDetails(order, page);
          detailCount++;
          decryptedFieldCount += Object.keys(order.decryptedFields).length;
          attachmentCount += order.attachmentKeys.length;
          if (order.attachmentErrors?.length) {
            errorCount++;
            await logEvent('error', 'attachment_capture_partial', `${order.attachmentErrors.length} 个附件尚未成功下载`, { orderId: order.orderId, orderType: type.code, pageNum: page });
          }
        } catch (error) {
          order.captureState = 'partial_failure';
          order.errors.push(safeError(error));
          errorCount++;
          await runtimeMessage({ type: 'PINGAN_SAVE_ORDER', order });
          await logEvent('error', 'order_capture_failed', safeError(error), { orderId: order.orderId, orderType: type.code, pageNum: page });
        }
        if (pinganBackendReady) {
          try {
            await uploadPinganOrder(order);
          } catch (error) {
            errorCount++;
            await logEvent('error', 'backend_order_upload_failed', safeError(error), { orderId: order.orderId, orderType: type.code, pageNum: page });
          }
        }
        await updateStatus({
          listCount, detailCount, decryptedFieldCount, attachmentCount, errorCount,
        });
      }
      if (filteredStatuses.size) {
        await logEvent('info', 'orders_filtered_by_status', `本页按采集范围排除 ${[...filteredStatuses.values()].reduce((sum, count) => sum + count, 0)} 条订单`, {
          orderType: type.code,
          pageNum: page,
          filteredStatuses: Object.fromEntries(filteredStatuses),
        });
      }
      const completedPage = {
        ...pageRecord,
        state: 'completed',
        completedAt: new Date().toISOString(),
      };
      await runtimeMessage({ type: 'PINGAN_SAVE_PAGE', page: completedPage });
      await uploadPinganPage(completedPage).catch((error) => {
        void logEvent('error', 'backend_page_upload_failed', safeError(error), { orderType: type.code, pageNum: page });
      });
      if (page >= expectedPageCount) break;
      listResponse = await queryList(type.code, page + 1, scanStartDate, scanEndDate, startedAt, merchantId);
      page++;
    }
    if (typeOrderIds.size !== typeTotal) throw new Error(`${type.name} 去重订单数 ${typeOrderIds.size} 与接口总量 ${typeTotal} 不一致`);
    uniqueOrderCount += typeOrderIds.size;
  }

  let finalState: PinganRunStatus['state'] = errorCount > 0 ? 'partial_failure' : 'completed';
  const completedRun = {
    id: runId, startedAt, completedAt: new Date().toISOString(), installDate,
    scanStartDate, scanEndDate, state: finalState, uniqueOrderCount, listRows: listCount,
    detailCount, decryptedFieldCount, attachmentCount, errorCount, error: null as string | null,
  };
  await runtimeMessage({ type: 'PINGAN_SAVE_RUN', run: completedRun });
  try {
    if (pinganBackendReady) await uploadPinganRun(completedRun);
  } catch (error) {
    errorCount++;
    finalState = 'partial_failure';
    completedRun.state = finalState;
    completedRun.errorCount = errorCount;
    completedRun.error = safeError(error);
    await runtimeMessage({ type: 'PINGAN_SAVE_RUN', run: completedRun });
    await logEvent('error', 'backend_run_upload_failed', safeError(error));
  }
  await updateStatus({
    state: finalState, updatedAt: new Date().toISOString(), listCount, detailCount,
    decryptedFieldCount, attachmentCount, errorCount,
  });
  await logEvent(finalState === 'completed' ? 'info' : 'error', 'run_finished', `本轮结束：订单行 ${listCount}，详情 ${detailCount}，附件 ${attachmentCount}，失败 ${errorCount}`);
}

async function waitForOrderDetailSlot(orderId: string, orderType: string, pageNum: number): Promise<void> {
  const stored = await chrome.storage.local.get(PINGAN_LAST_DETAIL_START_KEY);
  const waitMs = pinganOrderDetailWaitMs(stored[PINGAN_LAST_DETAIL_START_KEY]);
  if (waitMs > 0) {
    await logEvent('info', 'order_detail_rate_limited', `为控制访问节奏，等待 ${Math.ceil(waitMs / 1000)} 秒后采集该订单详情`, {
      orderId, orderType, pageNum,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }
  await chrome.storage.local.set({ [PINGAN_LAST_DETAIL_START_KEY]: Date.now() });
  await logEvent('info', 'order_detail_group_started', '开始串行采集该订单详情及附件', { orderId, orderType, pageNum });
}

async function queryList(orderType: string, pageNum: number, startDate: string, endDate: string, scanAt: string, merchantId: unknown): Promise<PinganApiResultMessage> {
  const param = {
    merchantId,
    pageNum,
    pageSize: 10,
    orderType,
    timeRange: [new Date(`${startDate}T00:00:00+08:00`).toISOString(), scanAt],
    createTimeStart: startDate,
    createTimeEnd: endDate,
  };
  const result = await requestPinganApi('roger.getOrderList', { param });
  const actual = result.requestParam;
  if (actual.orderType !== orderType || Number(actual.pageNum) !== pageNum) throw new Error('列表请求参数中的类型或页码不符');
  if (String(actual.merchantId ?? '') !== String(merchantId)) throw new Error('列表请求商户与当前商户不一致');
  if (actual.status != null && actual.status !== '') throw new Error('列表请求意外包含状态筛选');
  if (String(actual.createTimeStart ?? '') !== startDate || String(actual.createTimeEnd ?? '') !== endDate) {
    throw new Error(`列表时间范围不符：需要 ${startDate} 至 ${endDate}`);
  }
  return result;
}

async function captureOrderDetails(order: PinganOrder, listPage: number): Promise<void> {
  await logEvent('info', 'detail_request', '查询订单详情接口', { orderId: order.orderId, orderType: order.orderType, pageNum: listPage });
  const detailResponse = await requestPinganApi('roger.getOrderDetail', { orderId: order.orderId }, DETAIL_TIMEOUT_MS);
  const detail = parseOrderDetail(detailResponse.response, order.orderId) as Record<string, unknown>;
  const operationResponse = await requestPinganApi('roger.getOrderOperateRecordList', { orderId: order.orderId }, DETAIL_TIMEOUT_MS);
  detail.operationRecords = unwrapPinganResponse(operationResponse.response, 'roger.getOrderOperateRecordList');
  order.detailJson = sanitizeStoredDetail(detail);
  order.detailFingerprint = await fingerprint(detail);
  order.captureState = 'detail';
  order.errors = [];
  order.attachmentErrors = [];
  order.attachmentState = 'not_captured';
  order.decryptedFields = {};
  await runtimeMessage({ type: 'PINGAN_SAVE_ORDER', order });

  await decryptVisibleFields(order, detail.orderInfo as Record<string, unknown>);
  await captureAttachments(order, detail.orderInfo as Record<string, unknown>);
  await runtimeMessage({
    type: 'PINGAN_DELETE_STALE_ATTACHMENTS', pinganUserId: order.pinganUserId,
    orderId: order.orderId, keepIds: order.attachmentKeys,
  });
  order.captureState = 'complete';
  order.lastSeenAt = new Date().toISOString();
  await runtimeMessage({ type: 'PINGAN_SAVE_ORDER', order });
}

async function decryptVisibleFields(order: PinganOrder, detail: Record<string, unknown>): Promise<void> {
  const fields = collectEncryptedFields(detail);
  for (const field of fields) {
    if (!field.encryptValue) throw new Error(`订单 ${order.orderId} 字段 ${field.fieldName} 缺少 encryptValue`);
    await logEvent('info', 'field_decrypt_request', `请求解密字段 ${field.fieldName}`, { orderId: order.orderId });
    const result = await requestPinganApi('roger.decryptOrderField', {
      param: { orderId: order.orderId, encryptValue: field.encryptValue, fieldName: field.fieldName },
    }, DETAIL_TIMEOUT_MS);
    const code = getPinganApiBusinessCode(result.response);
    if ((result.httpStatus ?? 0) < 200 || (result.httpStatus ?? 0) >= 300 || code !== 0) {
      throw new Error(`订单 ${order.orderId} 字段 ${field.fieldName} 解密失败，业务码 ${String(code ?? '缺失')}`);
    }
    const model = unwrapPinganResponse(result.response, 'roger.decryptOrderField');
    if (typeof model !== 'string' || !model) throw new Error(`订单 ${order.orderId} 字段 ${field.fieldName} 解密响应无明文`);
    order.decryptedFields[field.fieldName] = model;
    await runtimeMessage({ type: 'PINGAN_SAVE_ORDER', order });
  }
}

async function captureAttachments(order: PinganOrder, detail: Record<string, unknown>): Promise<void> {
  const attachments = findAttachments(detail);
  const previousKeys = [...order.attachmentKeys];
  const keys: string[] = [];
  let hasUnidentifiedAttachment = false;
  for (let index = 0; index < attachments.length; index++) {
    const item = attachments[index];
    const fileName = typeof item.fileName === 'string' ? item.fileName.trim() : '';
    const fileKey = pinganAttachmentFileKey(item);
    const fileType = typeof item.fileType === 'string' && item.fileType.trim() ? item.fileType.trim() : null;
    let downloadUrl = normalizeAttachmentUrl(item.downloadUrl);
    const attachmentId = fileKey;
    if (!attachmentId) {
      hasUnidentifiedAttachment = true;
      const reason = isAttachmentUrl(downloadUrl)
        ? `附件“${fileName || `第 ${index + 1} 项`}”有下载链接但缺少稳定文件 ID`
        : `附件“${fileName || `第 ${index + 1} 项`}”缺少文件键和下载链接`;
      await recordAttachmentIssue(order, reason, index + 1);
      continue;
    }
    if (previousKeys.includes(attachmentId)) {
      keys.push(attachmentId);
      continue;
    }
    try {
      if (!isAttachmentUrl(downloadUrl)) {
        const tokenResult = await requestPinganApi(
          'filegw.requestFileToken', pinganFileTokenParams(fileKey), DETAIL_TIMEOUT_MS,
        );
        const token = getPinganContentItem(tokenResult.response, 'filegw.requestFileToken').value;
        if (typeof token !== 'string' || !token) throw new Error('未取得下载令牌');
        downloadUrl = `https://filegw.jk.cn/file?token=${encodeURIComponent(token)}`;
      }
      if (!isAttachmentUrl(downloadUrl)) throw new Error('下载地址格式无效');
      const saved = await runtimeMessage<{ ok: true; size: number; sha256: string }>({
        type: 'PINGAN_DOWNLOAD_ATTACHMENT',
        pinganUserId: order.pinganUserId,
        orderId: order.orderId,
        attachmentId,
        fileName,
        fileType,
        url: downloadUrl,
      });
      if (!saved.size || !saved.sha256) throw new Error('本机保存未确认');
      const expectedSize = Number(item.fileSize);
      if (Number.isFinite(expectedSize) && expectedSize > 0 && expectedSize !== saved.size) {
        throw new Error(`文件大小不符，页面 ${expectedSize} 字节，下载 ${saved.size} 字节`);
      }
      keys.push(attachmentId);
      order.attachmentKeys = [...keys];
      await runtimeMessage({ type: 'PINGAN_SAVE_ORDER', order });
      await logEvent('info', 'attachment_saved', `附件已保存，${saved.size} 字节`, { orderId: order.orderId });
    } catch (error) {
      if (previousKeys.includes(attachmentId)) keys.push(attachmentId);
      await recordAttachmentIssue(order, `附件“${fileName || attachmentId}”下载失败：${safeError(error)}`, index + 1);
    }
  }
  if (hasUnidentifiedAttachment) keys.push(...previousKeys);
  order.attachmentKeys = [...new Set(keys)];
  order.attachmentState = (order.attachmentErrors ?? []).length ? 'partial_failure' : 'complete';
  await runtimeMessage({ type: 'PINGAN_SAVE_ORDER', order });
}

async function recordAttachmentIssue(order: PinganOrder, message: string, index: number): Promise<void> {
  const issue = `${message}（附件 ${index}）`;
  order.attachmentErrors ??= [];
  order.attachmentErrors.push(issue);
  order.attachmentState = 'partial_failure';
  await runtimeMessage({ type: 'PINGAN_SAVE_ORDER', order });
  await logEvent('error', 'attachment_capture_failed', issue, { orderId: order.orderId });
}

function collectEncryptedFields(root: Record<string, unknown>): Array<{ fieldName: string; maskValue: string; encryptValue: string }> {
  const found: Array<{ fieldName: string; maskValue: string; encryptValue: string }> = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.encryptValue === 'string' && typeof record.key === 'string' && typeof record.maskValue === 'string') {
        found.push({ fieldName: record.key, maskValue: record.maskValue, encryptValue: record.encryptValue });
      }
      Object.values(record).forEach(visit);
    }
  };
  visit(root);
  return found;
}

function findAttachments(root: Record<string, unknown>): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.fileName === 'string' && ('iobsKey' in record || 'tfsKey' in record || 'downloadUrl' in record) && 'fileType' in record) found.push(record);
      else Object.values(record).forEach(visit);
    }
  };
  visit(root);
  return found;
}

function sanitizeStoredDetail(value: unknown): Record<string, unknown> {
  const clone = structuredClone(value) as Record<string, unknown>;
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      delete record.downloadUrl;
      delete record.token;
      delete record._sig;
      delete record._wtk;
      Object.values(record).forEach(visit);
    }
  };
  visit(clone);
  return clone;
}

function isAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value, location.href);
    return url.protocol === 'https:' && (
      (url.hostname === 'iobs.pingan.com.cn' && url.pathname.startsWith('/download/')) ||
      (url.hostname === 'filegw.jk.cn' && url.pathname === '/file')
    );
  } catch {
    return false;
  }
}

function normalizeAttachmentUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && url.hostname === 'iobs.pingan.com.cn' && url.pathname.startsWith('/download/')) {
      url.protocol = 'https:';
    }
    return isAttachmentUrl(url.href) ? url.href : '';
  } catch {
    return '';
  }
}

function isOrderListPage(): boolean {
  return location.hash.includes('/goodsOrderList');
}

async function getInstallDate(): Promise<string> {
  const stored = await runtimeMessage<{ ok: true; installDate: string }>({ type: 'PINGAN_GET_INSTALL_DATE' });
  const value = stored.installDate;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('平安采集安装日期缺失或格式错误');
  return value;
}

async function updateStatus(patch: Partial<PinganRunStatus>): Promise<void> {
  const installDate = patch.installDate ?? lastStatus?.installDate ?? await getInstallDate();
  lastStatus = {
    state: patch.state ?? lastStatus?.state ?? (loggedIn ? 'running' : 'waiting_login'),
    listCount: patch.listCount ?? lastStatus?.listCount ?? 0,
    detailCount: patch.detailCount ?? lastStatus?.detailCount ?? 0,
    decryptedFieldCount: patch.decryptedFieldCount ?? lastStatus?.decryptedFieldCount ?? 0,
    attachmentCount: patch.attachmentCount ?? lastStatus?.attachmentCount ?? 0,
    errorCount: patch.errorCount ?? lastStatus?.errorCount ?? 0,
    ...lastStatus,
    ...patch,
    installDate,
    updatedAt: new Date().toISOString(),
  };
  await runtimeMessage({ type: 'PINGAN_SET_STATUS', status: lastStatus });
}

async function logEvent(level: PinganEvent['level'], kind: string, message: string, context: Partial<PinganEvent> = {}): Promise<void> {
  const event: PinganEvent = {
    id: crypto.randomUUID(), runId: lastStatus?.runId ?? 'page-session', at: new Date().toISOString(), level, kind,
    message, ...context,
  };
  await runtimeMessage({ type: 'PINGAN_SAVE_EVENT', event });
}

async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function beijingDateString(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s]+/g, '[地址已省略]').slice(0, 300);
}

function initialize(): void {
  const syncRoute = (): void => {
    const onListPage = isOrderListPage();
    if (onListPage === observedListPage) return;
    observedListPage = onListPage;
    if (loginTimer) {
      clearTimeout(loginTimer);
      loginTimer = null;
    }
    if (!onListPage) {
      void updateStatus({ state: 'waiting_page', lastError: '请打开平安好医生订单列表页' });
      void logEvent('info', 'waiting_order_list_page', '当前页面不是订单列表页');
      return;
    }
    void logEvent('info', 'order_list_page_detected', '已进入平安订单列表页，检测到登录后自动采集');
    loginTimer = setTimeout(() => {
      if (!loggedIn) void updateStatus({ state: 'waiting_login', lastError: undefined });
    }, 5_000);
    if (loggedIn) void runIfReady();
  };

  window.addEventListener('hashchange', syncRoute);
  setInterval(() => {
    if (loggedIn && isOrderListPage()) void runIfReady();
  }, PINGAN_POLL_INTERVAL_MS);
  setInterval(() => void keepPinganSessionAlive(), SESSION_KEEPALIVE_INTERVAL_MS);
  syncRoute();
  if (!isOrderListPage()) {
    void updateStatus({ state: 'waiting_page', lastError: '请打开平安好医生订单列表页' });
  }
}

initialize();
