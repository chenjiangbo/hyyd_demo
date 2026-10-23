export const DEFAULT_BACKEND_WS_URL = 'ws://47.93.40.50:9093/ws';

const LEGACY_BACKEND_WS_URL = 'ws://47.95.14.233:9093/ws';

export function configuredBackendWsUrl(value: unknown): string {
  if (value == null || value === '' || value === LEGACY_BACKEND_WS_URL) return DEFAULT_BACKEND_WS_URL;
  if (typeof value !== 'string') throw new Error('后台连接地址配置无效');
  const address = value.trim();
  let parsed: URL;
  try { parsed = new URL(address); }
  catch { throw new Error('后台连接地址不是有效的 WebSocket URL'); }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error('后台连接地址必须以 ws:// 或 wss:// 开头');
  if (parsed.username || parsed.password) throw new Error('后台连接地址不能包含账号或密码');
  return address;
}
