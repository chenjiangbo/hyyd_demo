import { HYHOME_CONFIG_KEY, normalizeHyhomeSites, siteForUrl } from '../hyhomeConfig'
import { syncHyhomeSite } from './hyhomeSites'

type Session = { token: string; orderNo: string; channelOrderNo: string; formOrderNo: string | null; detail: boolean; detailUrl: string | null; documentId: string | null; frameId: number | null; selectedAt: number }
const sessions = new Map<number, Session>()
const BRIDGE_URL = 'http://127.0.0.1:43186/pet/order-page'

async function tabWindowVisible(tab: chrome.tabs.Tab): Promise<boolean> {
  if (!tab.active || typeof tab.windowId !== 'number') return false
  try {
    return (await chrome.windows.get(tab.windowId)).state !== 'minimized'
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
    await post(!tab.active ? 'close' : await tabWindowVisible(tab) ? 'open' : 'suspend', tabId, session)
  }
}

async function post(event: 'open' | 'close' | 'suspend', tabId: number, session: Session): Promise<void> {
  try {
    const response = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, tabId, token: session.token, orderNo: session.orderNo, formOrderNo: session.formOrderNo, channelOrderNo: session.channelOrderNo }),
      signal: AbortSignal.timeout(2_000)
    })
    const payload = response.ok ? await response.json().catch(() => null) as { refresh?: boolean } | null : null
    if (event === 'open' && payload?.refresh && session.frameId !== null) {
      await chrome.tabs.sendMessage(tabId, { type: 'HYHOME_REFRESH_ORDER_FORM', orderNo: session.orderNo }, { frameId: session.frameId }).catch(() => undefined)
    }
  } catch {
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
  const event = message as { kind?: string; orderNo?: string; channelOrderNo?: string; formOrderNo?: string | null; at?: number }
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

  if (event.kind === 'selected') {
    const orderNo = event.orderNo?.trim() ?? ''
    if (!/^[A-Za-z0-9-]{6,64}$/.test(orderNo)) return
    await forget(tabId)
    await remember(tabId, {
      token: crypto.randomUUID(), orderNo,
      channelOrderNo: typeof event.channelOrderNo === 'string' ? event.channelOrderNo.slice(0, 64) : '',
      formOrderNo: null,
      detail: false, detailUrl: null, documentId: sender.documentId ?? null, frameId: sender.frameId ?? null,
      selectedAt: typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : Date.now()
    })
    return
  }

  const session = await getSession(tabId)
  if (!session) return
  if ((event.kind === 'list' || event.kind === 'other') && typeof event.at === 'number' && event.at < session.selectedAt) return
  if (event.kind === 'detail') {
    if (session.detailUrl && session.detailUrl !== sender.url) return
    session.detail = true
    session.detailUrl = sender.url ?? null
    session.documentId = sender.documentId ?? null
    session.frameId = sender.frameId ?? null
    session.formOrderNo = typeof event.formOrderNo === 'string' && /^[A-Za-z0-9-]{6,64}$/.test(event.formOrderNo)
      ? event.formOrderNo : null
    await remember(tabId, session)
    if (sender.tab.active) await post(await tabWindowVisible(sender.tab) ? 'open' : 'suspend', tabId, session)
  } else if (event.kind === 'list') {
    await closeDetail(tabId)
  } else if (event.kind === 'leave') {
    await closeDetail(tabId, sender.documentId)
  } else if (event.kind === 'other') {
    await forget(tabId)
  }
}

chrome.tabs.onRemoved.addListener((tabId) => { void forget(tabId) })
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
  void syncWindowPanels(windowId === chrome.windows.WINDOW_ID_NONE ? undefined : windowId)
})
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return
  void chrome.storage.local.get(HYHOME_CONFIG_KEY).then((stored) => {
    const site = siteForUrl(normalizeHyhomeSites(stored[HYHOME_CONFIG_KEY]), tab.url ?? '')
    if (!site || !new URL(tab.url!).pathname.startsWith('/abi/eportal/pcportal/portal.do')) void forget(tabId)
  })
})
