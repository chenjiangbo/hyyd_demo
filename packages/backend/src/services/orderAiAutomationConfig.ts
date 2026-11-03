import type { PrismaClient } from '@prisma/client'

const SETTING_KEY = 'order_ai_automation_config'

export type OrderAiAutomationConfig = {
  imageAiEnabled: boolean
  communicationSilenceMinutes: number
  imageAiAnalysisStartAt: string
  updatedAt: string | null
}

export function validateOrderAiAutomationConfig(input: unknown): Pick<OrderAiAutomationConfig, 'imageAiEnabled' | 'communicationSilenceMinutes'> {
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

export function parseNativeChatImageAnalysisStartAt(value: unknown): Date {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('系统缺少图片 AI 分析开始时间，请检查系统设置')
  const startAt = (value as Record<string, unknown>).startAt
  if (typeof startAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(startAt)) throw new Error('图片 AI 分析开始时间格式无效')
  const date = new Date(startAt)
  if (!Number.isFinite(date.getTime())) throw new Error('图片 AI 分析开始时间无效')
  return date
}

// Prisma reads a TIMESTAMP WITHOUT TIME ZONE as a Date whose UTC fields are the stored Beijing clock time.
export function nativeChatStoredBeijingTimeIsEligible(storedTime: Date, startAt: Date): boolean {
  if (!Number.isFinite(storedTime.getTime()) || !Number.isFinite(startAt.getTime())) throw new Error('图片消息时间无效')
  return storedTime.getTime() >= startAt.getTime() + 8 * 60 * 60 * 1000
}

export async function getNativeChatImageAnalysisStartAt(prisma: PrismaClient): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ value: unknown }>>`
    SELECT value FROM sys_settings WHERE key = 'native_chat_image_analysis_start'
  `
  return parseNativeChatImageAnalysisStartAt(rows[0]?.value)
}

export async function getOrderAiAutomationConfig(prisma: PrismaClient): Promise<OrderAiAutomationConfig> {
  const rows = await prisma.$queryRaw<Array<{ key: string; value: unknown; updated_at: Date }>>`
    SELECT key, value, updated_at FROM sys_settings WHERE key IN (${SETTING_KEY}, 'native_chat_image_analysis_start')
  `
  const row = rows.find((item) => item.key === SETTING_KEY)
  if (!row) throw new Error('系统缺少 AI 自动分析配置，请检查后台系统设置初始化状态')
  const config = validateOrderAiAutomationConfig(row.value)
  const imageAiAnalysisStartAt = parseNativeChatImageAnalysisStartAt(rows.find((item) => item.key === 'native_chat_image_analysis_start')?.value)
  return { ...config, imageAiAnalysisStartAt: imageAiAnalysisStartAt.toISOString(), updatedAt: row.updated_at.toISOString() }
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
