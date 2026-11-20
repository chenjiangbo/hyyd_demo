import { md5 } from './md5';

(() => {
  const flag = '__HYYD_PINGAN_PROBE__';
  if ((window as any)[flag]) return;
  (window as any)[flag] = true;

  const allowed = new Set([
    'roger.getMyMerchantList',
    'user.getUserInfo',
    'roger.getOrderTypeList',
    'roger.getOrderStatusList',
    'roger.getOrderList',
    'roger.getOrderDetail',
    'roger.getOrderOperateRecordList',
    'roger.decryptOrderField',
    'roger.getDropdownEnumsVal',
    'filegw.requestFileToken',
  ]);

  function requestInfo(input: unknown, body: unknown) {
    const rawUrl = input instanceof Request ? input.url : String(input ?? '');
    let url: URL;
    try {
      url = new URL(rawUrl, location.href);
    } catch {
      return null;
    }
    if (url.hostname !== 'api.jk.cn' && url.hostname !== 'filegw.jk.cn') return null;
    const form = new URLSearchParams(typeof body === 'string' ? body : '');
    const method = url.searchParams.get('_mt') || form.get('_mt') || '';
    if (!allowed.has(method)) return null;
    const paramValue = form.get('param');
    let requestParam: Record<string, unknown> = {};
    if (paramValue) {
      try {
        const parsed = JSON.parse(paramValue);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) requestParam = parsed;
      } catch {
        requestParam = {};
      }
    }
    return { method, requestParam };
  }

  function send(method: string, requestParam: Record<string, unknown>, response: unknown, httpStatus: number, durationMs: number) {
    window.postMessage({
      source: 'HYYD_PINGAN_PROBE',
      payload: { kind: 'api-response', at: new Date().toISOString(), href: location.href, method, requestParam, response, httpStatus, durationMs },
    }, '*');
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestBody = init?.body ?? (input instanceof Request ? input.clone().text() : Promise.resolve(null));
    const startedAt = performance.now();
    const response = await originalFetch(input, init);
    const info = requestInfo(input, await requestBody);
    if (info) {
      response.clone().text().then((text) => {
        let payload: unknown;
        try { payload = JSON.parse(text); } catch { return; }
        send(info.method, info.requestParam, payload, response.status, performance.now() - startedAt);
      }).catch(() => {});
    }
    return response;
  };

  function getCookie(name: string): string | null {
    for (const entry of document.cookie.split(';')) {
      const [key, ...value] = entry.split('=');
      if (key.trim() === name) return decodeURIComponent(value.join('='));
    }
    return null;
  }

  function sign(params: Record<string, unknown>, token: string): string {
    const values: Record<string, unknown> = { _wtk: token, _sm: 'md5', ...params };
    const signatureBase = Object.keys(values).sort().map((key) => {
      const value = values[key];
      const encodedValue = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `${key}=${encodedValue}`;
    }).join('') + token;
    const form = Object.keys(values).sort().map((key) => {
      const value = values[key];
      const encodedValue = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `${encodeURIComponent(key)}=${encodeURIComponent(encodedValue)}`;
    });
    form.push(`_sig=${md5(signatureBase)}`);
    return form.join('&');
  }

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window || event.data?.source !== 'HYYD_PINGAN_API_REQUEST') return;
    const request = event.data as { requestId?: unknown; method?: unknown; params?: unknown };
    const requestId = typeof request.requestId === 'string' ? request.requestId : '';
    const method = typeof request.method === 'string' ? request.method : '';
    const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params as Record<string, unknown>
      : {};
    if (!requestId || !allowed.has(method)) return;
    void (async () => {
      const startedAt = performance.now();
      try {
        const token = getCookie('_wtk');
        if (!token) throw new Error('平安会话 cookie _wtk 不存在');
        const signedParams = { _mt: method, ...params, _aid: '9221471' };
        const response = await originalFetch(`https://api.jk.cn/m.api?_mt=${encodeURIComponent(method)}`, {
          method: 'POST',
          mode: 'cors',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: sign(signedParams, token),
        });
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new Error(`平安接口响应不是 JSON，HTTP ${response.status}`);
        }
        window.postMessage({
          source: 'HYYD_PINGAN_PROBE',
          payload: {
            kind: 'api-result', requestId, at: new Date().toISOString(), method,
            requestParam: params.param && typeof params.param === 'object' ? params.param : params,
            response: payload, httpStatus: response.status, durationMs: performance.now() - startedAt,
          },
        }, '*');
      } catch (error) {
        window.postMessage({
          source: 'HYYD_PINGAN_PROBE',
          payload: {
            kind: 'api-result', requestId, at: new Date().toISOString(), method,
            requestParam: params.param && typeof params.param === 'object' ? params.param : params,
            durationMs: performance.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          },
        }, '*');
      }
    })();
  });

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    (this as any).__hyydPinganMethod = method;
    (this as any).__hyydPinganUrl = url;
    return Reflect.apply(originalOpen, this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const info = requestInfo((this as any).__hyydPinganUrl, body);
    if (info) {
      const startedAt = performance.now();
      this.addEventListener('loadend', () => {
        let payload: unknown;
        try { payload = JSON.parse(this.responseText); } catch { return; }
        send(info.method, info.requestParam, payload, this.status, performance.now() - startedAt);
      }, { once: true });
    }
    return originalSend.call(this, body);
  };

})();
