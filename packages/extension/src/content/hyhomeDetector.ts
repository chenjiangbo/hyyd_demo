import { HYHOME_CONFIG_KEY, normalizeHyhomeSites, siteForUrl } from '../hyhomeConfig'

type PageKind = 'list' | 'detail' | 'other'
const sourceIdPattern = /\bvar\s+g_srcresid\s*=\s*["']([^"']+)["']/m
let pageKind: PageKind | null = null
let detailHeartbeat: number | null = null
let scheduledScan: number | null = null
let lastDetailOrderNo: string | null | undefined
let site = siteForUrl(normalizeHyhomeSites(null), location.href)

function sourceResourceId(): string | null {
  for (const script of document.scripts) {
    const match = script.textContent?.match(sourceIdPattern)
    if (match) return match[1]
  }
  return null
}

function send(kind: PageKind | 'selected' | 'leave', orderNo?: string, channelOrderNo?: string): void {
  const formOrderNo = kind === 'detail' ? readDetailOrderNo() : undefined
  void chrome.runtime.sendMessage({ type: 'HYHOME_PAGE_EVENT', kind, orderNo, channelOrderNo, formOrderNo, at: performance.timeOrigin + performance.now() }).catch(() => undefined)
}

function readDetailOrderNo(): string | null {
  const report = document.querySelector('#reportbody')
  if (!report) return null
  const candidates = new Set<string>()
  const roots: ParentNode[] = [report]
  const seen = new Set<ParentNode>()
  while (roots.length > 0) {
    const root = roots.shift()!
    if (root === document && candidates.size > 0) continue
    if (seen.has(root)) continue
    seen.add(root)
    for (const label of root.querySelectorAll<HTMLElement>('td,th,label,span,div')) {
      if ((label.textContent ?? '').replace(/[\s:：]/g, '') !== '订单号') continue
      if (label.getClientRects().length === 0) continue
      // 表格标签常被 span/div 包住，先找到所属单元格，再读紧邻的值单元格。
      const labelCell = label.closest('td,th')
      const valueCell = labelCell?.nextElementSibling ?? label.nextElementSibling
      if (!valueCell || valueCell.getClientRects().length === 0) continue
      const value = (valueCell.querySelector('input') as HTMLInputElement | null)?.value ?? valueCell.textContent ?? ''
      const normalized = value.replace(/\s/g, '').trim()
      if (/^[A-Za-z0-9-]{6,64}$/.test(normalized)) candidates.add(normalized)
    }
    if (candidates.size === 0) {
      const visibleText = root instanceof Document ? root.body?.innerText : (root as HTMLElement).innerText
      for (const match of (visibleText ?? '').matchAll(/(?:^|\n)\s*订单号[\s:：]+([A-Za-z0-9-]{6,64})(?=\s|$)/g)) {
        candidates.add(match[1])
      }
    }
    // 少数报表把内容写入 reportbody 下的子 frame；只读取同源内容。
    for (const frame of root.querySelectorAll<HTMLIFrameElement>('iframe')) {
      try {
        if (frame.contentDocument) roots.push(frame.contentDocument)
      } catch { /* 跨域 frame 不可读，保持校验失败 */ }
    }
    if (root === report) roots.push(document)
  }
  return candidates.size === 1 ? [...candidates][0] : null
}

function scan(): void {
  if (!site) {
    pageKind = null
    if (detailHeartbeat !== null) window.clearInterval(detailHeartbeat)
    detailHeartbeat = null
    return
  }
  const resourceId = sourceResourceId()
  const next: PageKind = resourceId === site.detailResourceId &&
    document.querySelector('#reportbody') !== null
      ? 'detail'
      : resourceId === site.listResourceId ? 'list' : 'other'
  if (next !== pageKind) {
    pageKind = next
    lastDetailOrderNo = next === 'detail' ? readDetailOrderNo() : undefined
    send(next)
  } else if (next === 'detail') {
    const currentOrderNo = readDetailOrderNo()
    if (currentOrderNo !== lastDetailOrderNo) {
      lastDetailOrderNo = currentOrderNo
      send('detail')
    }
  }
  if (next === 'detail' && detailHeartbeat === null) {
    detailHeartbeat = window.setInterval(() => send('detail'), 5_000)
  } else if (next !== 'detail' && detailHeartbeat !== null) {
    window.clearInterval(detailHeartbeat)
    detailHeartbeat = null
  }
}

document.addEventListener('click', (event) => {
  const link = (event.target as Element | null)?.closest('a')
  if (!link || link.textContent?.trim() !== '订单维护') return
  const row = link.closest('tr')
  const orderNo = row?.querySelector('[id^="GRID1.A"]')?.textContent?.trim()
  const channelOrderNo = row?.querySelector('[id^="GRID1.D"]')?.textContent?.trim()
  if (orderNo && /^[A-Za-z0-9-]{6,64}$/.test(orderNo)) send('selected', orderNo, channelOrderNo ?? '')
}, true)

window.addEventListener('pagehide', () => {
  if (pageKind === 'detail') send('leave')
  if (detailHeartbeat !== null) window.clearInterval(detailHeartbeat)
})

void chrome.storage.local.get(HYHOME_CONFIG_KEY).then((stored) => {
  site = siteForUrl(normalizeHyhomeSites(stored[HYHOME_CONFIG_KEY]), location.href)
  scan()
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[HYHOME_CONFIG_KEY]) return
  site = siteForUrl(normalizeHyhomeSites(changes[HYHOME_CONFIG_KEY].newValue), location.href)
  scan()
})

chrome.runtime.onMessage.addListener((message: { type?: string }) => {
  if (message?.type === 'HYHOME_REFRESH_ORDER_FORM' && pageKind === 'detail') {
    window.location.reload()
  }
})
const observer = new MutationObserver(() => {
  if (scheduledScan !== null) return
  scheduledScan = window.setTimeout(() => { scheduledScan = null; scan() }, 100)
})
observer.observe(document.documentElement, { childList: true, subtree: true })
