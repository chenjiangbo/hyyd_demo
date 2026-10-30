import { HYHOME_CONFIG_KEY, normalizeHyhomeSites, siteForUrl } from '../hyhomeConfig'
import { syncHyhomeSite } from './hyhomeSites'

type Session = { token: string; orderNo: string; channelOrderNo: string; formOrderNo: string | null; detail: boolean; detailUrl: string | null; documentId: string | null; frameId: number | null; selectedAt: number; calculation?: Record<string, string>; refreshingUntil?: number }
const sessions = new Map<number, Session>()
const focusStates = new Map<number, boolean>()
const pendingCalculations = new Map<number, { values: Record<string, string>; at: number }>()
const BRIDGE_URL = 'http://127.0.0.1:43186/pet/order-page'
const calculationKeys = ['taskid', '_srcrptid', '_srccell', '_srcgridid', 'iscondition', 'hiddencalcparams', 'drillpath', 'bi_calc_dont_save_result', '@DDBH1', '@tk', 'hiddendrillpath', 'rptid']

// 在扩展后台监听报表计算请求，避免依赖网页脚本中的 XMLHttpRequest 包装。
chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.tabId < 0 || !new URL(details.url).pathname.endsWith('/reqmgr.do') || !details.requestBody) return
  void captureCalculation(details)
}, { urls: ['<all_urls>'], types: ['xmlhttprequest'] }, ['requestBody'])

async function captureCalculation(details: chrome.webRequest.WebRequestBodyDetails): Promise<void> {
  const configured = await chrome.storage.local.get(HYHOME_CONFIG_KEY)
  if (!siteForUrl(normalizeHyhomeSites(configured[HYHOME_CONFIG_KEY]), details.url)) return
  let params: URLSearchParams
  if (details.requestBody.formData) {
    params = new URLSearchParams()
    for (const [key, values] of Object.entries(details.requestBody.formData)) for (const value of values) params.append(key, value)
  } else {
    const bytes = details.requestBody.raw?.flatMap((part) => part.bytes ? [new Uint8Array(part.bytes)] : []) ?? []
    if (!bytes.length) return
    params = new URLSearchParams(bytes.map((part) => new TextDecoder().decode(part)).join(''))
  }
  if (params.get('action') !== 'calc' || !params.get('@DDBH1') || !params.get('rptid')) return
  const values = Object.fromEntries(calculationKeys.filter((key) => params.has(key)).map((key) => [key, params.get(key)!]))
  pendingCalculations.set(details.tabId, { values, at: Date.now() })
  console.info('[寰宇订单刷新] 后台捕获到报表计算请求')
  void getSession(details.tabId).then(async (session) => {
    if (!session || session.detail || session.frameId !== details.frameId || session.orderNo !== values['@DDBH1']) return
    const tab = await chrome.tabs.get(details.tabId).catch(() => null)
    const stored = await chrome.storage.local.get(HYHOME_CONFIG_KEY)
    const site = siteForUrl(normalizeHyhomeSites(stored[HYHOME_CONFIG_KEY]), tab?.url ?? '')
    if (!site || values.rptid !== site.detailResourceId) return
    session.calculation = values
    await remember(details.tabId, session)
    console.info('[寰宇订单刷新] 后台已记录当前订单计算参数')
  }).catch(() => undefined)
}

async function tabWindowVisible(tab: chrome.tabs.Tab): Promise<boolean> {
  if (!tab.active || typeof tab.windowId !== 'number') return false
  try {
    const window = await chrome.windows.get(tab.windowId)
    if (window.state === 'minimized') return false
    if (window.focused) return true
    // 点击精灵面板时 Chrome 会失焦，仍应允许用户继续编辑。
    const lastFocused = await chrome.windows.getLastFocused()
    if (lastFocused.id !== tab.windowId) return false
    const response = await fetch('http://127.0.0.1:43186/pet/window-focus', { signal: AbortSignal.timeout(1000) })
    return response.ok && (await response.json() as { focused?: boolean }).focused === true
  } catch {
    return false
  }
}

