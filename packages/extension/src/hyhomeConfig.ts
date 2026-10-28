export type HyhomeSiteConfig = {
  origin: string
  listResourceId: string
  detailResourceId: string
}

export const HYHOME_CONFIG_KEY = 'hyhomeManagedSiteV2'

export function normalizeHyhomeSites(value: unknown): HyhomeSiteConfig[] {
  const configured = Array.isArray(value) ? value : []
  const sites: HyhomeSiteConfig[] = []
  for (const item of configured) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Partial<HyhomeSiteConfig>
    if (typeof raw.origin !== 'string' || typeof raw.listResourceId !== 'string' || typeof raw.detailResourceId !== 'string') continue
    let url: URL
    try { url = new URL(raw.origin) } catch { continue }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || !raw.listResourceId || !raw.detailResourceId) continue
    const site = { origin: url.origin, listResourceId: raw.listResourceId.trim(), detailResourceId: raw.detailResourceId.trim() }
    const index = sites.findIndex((known) => known.origin === url.origin)
    if (index >= 0) sites[index] = site
    else sites.push(site)
  }
  return sites
}

export function siteForUrl(sites: HyhomeSiteConfig[], url: string): HyhomeSiteConfig | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  return sites.find((site) => site.origin === parsed.origin) ?? null
}
