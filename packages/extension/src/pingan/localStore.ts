import type { PinganAttachment, PinganEvent, PinganOrder, PinganRunStatus } from './types';

const DB_NAME = 'hyyd-pingan-orders';
const DB_VERSION = 2;
const STORE_LEGACY_ORDERS = 'orders';
const STORE_LEGACY_ATTACHMENTS = 'attachments';
const STORE_ORDERS = 'ordersByAccount';
const STORE_ATTACHMENTS = 'attachmentsByAccount';
const STORE_EVENTS = 'events';
const STORE_PAGES = 'pages';
const STORE_RUNS = 'runs';

let openPromise: Promise<IDBDatabase> | null = null;

export function openPinganDb(): Promise<IDBDatabase> {
  if (openPromise) return openPromise;
  openPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_LEGACY_ORDERS)) db.createObjectStore(STORE_LEGACY_ORDERS, { keyPath: 'orderId' });
      if (!db.objectStoreNames.contains(STORE_LEGACY_ATTACHMENTS)) db.createObjectStore(STORE_LEGACY_ATTACHMENTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_ORDERS)) db.createObjectStore(STORE_ORDERS, { keyPath: ['pinganUserId', 'orderId'] });
      if (!db.objectStoreNames.contains(STORE_ATTACHMENTS)) db.createObjectStore(STORE_ATTACHMENTS, { keyPath: ['pinganUserId', 'id'] });
      if (!db.objectStoreNames.contains(STORE_EVENTS)) db.createObjectStore(STORE_EVENTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_PAGES)) db.createObjectStore(STORE_PAGES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_RUNS)) db.createObjectStore(STORE_RUNS, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('打开平安本机数据库失败'));
    request.onblocked = () => reject(new Error('平安本机数据库升级被其他扩展页面阻塞'));
  }).catch((error) => {
    openPromise = null;
    throw error;
  });
  return openPromise;
}

export async function savePinganOrder(order: PinganOrder): Promise<void> {
  const db = await openPinganDb();
  await transaction(db, [STORE_ORDERS], 'readwrite', (tx) => tx.objectStore(STORE_ORDERS).put(order));
}

export async function getPinganOrder(pinganUserId: string, orderId: string): Promise<PinganOrder | undefined> {
  const db = await openPinganDb();
  return transaction<PinganOrder | undefined>(db, [STORE_ORDERS], 'readonly', (tx) => tx.objectStore(STORE_ORDERS).get([pinganUserId, orderId]));
}

export async function savePinganPage(page: Record<string, unknown>): Promise<void> {
  const db = await openPinganDb();
  await transaction(db, [STORE_PAGES], 'readwrite', (tx) => tx.objectStore(STORE_PAGES).put(page));
}

export async function savePinganRun(run: Record<string, unknown>): Promise<void> {
  const db = await openPinganDb();
  await transaction(db, [STORE_RUNS], 'readwrite', (tx) => tx.objectStore(STORE_RUNS).put(run));
}

export async function savePinganEvent(event: PinganEvent): Promise<void> {
  const db = await openPinganDb();
  await transaction(db, [STORE_EVENTS], 'readwrite', (tx) => tx.objectStore(STORE_EVENTS).put(event));
}

export async function savePinganAttachment(attachment: PinganAttachment): Promise<void> {
  const db = await openPinganDb();
  await transaction(db, [STORE_ATTACHMENTS], 'readwrite', (tx) => tx.objectStore(STORE_ATTACHMENTS).put(attachment));
}

export async function getPinganAttachment(pinganUserId: string, id: string): Promise<PinganAttachment | undefined> {
  const db = await openPinganDb();
  return transaction<PinganAttachment | undefined>(db, [STORE_ATTACHMENTS], 'readonly', (tx) => tx.objectStore(STORE_ATTACHMENTS).get([pinganUserId, id]));
}

export async function deleteStalePinganAttachments(pinganUserId: string, orderId: string, keepIds: string[]): Promise<void> {
  const db = await openPinganDb();
  const tx = db.transaction([STORE_ATTACHMENTS], 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_ATTACHMENTS);
  const rows = await requestResult<PinganAttachment[]>(store.getAll());
  const keep = new Set(keepIds.map((id) => `${orderId}:${id}`));
  for (const row of rows) {
    if (row.pinganUserId === pinganUserId && row.orderId === orderId && !keep.has(row.id)) {
      store.delete([pinganUserId, row.id]);
    }
  }
  await done;
}

