import { HYHOME_CONFIG_KEY, normalizeHyhomeSites } from '../hyhomeConfig'

const CONFIG_URL = 'http://127.0.0.1:43186/pet/order-site-config'
let syncing = false

export async function syncHyhomeSite(): Promise<void> {
  if (syncing) return
  syncing = true
  try {
    const response = await fetch(CONFIG_URL, { signal: AbortSignal.timeout(5_000) })
    const payload = response.ok ? await response.json() as { data?: { site?: unknown } } : null
    const sites = normalizeHyhomeSites(payload?.data?.site ? [payload.data.site] : [])
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
