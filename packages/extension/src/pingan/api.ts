import { PINGAN_ORDER_TYPES, type PinganOrderType } from './types';

export class PinganApiError extends Error {
  constructor(message: string, readonly method: string, readonly code?: string | number) {
    super(message);
    this.name = 'PinganApiError';
  }
}

const PINGAN_ORDER_STATUS_SCOPE: Record<PinganOrderType, ReadonlySet<string>> = {
  ORDINARY_REGISTER: new Set(['待预约', '预约成功', '完成', '退号中', '退号成功', '退号失败', '预约失败']),
  HOSPITALIZE_DOMESTIC: new Set(['待预约', '预约成功', '完成', '预约失败']),
};
const PINGAN_FILE_TOKEN_TTL_MS = 5_000_000_000;
export const PINGAN_ORDER_DETAIL_INTERVAL_MS = 15_000;

export function isPinganOrderStatusInScope(orderType: PinganOrderType, statusName: unknown): boolean {
  if (typeof statusName !== 'string' || !statusName.trim()) {
    throw new Error(`订单 ${orderType} 缺少状态名称`);
  }
  return PINGAN_ORDER_STATUS_SCOPE[orderType].has(statusName.trim());
}

export function isPinganOrderCompleted(statusName: unknown): boolean {
  return typeof statusName === 'string' && statusName.trim() === '完成';
}

export function shouldCapturePinganOrderDetails(statusName: unknown, detailAlreadyCaptured: boolean): boolean {
  if (isPinganOrderCompleted(statusName)) return false;
  return !detailAlreadyCaptured;
}

