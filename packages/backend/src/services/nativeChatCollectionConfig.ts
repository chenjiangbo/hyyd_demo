import type { NativeChatCollectionConfig, NativeChatCollectionRule } from '@huanyu/shared-types'
import type { PrismaClient } from '@prisma/client'

const SETTING_KEY = 'native_chat_collection_config'

export const EMPTY_NATIVE_CHAT_COLLECTION_CONFIG: NativeChatCollectionConfig = {
  version: 1,
  updatedAt: null,
  rules: []
}

export async function getNativeChatCollectionConfig(
  prisma: PrismaClient
): Promise<NativeChatCollectionConfig> {
  const rows = await prisma.$queryRaw<Array<{ value: unknown; updated_at: Date }>>`
    SELECT value, updated_at FROM sys_settings WHERE key = ${SETTING_KEY}
  `
  const saved = rows[0]
  if (!saved || !saved.value || typeof saved.value !== 'object') {
    return EMPTY_NATIVE_CHAT_COLLECTION_CONFIG
  }

  const value = saved.value as Partial<NativeChatCollectionConfig>
  if (!Array.isArray(value.rules) || !Number.isInteger(value.version)) {
    throw new Error('服务端会话采集规则配置格式错误')
  }
  return {
    version: value.version as number,
    updatedAt: saved.updated_at.toISOString(),
    rules: validateNativeChatCollectionRules(value.rules)
  }
}

export function validateNativeChatCollectionRules(input: unknown): NativeChatCollectionRule[] {
  if (!Array.isArray(input)) throw new Error('rules 必须是数组')
  const rules: NativeChatCollectionRule[] = []
  const ids = new Set<string>()
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('每条会话规则都必须是对象')
    }
    const raw = entry as Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    const channel = raw.channel
    const match = raw.match
    const value = typeof raw.value === 'string' ? raw.value.trim() : ''
    if (!id || ids.has(id)) throw new Error('规则 ID 不能为空且不能重复')
    if (channel !== 'wechat' && channel !== 'wxwork' && channel !== 'both') {
      throw new Error(`规则 ${id} 的平台无效`)
    }
    if (match !== 'source_id' && match !== 'title_exact' && match !== 'title_contains' && match !== 'title_regex') {
      throw new Error(`规则 ${id} 的匹配方式无效`)
    }
    if (!value) throw new Error(`规则 ${id} 的匹配内容不能为空`)
    if (match === 'title_regex') {
      try {
        new RegExp(value, 'i')
      } catch (error) {
        throw new Error(`规则 ${id} 的标题表达式无效：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (typeof raw.enabled !== 'boolean') throw new Error(`规则 ${id} 的启用状态无效`)
    ids.add(id)
    rules.push({
      id,
      enabled: raw.enabled,
      channel,
      match,
      value
    })
  }
  return rules
}

export function matchNativeChatConversationRule(
  config: NativeChatCollectionConfig,
  conversation: {
    channel: 'wechat' | 'wxwork'
    sourceConversationId: string
    title: string | null
  }
): NativeChatCollectionRule | null {
  const title = conversation.title?.trim() ?? ''
  return config.rules.find((rule) => {
    if (!rule.enabled || (rule.channel !== 'both' && rule.channel !== conversation.channel)) return false
    if (rule.match === 'source_id') return rule.value === conversation.sourceConversationId
    if (rule.match === 'title_exact') {
      return title.toLocaleLowerCase() === rule.value.toLocaleLowerCase()
    }
    if (rule.match === 'title_regex') return new RegExp(rule.value, 'i').test(title)
    return title.toLocaleLowerCase().includes(rule.value.toLocaleLowerCase())
  }) ?? null
}

export async function saveNativeChatCollectionConfig(
  prisma: PrismaClient,
  rules: NativeChatCollectionRule[]
): Promise<NativeChatCollectionConfig> {
  const previous = await getNativeChatCollectionConfig(prisma)
  const config: NativeChatCollectionConfig = {
    version: previous.version + 1,
    updatedAt: new Date().toISOString(),
    rules
  }
  await prisma.$executeRaw`
    INSERT INTO sys_settings (key, value, updated_at)
    VALUES (${SETTING_KEY}, ${JSON.stringify(config)}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `
  return config
}