async function syncWindowPanels(windowId?: number): Promise<void> {
  // MV3 后台休眠后，页面会话仍保存在 session storage。
  const stored = await chrome.storage.session.get()
  for (const [key, value] of Object.entries(stored)) {
    const match = key.match(/^hyhome:(\d+)$/)
    if (match && !sessions.has(Number(match[1]))) {
      const session = value as Session
      if (session?.token && session.orderNo) sessions.set(Number(match[1]), session)
    }
  }
  for (const [tabId, session] of sessions) {
    if (!session.detail) continue
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab) { await forget(tabId); continue }
    if (windowId !== undefined && tab.windowId !== windowId) continue
    const visible = await tabWindowVisible(tab)
    focusStates.set(tabId, visible)
    await post(!tab.active ? 'close' : visible ? 'open' : 'suspend', tabId, session)
  }
}

async function post(event: 'open' | 'close' | 'suspend' | 'refresh-failed' | 'refresh-complete', tabId: number, session: Session): Promise<void> {
  try {
    const response = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, tabId, token: session.token, orderNo: session.orderNo, formOrderNo: session.formOrderNo, channelOrderNo: session.channelOrderNo }),
      signal: AbortSignal.timeout(2_000)
    })
    const payload = response.ok ? await response.json().catch(() => null) as { refresh?: boolean; needResetMasterData?: boolean } | null : null
    if (event === 'open' && payload?.refresh && session.frameId !== null) {
      console.info('[寰宇订单刷新] 客户端请求刷新')
      if (payload.needResetMasterData === true) {
        console.info('[寰宇订单刷新] 本次新建档案，准备触发重置维表按钮')
        const result = await chrome.tabs.sendMessage(tabId, { type: 'HYHOME_RESET_MASTER_DATA', orderNo: session.orderNo }, { frameId: session.frameId }).catch((error) => { console.warn('[寰宇订单刷新] 无法向详情页发送重置指令', error); return null }) as { resetButton?: string } | null
        const descriptions: Record<string, string> = { clicked: '已触发重置维表按钮', 'not-detail': '当前页面不是订单详情', 'order-mismatch': '订单号未通过校验，未触发按钮', 'not-found': '详情页未找到重置维表按钮', multiple: '详情页有多个同名重置按钮，未触发', 'click-error': '触发重置维表按钮时发生错误' }
        console.info('[寰宇订单刷新]', descriptions[result?.resetButton ?? ''] ?? '详情页未确认按钮是否触发')
      } else {
        console.info('[寰宇订单刷新] 本次无新建档案，不触发重置按钮')
      }
      const stored = await chrome.storage.local.get(HYHOME_CONFIG_KEY)
      const site = siteForUrl(normalizeHyhomeSites(stored[HYHOME_CONFIG_KEY]), session.detailUrl ?? '')
      if (!site || !session.calculation || session.calculation['@DDBH1'] !== session.orderNo || session.calculation.rptid !== site.detailResourceId) {
        console.warn('[寰宇订单刷新] 未找到当前订单的计算参数，请重新打开订单')
        await post('refresh-failed', tabId, session)
        return
      }
      session.refreshingUntil = Date.now() + 30000
      const deadline = session.refreshingUntil
      await remember(tabId, session)
      await chrome.tabs.sendMessage(tabId, { type: 'HYHOME_REFRESH_ORDER_FORM', orderNo: session.orderNo, detailResourceId: site.detailResourceId, values: session.calculation }, { frameId: session.frameId })
      console.info('[寰宇订单刷新] 已向详情页发送重算指令')
      setTimeout(() => { void getSession(tabId).then(async (latest) => {
        if (latest?.token !== session.token || latest.refreshingUntil !== deadline) return
        latest.refreshingUntil = undefined
        await remember(tabId, latest)
        await post('refresh-failed', tabId, latest)
      }) }, 30000)
    }
  } catch (error) {
    if (event === 'open' && session.refreshingUntil) console.warn('[寰宇订单刷新] 发送刷新指令失败', error)
    // 精灵未启动时，下一个详情心跳会再次发送；页面检测不依赖本机服务在线。
  }
}

