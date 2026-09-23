import type { PrismaClient } from '@prisma/client'

export type TaikangBusinessKey = 'green_pass' | 'register_assist'

export interface TaikangHuanyuChannelMapping {
  businessKey: TaikangBusinessKey
  businessName: string
  huanyuChannelId: string | null
  huanyuChannelName: string | null
  enabled: boolean
}

type MappingRow = {
  business_key: TaikangBusinessKey
  business_name: string
  huanyu_channel_id: string | null
  huanyu_channel_name: string | null
  enabled: boolean
}

/** 泰康抓单来源的稳定分类，不依赖后台可编辑名称。 */
export function taikangBusinessKeyOf(poolType: string | null | undefined): TaikangBusinessKey {
  return poolType === 'register' ? 'register_assist' : 'green_pass'
}

/** 只读取后台已配置且启用的渠道映射。 */
export async function findTaikangHuanyuChannelMapping(
  prisma: PrismaClient,
  businessKey: TaikangBusinessKey
): Promise<TaikangHuanyuChannelMapping | null> {
  const rows = await prisma.$queryRaw<MappingRow[]>`
    SELECT business_key, business_name, huanyu_channel_id, huanyu_channel_name, enabled
      FROM taikang_huanyu_channel_mappings
     WHERE business_key = ${businessKey}
       AND enabled = true
     LIMIT 1
  `
  const row = rows[0]
  if (!row || !row.huanyu_channel_id) return null
  return {
    businessKey: row.business_key,
    businessName: row.business_name,
    huanyuChannelId: row.huanyu_channel_id,
    huanyuChannelName: row.huanyu_channel_name,
    enabled: row.enabled
  }
}