export async function exportPinganData(): Promise<Record<string, unknown>> {
  const db = await openPinganDb();
  const tx = db.transaction([STORE_ORDERS, STORE_ATTACHMENTS, STORE_LEGACY_ORDERS, STORE_LEGACY_ATTACHMENTS, STORE_RUNS], 'readonly');
  const done = transactionDone(tx);
  const [orders, attachments, legacyOrders, legacyAttachments, runs] = await Promise.all([
    requestResult<PinganOrder[]>(tx.objectStore(STORE_ORDERS).getAll()),
    requestResult<PinganAttachment[]>(tx.objectStore(STORE_ATTACHMENTS).getAll()),
    requestResult<Array<Record<string, unknown>>>(tx.objectStore(STORE_LEGACY_ORDERS).getAll()),
    requestResult<PinganAttachment[]>(tx.objectStore(STORE_LEGACY_ATTACHMENTS).getAll()),
    requestResult<Record<string, unknown>[]>(tx.objectStore(STORE_RUNS).getAll()),
  ]);
  await done;
  const serializeAttachment = async (attachment: PinganAttachment) => ({
    id: attachment.id,
    pinganUserId: attachment.pinganUserId,
    orderId: attachment.orderId,
    fileName: attachment.fileName,
    fileType: attachment.fileType,
    mimeType: attachment.mimeType,
    size: attachment.size,
    sha256: attachment.sha256,
    capturedAt: attachment.capturedAt,
    dataBase64: await blobToBase64(attachment.blob),
  });
  const resultAttachments = await Promise.all(attachments.map(serializeAttachment));
  const legacyResultAttachments = await Promise.all(legacyAttachments.map(serializeAttachment));
  return {
    exportedAt: new Date().toISOString(),
    orders,
    attachments: resultAttachments,
    legacyOrders,
    legacyAttachments: legacyResultAttachments,
    runs,
  };
}

export async function exportPinganLogs(): Promise<Record<string, unknown>> {
  const db = await openPinganDb();
  const tx = db.transaction([STORE_EVENTS, STORE_PAGES, STORE_RUNS], 'readonly');
  const done = transactionDone(tx);
  const [events, pages, runs] = await Promise.all([
    requestResult<PinganEvent[]>(tx.objectStore(STORE_EVENTS).getAll()),
    requestResult<Record<string, unknown>[]>(tx.objectStore(STORE_PAGES).getAll()),
    requestResult<Record<string, unknown>[]>(tx.objectStore(STORE_RUNS).getAll()),
  ]);
  await done;
  return { exportedAt: new Date().toISOString(), events, pages, runs };
}

export async function setPinganStatus(status: PinganRunStatus): Promise<void> {
  await chrome.storage.local.set({ pinganCollectionStatus: status });
}

export async function persistPinganAttachment(
  pinganUserId: string,
  orderId: string,
  attachmentId: string,
  fileName: string,
  fileType: string | null,
  url: string
): Promise<{ size: number; mimeType: string; sha256: string }> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '未知';
    const requestId = response.headers.get('x-request-id') || response.headers.get('trace-id') || '无';
    let responseMessage = '';
    const body = await response.text().catch(() => '');
    if (body) {
      try {
        const payload = JSON.parse(body) as Record<string, unknown>;
        const candidate = payload.message ?? payload.msg ?? payload.error ?? payload.code;
        if (typeof candidate === 'string' || typeof candidate === 'number') responseMessage = String(candidate);
      } catch {
        if (/^(text\/plain|application\/xml|text\/xml)/i.test(contentType)) responseMessage = body.slice(0, 240);
      }
    }
    responseMessage = responseMessage
      .replace(/https?:\/\/\S+/gi, '[地址已省略]')
      .replace(/((?:token|sig|sign|_wtk)["'=:\s]+)[^&\s,"']+/gi, '$1[已省略]')
      .replace(/[A-Za-z0-9+/_=-]{48,}/g, '[长值已省略]')
      .slice(0, 240);
    const requestUrl = new URL(response.url || url);
    throw new Error(`附件下载 HTTP ${response.status}；地址 ${requestUrl.origin}${requestUrl.pathname}；类型 ${contentType}；请求标识 ${requestId}${responseMessage ? `；响应 ${responseMessage}` : ''}`);
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error('附件下载内容为空');
  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || blob.type;
  if (!mimeType) throw new Error('附件响应缺少 MIME 类型');
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const attachment: PinganAttachment = {
    pinganUserId,
    id: `${orderId}:${attachmentId}`,
    orderId,
    fileName,
    fileType,
    mimeType,
    size: blob.size,
    sha256,
    blob,
    capturedAt: new Date().toISOString(),
  };
  await savePinganAttachment(attachment);
  return { size: blob.size, mimeType, sha256 };
}

function transaction<T = void>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, issue: (tx: IDBTransaction) => IDBRequest | void): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let value: unknown;
    try {
      const request = issue(tx);
      if (request) {
        request.onsuccess = () => { value = request.result; };
      }
    } catch (error) {
      tx.abort();
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(value as T);
    tx.onerror = () => reject(tx.error ?? new Error('平安本机数据库事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('平安本机数据库事务已取消'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('平安本机数据库读取失败'));
    tx.onabort = () => reject(tx.error ?? new Error('平安本机数据库读取已取消'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('平安本机数据库请求失败'));
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  return btoa(binary);
}
