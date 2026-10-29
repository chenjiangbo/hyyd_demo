// 在页面上下文记录寰宇报表计算参数，并调用页面自身的计算任务。
(() => {
  const source = 'HYYD_HYHOME_CALCULATION'
  const trace = (stage: string) => window.postMessage({ source, type: 'trace', stage }, location.origin)
  const keys = ['taskid', '_srcrptid', '_srccell', '_srcgridid', 'iscondition', 'hiddencalcparams', 'drillpath', 'bi_calc_dont_save_result', '@DDBH1', '@tk', 'hiddendrillpath', 'rptid']
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send
  const requestUrls = new WeakMap<XMLHttpRequest, string>()
  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
    requestUrls.set(this, String(url))
    return (originalOpen as Function).call(this, method, url, ...rest)
  } as typeof XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      const url = new URL(requestUrls.get(this) ?? '', location.href)
      if (url.origin === location.origin && url.pathname.endsWith('/reqmgr.do') && typeof body === 'string') {
        const params = new URLSearchParams(body)
        if (params.get('action') === 'calc' && params.has('@DDBH1') && params.has('rptid')) {
          trace('捕获到订单计算请求')
          const values = Object.fromEntries(keys.filter((key) => params.has(key)).map((key) => [key, params.get(key)!]))
          window.postMessage({ source, type: 'capture', values }, location.origin)
        }
      } else if (url.origin === location.origin && url.pathname.endsWith('/reqmgr.do') && typeof body !== 'string') trace('计算请求的格式不是文本')
    } catch { /* 不影响页面原有请求 */ }
    return originalSend.call(this, body)
  }
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== source || event.data?.type !== 'recalculate') return
    const values = event.data.values as Record<string, string>
    const orderNo = event.data.orderNo as string
    if (!values || !/^[A-Za-z0-9-]{6,64}$/.test(orderNo) || values['@DDBH1'] !== orderNo || values.rptid !== event.data.detailResourceId) { trace('重算参数校验失败'); return }
    try {
      trace('详情页收到重算指令')
      const page = window as any
      if (typeof page.createCalcReqTask !== 'function') throw new Error('页面不支持报表计算')
      const task = page.createCalcReqTask()
      let finished = false
      const fail = () => { if (finished) return; finished = true; trace('报表计算超时或未返回结果'); try { task.cancel?.() } catch { /* 任务可能已经结束 */ }; window.postMessage({ source, type: 'failure' }, location.origin) }
      const timeout = window.setTimeout(fail, 15000)
      for (const key of keys) if (key !== 'rptid' && typeof values[key] === 'string') task.setProperty(key, values[key])
      task.setCalcReportId(values.rptid)
      task.setResultTarget('none')
      task.setOnFinish((result: { getId?: () => unknown }) => {
        if (finished) return
        const id = result?.getId?.()
        if (typeof id !== 'string' || !id) { window.clearTimeout(timeout); fail(); return }
        finished = true
        window.clearTimeout(timeout)
        trace('计算返回新报表ID')
        const next = new URL(location.href)
        next.searchParams.set('resid', id)
        next.searchParams.delete('calcnow')
        location.assign(next.href)
      })
      trace('开始执行报表计算')
      task.execute()
    } catch (error) { trace('调用报表计算时报错'); console.error('[寰宇订单刷新] 报表计算失败', error); window.postMessage({ source, type: 'failure' }, location.origin) }
  })
})()
