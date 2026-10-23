(() => {
  const flag = '__HYYD_FORM_RECORDER_V1__';
  if ((window as any)[flag]) return;
  (window as any)[flag] = true;

  const source = 'HYYD_FORM_RECORDER_V1';
  type SessionContext = {
    id: string;
    kind: string;
    key: string;
    href: string;
    startedAt: string;
    sequence: number;
    sourceOrderNo: string | null;
    serviceName: string | null;
  };
  let bridgeReady = false;
  const buffered: Array<{ source: string; session: Record<string, unknown>; event: Record<string, unknown> }> = [];
  let currentSession: SessionContext | null = null;
  let actionSequence = 0;
  let lastAction: { id: number; at: number; label: string } | null = null;
  let lastState = '';
  let stateTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;

  function route(): { kind: string; key: string; orderId: string | null } | null {
    const hash = location.hash.replace(/^#/, '');
    const [path, query = ''] = hash.split('?');
    const kind = path === '/medicalManager/statusCommon' ? 'green-order'
      : path === '/register/registerCommon' ? 'register-order'
        : path === '/medicalNetworkManage/professionalAdd' ? 'expert-add'
          : path === '/medicalNetworkManage/hospitaAdd' ? 'hospital-add' : null;
    if (!kind) return null;
    const params = new URLSearchParams(query);
    const orderId = params.get('orderId');
    return { kind, key: `${path}:${orderId || params.get('type') || params.get('provider') || ''}`, orderId };
  }

  function visible(element: Element): boolean {
    if (!(element instanceof HTMLElement)) return true;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && !!element.getClientRects().length;
  }

  function stage(): string | null {
    const selectors = [
      '.el-step__title.is-process',
      '.el-step.is-process .el-step__title',
      '.el-tabs__item.is-active',
      '[role="tab"][aria-selected="true"]'
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const label = element?.textContent?.trim();
      if (element && visible(element) && label) return label;
    }
    return null;
  }

  function sessionMetadata(session: SessionContext): Record<string, unknown> {
    if (session === currentSession) {
      const bodyText = document.body?.innerText || '';
      const orderMatch = bodyText.match(/\b(?:COD|CCOD|OD)[A-Za-z0-9]{8,}\b/);
      const serviceMatch = bodyText.match(/服务类型[:：]\s*([^\n]+)/);
      session.sourceOrderNo = orderMatch?.[0] || session.sourceOrderNo;
      session.serviceName = serviceMatch?.[1]?.trim() || session.serviceName;
    }
    return {
      id: session.id,
      routeKind: session.kind,
      startedAt: session.startedAt,
      sourceOrderNo: session.sourceOrderNo,
      serviceName: session.serviceName
    };
  }

  function emit(kind: string, payload: Record<string, unknown>, session = currentSession): void {
    if (!session) return;
    const item = {
      source,
      session: sessionMetadata(session),
      event: {
        id: crypto.randomUUID(),
        sequence: ++session.sequence,
        occurredAt: new Date().toISOString(),
        kind,
        payload: { href: session === currentSession ? location.href : session.href, stage: session === currentSession ? stage() : null, ...payload }
      }
    };
    if (bridgeReady) window.postMessage(item, location.origin);
    else buffered.push(item);
  }

  function queueScreenshot(trigger: string, relatedSequence: number, delayMs: number, actionId?: number): void {
    const session = currentSession;
    if (!session) return;
    setTimeout(() => {
      if (currentSession !== session || !route()) {
        try { emit('capture-error', { trigger, relatedSequence, error: '截图前页面已切换' }, session); }
        catch (error) { reportCaptureFailure(error, session); }
        return;
      }
      try { emit('screenshot', { trigger, relatedSequence, relatedActionId: actionId ?? null }, session); }
      catch (error) { reportCaptureFailure(error, session); }
    }, delayMs);
  }

  function checkRoute(): void {
    const next = route();
    if (next?.key === currentSession?.key || (!next && !currentSession)) return;
    const previous = currentSession;
    currentSession = null;
    if (previous) emit('session-end', { reason: 'page-change', href: previous.href }, previous);
    currentSession = next ? {
      id: crypto.randomUUID(), kind: next.kind, key: next.key, href: location.href,
      startedAt: new Date().toISOString(), sequence: 0,
      sourceOrderNo: next.orderId, serviceName: null
    } : null;
    actionSequence = 0;
    lastAction = null;
    lastState = '';
    if (next && currentSession) {
      emit('session-start', { routeKind: next.kind, orderId: next.orderId });
      queueScreenshot('进入页面', currentSession.sequence, 700);
      queueState();
    }
  }

  function stateSnapshot(): Record<string, unknown> {
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .map((element) => (element.textContent || element.getAttribute('aria-label') || '').trim())
      .filter(Boolean);
    const dialogs = [...document.querySelectorAll('.el-dialog, [role="dialog"]')]
      .filter(visible)
      .map((element) => (element.querySelector('.el-dialog__title, [role="heading"]')?.textContent || '').trim())
      .filter(Boolean);
    const fields = [...document.querySelectorAll('.el-form-item__label')]
      .filter(visible)
      .map((element) => (element.textContent || '').trim())
      .filter(Boolean);
    return { stage: stage(), buttons, dialogs, fields, iframeCount: document.querySelectorAll('iframe').length };
  }

  function queueState(): void {
    if (!route() || stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      if (!route()) return;
      try {
        const snapshot = stateSnapshot();
        const signature = JSON.stringify(snapshot);
        if (signature !== lastState) {
          lastState = signature;
          emit('page-state', snapshot);
          if (currentSession) queueScreenshot('页面变化', currentSession.sequence, 500);
        }
      } catch (error) { reportCaptureFailure(error, currentSession); }
    }, 250);
  }

  function labelOf(element: Element): string {
    const field = element.closest('.el-form-item');
    const fieldLabel = field?.querySelector('.el-form-item__label')?.textContent?.trim();
    const own = element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent?.trim();
    return [fieldLabel, own].filter(Boolean).join(' · ');
  }

  function actionFromEvent(event: Event): void {
    if (!route()) return;
    const raw = event.target;
    if (!(raw instanceof Element) || raw.closest('#hyyd-form-recorder-status')) return;
    const element = event.type === 'click'
      ? raw.closest('button, [role="button"], [role="tab"], [role="option"], .el-select-dropdown__item, .el-step, label, a')
      : raw.closest('input, select, textarea, [role="checkbox"], [role="switch"]');
    if (!element || !visible(element)) return;
    const label = labelOf(element);
    if (!label) return;
    const action = { id: ++actionSequence, at: Date.now(), label };
    lastAction = action;
    const isSensitiveField = /密码|口令|token|secret/i.test(label);
    const inputValue = event.type === 'change' && !isSensitiveField && element instanceof HTMLInputElement &&
      element.type !== 'password' && element.type !== 'file'
      ? (element.type === 'checkbox' || element.type === 'radio' ? element.checked : element.value)
      : event.type === 'change' && !isSensitiveField && (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)
        ? element.value : undefined;
    emit('action', {
      actionId: action.id,
      action: event.type,
      label,
      tag: element.tagName.toLowerCase(),
      inputType: element instanceof HTMLInputElement ? element.type : null,
      ...(inputValue !== undefined ? { value: inputValue } : {})
    });
    if (currentSession) queueScreenshot(event.type === 'change' ? '填写内容' : '页面操作', currentSession.sequence, 650, action.id);
    queueState();
  }

  function requestContext(): Record<string, unknown> {
    return lastAction && Date.now() - lastAction.at <= 10_000
      ? { relatedActionId: lastAction.id, relatedActionLabel: lastAction.label }
      : { relatedActionId: null };
  }

  function urlInfo(input: unknown): { url: string; path: string } {
    const raw = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input ?? '');
    try {
      const url = new URL(raw, location.href);
      for (const key of url.searchParams.keys()) {
        if (/token|authorization|password|secret|cookie|credential/i.test(key)) url.searchParams.set(key, '[REDACTED]');
      }
      return { url: url.href, path: url.pathname + url.search };
    } catch {
      return { url: raw, path: raw };
    }
  }

  function withoutCredentials(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutCredentials);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [
        key, /token|authorization|password|secret|cookie|credential/i.test(key) ? '[REDACTED]' : withoutCredentials(child)
      ]));
    }
    return value;
  }

  function bodyInfo(body: unknown): unknown {
    if (body == null) return null;
    if (typeof body === 'string') {
      try { return withoutCredentials(JSON.parse(body)); } catch { return body; }
    }
    if (body instanceof URLSearchParams) return [...body.entries()].map(([name, value]) => [
      name, /token|authorization|password|secret|cookie|credential/i.test(name) ? '[REDACTED]' : value
    ]);
    if (body instanceof FormData) return [...body.entries()].map(([name, value]) => ({
      name,
      value: /token|authorization|password|secret|cookie|credential/i.test(name) ? '[REDACTED]'
        : value instanceof File ? { fileName: value.name, type: value.type, size: value.size, bodyCaptured: false } : value
    }));
    if (body instanceof Blob) return { type: body.type, size: body.size, bodyCaptured: false };
    if (body instanceof ArrayBuffer) return { type: 'arraybuffer', size: body.byteLength, bodyCaptured: false };
    return { type: Object.prototype.toString.call(body), bodyCaptured: false };
  }

  function isTaikangApi(info: { url: string; path: string }): boolean {
    try {
      const url = new URL(info.url, location.href);
      return (url.hostname === 'taikang.com' || url.hostname.endsWith('.taikang.com')) &&
        !/^(?:\/ccm-unify)*(?:\/msg\/webNotice|\/ecm\/getImage)\/?$/.test(url.pathname) &&
        !/\.(?:js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|map)$/i.test(url.pathname);
    }
    catch { return false; }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'HYYD_FORM_RECORDER_READY') return;
    bridgeReady = true;
    for (const item of buffered.splice(0)) window.postMessage(item, location.origin);
  });
  document.addEventListener('click', (event) => {
    try { actionFromEvent(event); } catch (error) { reportCaptureFailure(error, currentSession); }
  }, true);
  document.addEventListener('change', (event) => {
    try { actionFromEvent(event); } catch (error) { reportCaptureFailure(error, currentSession); }
  }, true);
  document.addEventListener('scroll', () => {
    if (!currentSession || scrollTimer) return;
    const session = currentSession;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      if (currentSession === session) queueScreenshot('滚动页面', session.sequence, 100);
    }, 600);
  }, true);
  window.addEventListener('hashchange', () => {
    try { checkRoute(); } catch (error) { reportCaptureFailure(error, currentSession); }
  });
  window.addEventListener('pagehide', () => {
    try { if (route()) emit('session-end', { reason: 'page-unload' }); }
    catch (error) { reportCaptureFailure(error, currentSession); }
  });
  new MutationObserver(() => {
    if (!currentSession) return;
    try { checkRoute(); queueState(); }
    catch (error) { reportCaptureFailure(error, currentSession); }
  }).observe(document, { childList: true, subtree: true });
  try { checkRoute(); } catch (error) { reportCaptureFailure(error, currentSession); }

  function reportCaptureFailure(error: unknown, session: SessionContext | null, requestId?: string): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[寰宇探针][填报记录] 记录失败:', message);
    if (!session) return;
    try { emit('capture-error', { requestId: requestId || null, error: message }, session); }
    catch (reportError) { console.error('[寰宇探针][填报记录] 异常上报失败:', reportError); }
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let selected: SessionContext | null;
    let info: { url: string; path: string };
    try {
      checkRoute();
      selected = currentSession;
      if (!selected) return originalFetch(input, init);
      info = urlInfo(input);
      if (!isTaikangApi(info)) return originalFetch(input, init);
    } catch (error) {
      reportCaptureFailure(error, currentSession);
      return originalFetch(input, init);
    }
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    try {
      emit('request', {
        phase: 'start', requestId, method, url: info.url, path: info.path,
        requestBody: bodyInfo(init?.body), ...requestContext()
      }, selected);
      if (input instanceof Request && init?.body == null && input.body) {
        void input.clone().text()
          .then((text) => emit('request', { phase: 'body', requestId, requestBody: bodyInfo(text) }, selected))
          .catch((error) => reportCaptureFailure(error, selected, requestId));
      }
    } catch (error) {
      reportCaptureFailure(error, selected, requestId);
    }
    return originalFetch(input, init).then(
      (response) => {
        try {
          const contentType = response.headers.get('content-type') || '';
          if (/json|text|xml|javascript/i.test(contentType)) {
            void response.clone().text()
              .then((text) => emit('request', {
                phase: 'end', requestId, method, url: info.url, path: info.path, status: response.status,
                durationMs: Math.round(performance.now() - started), responseBody: bodyInfo(text), contentType
              }, selected))
              .catch((error) => reportCaptureFailure(error, selected, requestId));
          } else {
            emit('request', {
              phase: 'end', requestId, method, url: info.url, path: info.path, status: response.status,
              durationMs: Math.round(performance.now() - started), contentType, responseBodyCaptured: false,
              contentLength: response.headers.get('content-length')
            }, selected);
          }
        } catch (error) { reportCaptureFailure(error, selected, requestId); }
        return response;
      },
      (error) => {
        try { emit('request', { phase: 'error', requestId, method, url: info.url, path: info.path, error: String(error) }, selected); }
        catch (captureError) { reportCaptureFailure(captureError, selected, requestId); }
        throw error;
      }
    );
  };

  const XHR = window.XMLHttpRequest;
  const originalOpen = XHR.prototype.open;
  const originalSend = XHR.prototype.send;
  XHR.prototype.open = function (method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null) {
    try {
      (this as any).__hyydFormRequest = route() ? { method, ...urlInfo(url) } : null;
    }
    catch (error) { reportCaptureFailure(error, currentSession); }
    return Reflect.apply(originalOpen, this, arguments);
  };
  XHR.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      checkRoute();
      const selected = currentSession;
      const request = (this as any).__hyydFormRequest;
      if (selected && request && isTaikangApi(request)) {
        const requestId = crypto.randomUUID();
        const started = performance.now();
        emit('request', {
          phase: 'start', requestId, method: request.method, url: request.url, path: request.path,
          requestBody: bodyInfo(body), ...requestContext()
        }, selected);
        this.addEventListener('loadend', () => {
          try {
            let responseBody: unknown;
            if (this.responseType === '' || this.responseType === 'text') responseBody = bodyInfo(this.responseText);
            else if (this.responseType === 'json') responseBody = withoutCredentials(this.response);
            else responseBody = { responseType: this.responseType, bodyCaptured: false };
            emit('request', {
              phase: 'end', requestId, method: request.method, url: request.url, path: request.path, status: this.status,
              durationMs: Math.round(performance.now() - started), responseBody,
              contentType: this.getResponseHeader('content-type')
            }, selected);
          } catch (error) { reportCaptureFailure(error, selected, requestId); }
        }, { once: true });
      }
    } catch (error) {
      reportCaptureFailure(error, currentSession);
    }
    return Reflect.apply(originalSend, this, arguments);
  };
})();