async function forget(tabId: number, expectedDocumentId?: string): Promise<void> {
  const session = sessions.get(tabId)
  if (!session || (expectedDocumentId && session.documentId && session.documentId !== expectedDocumentId)) return
  sessions.delete(tabId)
  await chrome.storage.session.remove(`hyhome:${tabId}`)
  if (session.detail) await post('close', tabId, session)
}

async function closeDetail(tabId: number, expectedDocumentId?: string): Promise<void> {
  const session = await getSession(tabId)
  if (!session || (expectedDocumentId && session.documentId && session.documentId !== expectedDocumentId)) return
  if (session.detail) await post('close', tabId, session)
  session.detail = false
  await remember(tabId, session)
}

async function getSession(tabId: number): Promise<Session | null> {
  const cached = sessions.get(tabId)
  if (cached) return cached
  const key = `hyhome:${tabId}`
  const saved = (await chrome.storage.session.get(key))[key] as Session | undefined
  if (saved?.token && saved.orderNo) {
    sessions.set(tabId, saved)
    return saved
  }
  return null
}

async function remember(tabId: number, session: Session): Promise<void> {
  sessions.set(tabId, session)
  await chrome.storage.session.set({ [`hyhome:${tabId}`]: session })
}

export async function handleHyhomePageEvent(message: unknown, sender: chrome.runtime.MessageSender): Promise<void> {
  if (!message || typeof message !== 'object' || !sender.tab?.id || sender.frameId === 0) return
  const event = message as { kind?: string; orderNo?: string; channelOrderNo?: string; formOrderNo?: string | null; at?: number; values?: Record<string, string>; stage?: string }
  const tabId = sender.tab.id
  let stored = await chrome.storage.local.get(HYHOME_CONFIG_KEY)
  let sites = normalizeHyhomeSites(stored[HYHOME_CONFIG_KEY])
  // 本机精灵登录/启动可能晚于扩展；收到页面事件时补拉配置，storage.onChanged 会让页面脚本立即重扫。
  if (sites.length === 0) {
    await syncHyhomeSite()
    stored = await chrome.storage.local.get(HYHOME_CONFIG_KEY)
    sites = normalizeHyhomeSites(stored[HYHOME_CONFIG_KEY])
  }
  const topUrl = sender.tab.url ?? ''
  const site = siteForUrl(sites, topUrl)
  if (!site || !new URL(topUrl).pathname.startsWith('/abi/eportal/pcportal/portal.do')) return
  if (siteForUrl(sites, sender.url ?? '')?.origin !== site.origin &&
      new URL(sender.url ?? topUrl).hostname !== new URL(site.origin).hostname) return

  if (event.kind === 'trace' && ['捕获到订单计算请求', '计算请求的格式不是文本', '重算参数校验失败', '详情页收到重算指令', '报表计算超时或未返回结果', '计算返回新报表ID', '开始执行报表计算', '调用报表计算时报错'].includes(event.stage ?? '')) {
    console.info('[寰宇订单刷新]', event.stage)
    return
  }

  if (event.kind === 'selected') {
    const orderNo = event.orderNo?.trim() ?? ''
    if (!/^[A-Za-z0-9-]{6,64}$/.test(orderNo)) return
    await forget(tabId)
    const pending = pendingCalculations.get(tabId)
    const calculation = pending && Date.now() - pending.at < 15000 && pending.values['@DDBH1'] === orderNo && pending.values.rptid === site.detailResourceId ? pending.values : undefined
    await remember(tabId, {
      token: crypto.randomUUID(), orderNo,
      channelOrderNo: typeof event.channelOrderNo === 'string' ? event.channelOrderNo.slice(0, 64) : '',
      formOrderNo: null,
      detail: false, detailUrl: null, documentId: sender.documentId ?? null, frameId: sender.frameId ?? null,
      selectedAt: typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : Date.now(), calculation
    })
    if (calculation) console.info('[寰宇订单刷新] 已匹配本次订单计算参数')
    return
  }

  const session = await getSession(tabId)
  if (!session) { if (event.kind === 'calculation') console.warn('[寰宇订单刷新] 捕获计算请求时没有订单会话'); return }
  if (event.kind === 'focus-check') {
    if (!session.detail || sender.frameId !== session.frameId) return
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab) return
    const visible = await tabWindowVisible(tab)
    if (focusStates.get(tabId) !== visible) {
      focusStates.set(tabId, visible)
      await post(!tab.active ? 'close' : visible ? 'open' : 'suspend', tabId, session)
    }
    return
  }
  if (event.kind === 'refresh-failed' && sender.frameId === session.frameId) {
    session.refreshingUntil = undefined
    await remember(tabId, session)
    await post('refresh-failed', tabId, session)
    return
  }
  if (event.kind === 'calculation') {
    if (sender.frameId === session.frameId && event.values?.['@DDBH1'] === session.orderNo && event.values.rptid === site.detailResourceId) {
      session.calculation = event.values
      await remember(tabId, session)
      console.info('[寰宇订单刷新] 已记录当前订单计算参数')
    } else console.warn('[寰宇订单刷新] 计算参数与当前订单、资源或页面不匹配')
    return
  }
  if ((event.kind === 'list' || event.kind === 'other') && typeof event.at === 'number' && event.at < session.selectedAt) return
  if (event.kind === 'detail') {
    const pending = pendingCalculations.get(tabId)
    if (!session.calculation && pending && Date.now() - pending.at < 15000 && pending.values['@DDBH1'] === session.orderNo && pending.values.rptid === site.detailResourceId) {
      session.calculation = pending.values
      console.info('[寰宇订单刷新] 详情页已补充匹配的计算参数')
    }
    const refreshing = Boolean(session.refreshingUntil && session.refreshingUntil > Date.now())
    if (session.detailUrl && session.detailUrl !== sender.url && !refreshing) return
    if (refreshing && !event.formOrderNo) return
    if (refreshing) session.refreshingUntil = undefined
    session.detail = true
    session.detailUrl = sender.url ?? null
    session.documentId = sender.documentId ?? null
    session.frameId = sender.frameId ?? null
    session.formOrderNo = typeof event.formOrderNo === 'string' && /^[A-Za-z0-9-]{6,64}$/.test(event.formOrderNo)
      ? event.formOrderNo : null
    await remember(tabId, session)
    if (refreshing && session.formOrderNo === session.orderNo) { console.info('[寰宇订单刷新] 新报表已加载并核对订单'); await post('refresh-complete', tabId, session) }
    if (sender.tab.active) await post(await tabWindowVisible(sender.tab) ? 'open' : 'suspend', tabId, session)
  } else if (event.kind === 'list') {
    await closeDetail(tabId)
  } else if (event.kind === 'leave') {
    if (session.refreshingUntil && session.refreshingUntil > Date.now()) return
    await closeDetail(tabId, sender.documentId)
  } else if (event.kind === 'other') {
    await forget(tabId)
  }
}