export function oneMonthBefore(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('平安查询日期无效');
  const [year, month, day] = value.split('-').map(Number);
  const current = new Date(Date.UTC(year, month - 1, day));
  if (current.getUTCFullYear() !== year || current.getUTCMonth() !== month - 1 || current.getUTCDate() !== day) {
    throw new Error('平安查询日期无效');
  }
  const targetMonth = new Date(Date.UTC(year, month - 2, 1));
  const lastDay = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return `${targetMonth.getUTCFullYear()}-${String(targetMonth.getUTCMonth() + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}

export function pinganFileTokenParams(fileKey: string, now = Date.now()) {
  if (!fileKey.trim()) throw new Error('平安附件 fileKey 为空');
  return {
    tfsGroup: '1',
    expireAt: now + PINGAN_FILE_TOKEN_TTL_MS,
    fileKey,
    domainId: 9222000,
  };
}

export function pinganOrderDetailWaitMs(lastStartedAt: unknown, now = Date.now()): number {
  if (lastStartedAt == null) return 0;
  if (typeof lastStartedAt !== 'number' || !Number.isFinite(lastStartedAt) || lastStartedAt < 0) {
    throw new Error('平安订单详情限速时间无效');
  }
  return Math.max(0, lastStartedAt + PINGAN_ORDER_DETAIL_INTERVAL_MS - now);
}

export function unwrapPinganResponse(response: unknown, method: string): unknown {
  const root = asRecord(response, `${method}: 响应不是对象`);
  const statRecord = asRecord(root.stat, `${method}: 缺少平台状态`);
  if (Number(statRecord.code) !== 0) throw new PinganApiError(`${method}: 平台状态码失败`, method, statRecord.code as string | number);
  if (!Array.isArray(statRecord.stateList) || statRecord.stateList.length === 0 || statRecord.stateList.some((item) => Number((item as Record<string, unknown>)?.code) !== 0)) {
    throw new PinganApiError(`${method}: 平台状态列表失败`, method);
  }
  if (!Array.isArray(root.content) || root.content.length === 0) {
    throw new PinganApiError(`${method}: 缺少业务响应`, method);
  }
  const content = asRecord(root.content[0], `${method}: 业务响应格式错误`);
  if (content.success !== true || Number(content.code) !== 0) {
    throw new PinganApiError(`${method}: 业务请求失败`, method, content.code as string | number);
  }
  if (!('model' in content)) throw new PinganApiError(`${method}: 缺少 model`, method);
  return content.model;
}

export function getPinganContentItem(response: unknown, method: string): Record<string, unknown> {
  const root = asRecord(response, `${method}: 响应不是对象`);
  const stat = asRecord(root.stat, `${method}: 缺少平台状态`);
  if (Number(stat.code) !== 0) throw new PinganApiError(`${method}: 平台状态码失败`, method, stat.code as string | number);
  if (!Array.isArray(stat.stateList) || stat.stateList.length === 0 || stat.stateList.some((item) => Number((item as Record<string, unknown>)?.code) !== 0)) {
    throw new PinganApiError(`${method}: 平台状态列表失败`, method);
  }
  if (!Array.isArray(root.content) || root.content.length === 0) throw new PinganApiError(`${method}: 缺少业务响应`, method);
  const content = asRecord(root.content[0], `${method}: 业务响应格式错误`);
  if (content.success === false || (content.code !== undefined && Number(content.code) !== 0)) {
    throw new PinganApiError(`${method}: 业务请求失败`, method, content.code as string | number);
  }
  return content;
}

export function parseOrderListPage(response: unknown, expectedPage: number) {
  const model = asRecord(unwrapPinganResponse(response, 'roger.getOrderList'), '订单列表 model 格式错误');
  const currentValue = Number(model.current);
  const pageCount = nonNegativeInteger(model.pageCount, '列表 pageCount');
  const pageSize = positiveInteger(model.pageSize, '列表 pageSize');
  const total = nonNegativeInteger(model.total, '列表 total');
  if (!Array.isArray(model.data)) throw new Error('订单列表 data 不是数组');
  const isEmptyResult = currentValue === 0 && pageCount === 0 && total === 0 && model.data.length === 0;
  if (isEmptyResult) return { current: 0, pageCount, pageSize, total, orders: [] };
  if (!Number.isInteger(currentValue) || currentValue < 1) {
    throw new Error(`订单列表分页元数据异常：${paginationSummary(model)}`);
  }
  const current = currentValue;
  if (current !== expectedPage) throw new Error(`列表页码不匹配：请求 ${expectedPage}，返回 ${current}`);
  if (pageCount === 0 && total !== 0) throw new Error('列表 total 非零但 pageCount 为零');
  if (total === 0 || pageCount === 0) throw new Error(`空列表分页元数据不一致：${paginationSummary(model)}`);
  if (model.data.length > pageSize || (total > 0 && model.data.length === 0)) {
    throw new Error(`列表行数与分页元数据不一致：${model.data.length}/${pageSize}`);
  }
  const orders = model.data.map((value, index) => {
    const row = asRecord(value, `第 ${index + 1} 条订单不是对象`);
    if (typeof row.orderId !== 'string' || !row.orderId) throw new Error(`第 ${index + 1} 条订单缺少 orderId`);
    if (!PINGAN_ORDER_TYPES.some((item) => item.code === row.orderType)) {
      throw new Error(`订单 ${row.orderId} 类型不在已确认采集范围内`);
    }
    return row as Record<string, unknown> & { orderId: string; orderType: PinganOrderType };
  });
  return { current, pageCount, pageSize, total, orders };
}

function paginationSummary(model: Record<string, any>): string {
  const scalar = (value: unknown) => {
    if (value === undefined) return '缺失';
    if (value === null) return 'null';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    return `<${Array.isArray(value) ? 'array' : typeof value}>`;
  };
  const rowCount = Array.isArray(model.data) ? model.data.length : '非数组/缺失';
  return `current=${scalar(model.current)}, pageCount=${scalar(model.pageCount)}, pageSize=${scalar(model.pageSize)}, total=${scalar(model.total)}, data行数=${rowCount}, model字段=${Object.keys(model).join(',') || '无'}`;
}

export function parseOrderDetail(response: unknown, expectedOrderId: string) {
  const model = asRecord(unwrapPinganResponse(response, 'roger.getOrderDetail'), '订单详情 model 格式错误');
  if (typeof model.orderInfo !== 'string') throw new Error(`订单 ${expectedOrderId} 缺少 orderInfo`);
  let orderInfo: unknown;
  try {
    orderInfo = JSON.parse(model.orderInfo);
  } catch {
    throw new Error(`订单 ${expectedOrderId} 的 orderInfo JSON 解析失败`);
  }
  const info = asRecord(orderInfo, `订单 ${expectedOrderId} 的 orderInfo 不是对象`);
  if (String(info.orderId ?? '') !== expectedOrderId) {
    throw new Error(`详情订单号不匹配：预期 ${expectedOrderId}，实际 ${String(info.orderId ?? '') || '缺失'}`);
  }
  return { ...model, orderInfo: info };
}

export function getPinganApiBusinessCode(response: unknown): string | number | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const content = (response as Record<string, unknown>).content;
  if (!Array.isArray(content) || !content[0] || typeof content[0] !== 'object') return undefined;
  const code = (content[0] as Record<string, unknown>).code;
  return typeof code === 'string' || typeof code === 'number' ? code : undefined;
}

export function parsePinganIdentity(response: unknown): { pinganUserId: string; displayName: string } {
  const root = asRecord(response, '平安登录身份响应不是对象');
  const stat = asRecord(root.stat, '平安登录身份响应缺少平台状态');
  if (Number(stat.code) !== 0 || !Array.isArray(stat.stateList) || stat.stateList.length === 0 ||
      stat.stateList.some((item) => Number((item as Record<string, unknown>)?.code) !== 0)) {
    throw new Error('平安登录身份接口返回失败');
  }
  if (!Array.isArray(root.content) || root.content.length !== 1) throw new Error('平安登录身份响应格式无效');
  const profile = asRecord(root.content[0], '平安登录身份内容不是对象');
  const rawId = profile.id;
  const id = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : rawId;
  if (typeof id !== 'string' || !/^\d{1,40}$/.test(id)) throw new Error('平安登录用户 ID 缺失或无效');
  if (typeof profile.name !== 'string' || !profile.name.trim()) throw new Error('平安登录用户姓名缺失');
  return { pinganUserId: id, displayName: profile.name.trim() };
}

export function parsePinganCurrentHandler(value: unknown, orderId: string): { handlerUserId: string | null; handlerName: string | null } {
  const row = asRecord(value, `订单 ${orderId} 当前处理人数据不是对象`);
  const rawId = row.handlerUserId;
  const id = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : rawId;
  if (id != null && id !== '' && (typeof id !== 'string' || !/^\d{1,40}$/.test(id))) {
    throw new Error(`订单 ${orderId} 当前处理人 ID 无效`);
  }
  if (row.handlerName != null && typeof row.handlerName !== 'string') {
    throw new Error(`订单 ${orderId} 当前处理人姓名格式无效`);
  }
  return {
    handlerUserId: typeof id === 'string' && id ? id : null,
    handlerName: typeof row.handlerName === 'string' && row.handlerName.trim() ? row.handlerName.trim() : null,
  };
}

export function pinganAttachmentFileKey(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  for (const field of ['tfsKey', 'iobsKey']) {
    const key = item[field];
    if (typeof key === 'string' && key.trim()) return key.trim();
  }
  if (typeof item.downloadUrl === 'string') {
    try {
      const url = new URL(item.downloadUrl);
      if ((url.protocol === 'http:' || url.protocol === 'https:') &&
          url.hostname === 'iobs.pingan.com.cn' && url.pathname.startsWith('/download/')) {
        return `iobs:${url.pathname}`;
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function parseJsonRecord(value: unknown): Record<string, unknown> {
  return asRecord(value, 'JSON 对象格式错误');
}

function asRecord(value: unknown, message: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, any>;
}

function positiveInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw new Error(`${label} 无效`);
  return result;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0) throw new Error(`${label} 无效`);
  return result;
}
