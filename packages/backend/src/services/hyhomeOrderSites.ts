import type { PrismaClient } from '@prisma/client'

export type HyhomeOrderSite = {
  origin: string
  listResourceId: string
  detailResourceId: string
}

const KEY = 'hyhome_order_page_site'

export function validateHyhomeOrderSite(input: unknown): HyhomeOrderSite {
  if (!input || typeof input !== 'object') throw new Error('请填写订单站点配置')
  const item = input as Record<string, unknown>
  const address = typeof item.origin === 'string' ? item.origin.trim() : ''
  const listResourceId = typeof item.listResourceId === 'string' ? item.listResourceId.trim() : ''
  const detailResourceId = typeof item.detailResourceId === 'string' ? item.detailResourceId.trim() : ''
  let url: URL
  try { url = new URL(address) } catch { throw new Error('站点地址无效') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || !url.hostname) {
    throw new Error('站点地址只需填写 http(s)://域名[:端口]')
  }
  if (!listResourceId || !detailResourceId || listResourceId.length > 200 || detailResourceId.length > 200) {
    throw new Error('请填写有效的订单列表和订单维护资源 ID')
  }
  return { origin: url.origin, listResourceId, detailResourceId }
}

export async function getHyhomeOrderSite(prisma: PrismaClient): Promise<HyhomeOrderSite | null> {
  const rows = await prisma.$queryRaw<Array<{ value: unknown }>>`
    SELECT value FROM sys_settings WHERE key = ${KEY}
  `
  return rows.length ? validateHyhomeOrderSite(rows[0].value) : null
}

export async function saveHyhomeOrderSite(prisma: PrismaClient, input: unknown): Promise<HyhomeOrderSite> {
  const site = validateHyhomeOrderSite(input)
  await prisma.$executeRaw`
    INSERT INTO sys_settings (key, value, updated_at)
    VALUES (${KEY}, ${JSON.stringify(site)}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `
  return site
}
