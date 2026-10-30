import { HYHOME_CONFIG_KEY, normalizeHyhomeSites } from '../hyhomeConfig'

const CONFIG_URL = 'http://127.0.0.1:43186/pet/order-site-config'
let syncing = false

export async function syncHyhomeSite(): Promise<void> {
  if (syncing) return
  syncing = true
  try {
    const response = await fetch(CONFIG_URL, { signal: AbortSignal.timeout(5_000) })
    const payload = response.ok ? await response.json() as { data?: { site?: unknown } } : null
    const raw = payload?.data?.site as { origin?: string; origins?: string[]; listResourceId?: string; detailResourceId?: string } | undefined
    const sites = normalizeHyhomeSites(raw ? (raw.origins ?? [raw.origin]).map((origin) => ({ ...raw, origin })) : [])
    const matches = [...new Set(sites.map((site) => { const url = new URL(site.origin); return `${url.protocol}//${url.hostname}/*` }))]
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['hyhome-calculation', 'hyhome-detector'] })
    if (JSON.stringify([...(existing[0]?.matches ?? [])].sort()) !== JSON.stringify([...matches].sort()) || existing.length !== (matches.length ? 2 : 0)) {
      if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((script) => script.id) })
      if (matches.length) await chrome.scripting.registerContentScripts([
        { id: 'hyhome-calculation', matches, js: ['hyhomeCalculation.global.js'], runAt: 'document_start', world: 'MAIN', allFrames: true },
        { id: 'hyhome-detector', matches, js: ['hyhomeDetector.global.js'], runAt: 'document_end', allFrames: true }
      ])
    }
    const current = await chrome.storage.local.get(HYHOME_CONFIG_KEY)
    if (JSON.stringify(current[HYHOME_CONFIG_KEY] ?? []) !== JSON.stringify(sites)) {
      await chrome.storage.local.set({ [HYHOME_CONFIG_KEY]: sites })
    }
  } catch {
    // 本机精灵不可用时清除旧规则，避免沿用另一部署环境的配置。
    await chrome.storage.local.remove(HYHOME_CONFIG_KEY)
  } finally {
    syncing = false
  }
}