chrome.tabs.onRemoved.addListener((tabId) => { pendingCalculations.delete(tabId); focusStates.delete(tabId); void forget(tabId) })
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[HYHOME_CONFIG_KEY]) return
  for (const tabId of sessions.keys()) void forget(tabId)
})
chrome.tabs.onActivated.addListener(({ tabId }) => {
  for (const [otherTabId, session] of sessions) {
    if (otherTabId !== tabId && session.detail) void post('close', otherTabId, session)
  }
  void syncWindowPanels()
})
chrome.windows.onBoundsChanged.addListener((window) => { void syncWindowPanels(window.id) })
chrome.windows.onFocusChanged.addListener((windowId) => {
  // 焦点切换到精灵时，等 Electron 窗口获得焦点后再判断。
  setTimeout(() => { void syncWindowPanels() }, windowId === chrome.windows.WINDOW_ID_NONE ? 150 : 0)
})
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return
  void chrome.storage.local.get(HYHOME_CONFIG_KEY).then((stored) => {
    const site = siteForUrl(normalizeHyhomeSites(stored[HYHOME_CONFIG_KEY]), tab.url ?? '')
    if (!site || !new URL(tab.url!).pathname.startsWith('/abi/eportal/pcportal/portal.do')) void forget(tabId)
  })
})
