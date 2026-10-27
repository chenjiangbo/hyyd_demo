import { Prisma, PrismaClient } from '@prisma/client'

// PostgreSQL 的 timestamp 不保存时区；本项目约定其中的数值始终是北京时间。
// Prisma 5 读取 timestamp 时会把墙上时间当作 UTC Date，故在数据库读取边界还原真实时刻。
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const RAW_TIMESTAMP_NAME = /(?:_at|At|_time|Time)$|^effective_(?:from|to)$|^ts$/

const generatedTimeFields = new Map(
  Prisma.dmmf.datamodel.models.map((model) => [
    model.name,
    {
      create: model.fields
        .filter((field) => field.type === 'DateTime' && ((typeof field.default === 'object' && field.default !== null && !Array.isArray(field.default) && 'name' in field.default && field.default.name === 'now') || field.isUpdatedAt))
        .map((field) => field.name),
      update: model.fields.filter((field) => field.type === 'DateTime' && field.isUpdatedAt).map((field) => field.name)
    }
  ])
)

function addGeneratedTimes(data: unknown, fields: string[]): void {
  if (Array.isArray(data)) {
    for (const item of data) addGeneratedTimes(item, fields)
    return
  }
  if (data === null || typeof data !== 'object' || Object.getPrototypeOf(data) !== Object.prototype) return
  const record = data as Record<string, unknown>
  for (const field of fields) {
    if (!(field in record)) record[field] = new Date()
  }
}

function addUpdatedTimes(data: unknown, fields: string[]): void {
  // Prisma 对空 update 不刷新 @updatedAt；保留该幂等语义。
  if (data !== null && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > 0) {
    addGeneratedTimes(data, fields)
  }
}

function prepareModelWrite(model: string, action: string, args: unknown): void {
  if (args === null || typeof args !== 'object') return
  const fields = generatedTimeFields.get(model)
  if (!fields) return
  const record = args as Record<string, unknown>
  if (action === 'create' || action === 'createMany' || action === 'createManyAndReturn') {
    addGeneratedTimes(record.data, fields.create)
  } else if (action === 'update' || action === 'updateMany' || action === 'updateManyAndReturn') {
    addUpdatedTimes(record.data, fields.update)
  } else if (action === 'upsert') {
    addGeneratedTimes(record.create, fields.create)
    addUpdatedTimes(record.update, fields.update)
  }
}

function shiftModelDates(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (value instanceof Date) {
    // Prisma 模型把 Date 的 UTC 数值原样写进 timestamp，需先换成北京时间墙上时间。
    value.setTime(value.getTime() + SHANGHAI_OFFSET_MS)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) shiftModelDates(item, seen)
    return
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return
  for (const item of Object.values(value)) shiftModelDates(item, seen)
}

function cloneModelArgs(value: unknown): unknown {
  if (value instanceof Date) return new Date(value.getTime())
  if (Array.isArray(value)) return value.map(cloneModelArgs)
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneModelArgs(item)]))
}

function restoreShanghaiInstants(
  value: unknown,
  modelResult: boolean,
  fieldName?: string,
  seen = new WeakSet<object>()
): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)

  if (value instanceof Date) {
    // 原生 SQL 也可能返回 now() 之类的 timestamptz，不能把所有 Date 都减八小时。
    if (modelResult || (fieldName && RAW_TIMESTAMP_NAME.test(fieldName))) {
      value.setTime(value.getTime() - SHANGHAI_OFFSET_MS)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) restoreShanghaiInstants(item, modelResult, fieldName, seen)
    return
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return
  for (const [key, item] of Object.entries(value)) restoreShanghaiInstants(item, modelResult, key, seen)
}

export function createShanghaiPrismaClient(): PrismaClient {
  const prisma = new PrismaClient()
  prisma.$use(async (params, next) => {
    if (params.model) {
      // 参数中的查询条件与写入值都走 Prisma 模型转换；原生 SQL 的 Date 参数不能调整。
      params.args = cloneModelArgs(params.args) as typeof params.args
      prepareModelWrite(params.model, params.action, params.args)
      shiftModelDates(params.args)
    }
    const result = await next(params)
    // 所有业务时间列使用 timestamp；返回的 Date 应代表真实时刻，供排序、提醒和 ISO 接口使用。
    restoreShanghaiInstants(result, params.model !== undefined)
    return result
  })
  return prisma
}

export async function assertShanghaiDatabaseTimezone(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ timezone: string }>>`
    SELECT current_setting('TimeZone') AS timezone
  `
  if (rows[0]?.timezone !== 'Asia/Shanghai') {
    throw new Error(`数据库连接时区必须为 Asia/Shanghai，当前为 ${rows[0]?.timezone ?? '未知'}`)
  }
}
