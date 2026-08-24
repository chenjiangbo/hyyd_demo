(() => {
  const FLAG = '__HYYD_EDIT_PAGE_PROBE_INSTALLED__';
  if ((window as any)[FLAG]) return;
  (window as any)[FLAG] = true;

  function kind(v: unknown): string {
    if (v == null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }

  function fields(value: unknown, prefix = '', out = new Set<string>()): string[] {
    const k = kind(value);
    if (Array.isArray(value)) {
      out.add(`${prefix || '$'}[]`);
      const first = value.find((item) => item != null);
      if (first != null) fields(first, `${prefix || '$'}[]`, out);
      return [...out].sort();
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${key}` : key;
        const childKind = kind(child);
        if (childKind === 'object') {
          out.add(`${path}{}`);
          fields(child, path, out);
        } else if (childKind === 'array') {
          out.add(`${path}[]`);
          const first = (child as unknown[]).find((item) => item != null);
          if (first != null) fields(first, `${path}[]`, out);
        } else {
          out.add(path);
        }
      }
    }
    return [...out].sort();
  }

  function parseMaybeJson(input: unknown): unknown {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (!trimmed || !'{['.includes(trimmed[0])) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  function post(payload: Record<string, unknown>) {
    window.postMessage(
      {
        source: 'HYYD_EDIT_PAGE_PROBE',
        payload: {
          at: new Date().toISOString(),
          href: location.href,
          ...payload,
        },
      },
      '*'
    );
  }

  function urlInfo(input: unknown): { url: string; path: string } {
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : String(input ?? '');
    try {
      const u = new URL(raw, location.href);
      return { url: u.href, path: u.pathname };
    } catch {
      return { url: raw, path: raw };
    }
  }

  const unsafeWritePattern = /save|submit|commit|confirm|approve|audit|finish|cancel|update|insert|delete|upload|refund|pay/i;

  function assertReadOnly(method: string, path: string) {
    if (method.toUpperCase() !== 'GET' && unsafeWritePattern.test(path)) {
      post({
        kind: 'blocked-write',
        method,
        path,
        requestFields: [],
        responseFields: [],
      });
      throw new Error(`[HYYD_EDIT_PAGE_PROBE] blocked unsafe write request: ${method} ${path}`);
    }
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const info = urlInfo(input);
    const method =
      init?.method ||
      (input instanceof Request ? input.method : undefined) ||
      'GET';
    const body = init?.body ?? (input instanceof Request ? null : null);
    const requestFields = fields(parseMaybeJson(typeof body === 'string' ? body : null));
    if (info.url.includes('ccm.taikang.com')) assertReadOnly(method, info.path);
    const response = await originalFetch(input, init);
    if (info.url.includes('ccm.taikang.com')) {
      response
        .clone()
        .text()
        .then((text) => {
          const data = parseMaybeJson(text);
          post({
            kind: 'fetch',
            method,
            path: info.path,
            requestFields,
            responseFields: fields(data),
          });
        })
        .catch(() => {});
    }
    return response;
  };

  const OriginalXHR = window.XMLHttpRequest;
  const originalOpen = OriginalXHR.prototype.open;
  const originalSend = OriginalXHR.prototype.send;

  OriginalXHR.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ) {
    (this as any).__hyydProbe = { method, ...urlInfo(url) };
    return originalOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };

  OriginalXHR.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const probe = (this as any).__hyydProbe;
    if (probe?.url?.includes('ccm.taikang.com')) {
      const requestFields = fields(parseMaybeJson(typeof body === 'string' ? body : null));
      assertReadOnly(probe.method || 'GET', probe.path || '');
      this.addEventListener('loadend', () => {
        const data = parseMaybeJson(this.responseText);
        post({
          kind: 'xhr',
          method: probe.method,
          path: probe.path,
          requestFields,
          responseFields: fields(data),
        });
      });
    }
    return originalSend.call(this, body);
  };

  post({ kind: 'installed' });
})();
