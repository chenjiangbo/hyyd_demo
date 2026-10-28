import type { PrismaClient } from '@prisma/client'

const SETTING_KEY = 'order_ai_automation_config'

export type OrderAiAutomationConfig = {
  imageAiEnabled: boolean
  communicationSilenceMinutes: number
  updatedAt: string | null
}

export function validateOrderAiAutomationConfig(input: unknown): Omit<OrderAiAutomationConfig, 'updatedAt'> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('AI 自动分析配置必须是对象')
  }
  const value = input as Record<string, unknown>
  if (typeof value.imageAiEnabled !== 'boolean') throw new Error('图片 AI 分析开关值无效')
  if (!Number.isInteger(value.communicationSilenceMinutes)
    || Number(value.communicationSilenceMinutes) < 1
    || Number(value.communicationSilenceMinutes) > 60) {
    throw new Error('微信/企微静默时间必须是 1 到 60 分钟之间的整数')
  }
  return {
    imageAiEnabled: value.imageAiEnabled,
    communicationSilenceMinutes: Number(value.communicationSilenceMinutes)
  }
}

export async function getOrderAiAutomationConfig(prisma: PrismaClient): Promise<OrderAiAutomationConfig> {
  const rows = await prisma.$queryRaw<Array<{ value: unknown; updated_at: Date }>>`
    SELECT value, updated_at FROM sys_settings WHERE key = ${SETTING_KEY}
  `
  const row = rows[0]
  if (!row) throw new Error('系统缺少 AI 自动分析配置，请检查后台系统设置初始化状态')
  const config = validateOrderAiAutomationConfig(row.value)
  return { ...config, updatedAt: row.updated_at.toISOString() }
}

export async function saveOrderAiAutomationConfig(
  prisma: PrismaClient,
  input: unknown
): Promise<OrderAiAutomationConfig> {
  const config = validateOrderAiAutomationConfig(input)
  await prisma.$executeRaw`
    INSERT INTO sys_settings (key, value, updated_at)
    VALUES (${SETTING_KEY}, ${JSON.stringify(config)}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `
  return getOrderAiAutomationConfig(prisma)
}

export async function isImageAiEnabled(prisma: PrismaClient): Promise<boolean> {
  return (await getOrderAiAutomationConfig(prisma)).imageAiEnabled
}
