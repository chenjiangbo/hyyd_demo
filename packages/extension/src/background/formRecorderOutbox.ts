export type QueuedFormEvent = {
  eventId: string;
  queuedAt: number;
  account: string;
  userId: number;
  session: Record<string, unknown>;
  event: Record<string, unknown>;
  imageDataUrl?: string;
};

const DATABASE = 'hyyd-taikang-form-recorder';
const STORE = 'events';
let opening: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      const store = request.transaction!.objectStoreNames.contains(STORE)
        ? request.transaction!.objectStore(STORE)
        : request.result.createObjectStore(STORE, { keyPath: 'eventId' });
      if (!store.indexNames.contains('accountSequence')) {
        store.createIndex('accountSequence', ['account', 'session.startedAt', 'event.sequence']);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opening = null;
      reject(request.error ?? new Error('无法打开填报记录缓存'));
    };
  });
  return opening;
}

export async function queueFormEvent(item: QueuedFormEvent): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const existing = store.get(item.eventId);
    existing.onsuccess = () => {
      if (existing.result) {
        if (JSON.stringify(existing.result.event) !== JSON.stringify(item.event) ||
            JSON.stringify(existing.result.session) !== JSON.stringify(item.session) ||
            existing.result.account !== item.account || existing.result.userId !== item.userId ||
            existing.result.imageDataUrl !== item.imageDataUrl) {
          tx.abort();
          return;
        }
        return;
      }
      store.add(item);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('填报记录缓存写入失败'));
    tx.onabort = () => reject(new Error('重复录制事件的内容不一致'));
  });
}

export async function nextFormEvent(account: string): Promise<QueuedFormEvent | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const cursor = tx.objectStore(STORE).index('accountSequence').openCursor(IDBKeyRange.lowerBound([account, '', 0]));
    cursor.onsuccess = () => {
      const value = cursor.result?.value as QueuedFormEvent | undefined;
      resolve(value?.account === account ? value : null);
    };
    cursor.onerror = () => reject(cursor.error ?? new Error('填报记录缓存读取失败'));
  });
}

export async function deleteFormEvent(eventId: string): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(eventId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('填报记录缓存删除失败'));
  });
}

export async function countFormEvents(): Promise<number> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('填报记录缓存统计失败'));
  });
}
