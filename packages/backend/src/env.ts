export interface AppEnv {
  nodeEnv: string
  databaseUrl: string
  host: string
  port: number
  adminPassword: string
  adminJwtSecret: string
  minioHost: string
  minioPort: number
  minioPublicHost: string
  minioPublicPort: number
  minioAccessKey: string
  minioSecretKey: string
  minioBucketRecordings: string
  minioBucketScreenshots: string
  // 网关与百炼能力按需使用；本地只开发订单/字典时可以不配置。
  gatewayBaseUrl?: string
  gatewayAppId?: string
  gatewayApiKey?: string
  dashscopeApiKey?: string
  adminWebDist?: string
  remoteDictDbHost?: string
  remoteDictDbPort?: string
  remoteDictDbName?: string
  remoteDictDbUser?: string
  remoteDictDbPassword?: string
  remoteDictDbSsl?: string
  // 人工确认后推送寰宇订单的 MySQL 写库。未单独配置时兼容复用 REMOTE_DICT_DB_*；
  // 生产建议使用独立、最小写权限账号。
  huanyuPushDbHost?: string
  huanyuPushDbPort?: string
  huanyuPushDbName?: string
  huanyuPushDbUser?: string
  huanyuPushDbPassword?: string
  huanyuPushDbSsl?: string
  // ABI 挂号退款：服务启动时必须完整配置，密钥仅保存在后端环境变量中。
  abiRefundAuthUrl: string
  abiRefundUrl: string
  abiRefundAppId: string
  abiRefundAppSecret: string
  // 每日订单 AI 分析时点，上海时区，逗号分隔；例如 12:00,18:00。
  orderAiAnalysisTimes?: string
  // 阿里云短信配置
  aliyunSmsAccessKeyId?: string
  aliyunSmsAccessKeySecret?: string
  aliyunSmsSignName?: string
  aliyunSmsTemplatePreDay?: string
  aliyunSmsTemplateSameDay?: string
}

let cached: AppEnv | null = null

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少必需环境变量 ${name}`)
  return value
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value || undefined
}

function requiredPort(name: string): number {
  const raw = required(name)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`环境变量 ${name} 必须是 1-65535 之间的端口号，当前值: ${raw}`)
  }
  return value
}

export function getEnv(): AppEnv {
  if (cached) return cached
  cached = {
    nodeEnv: process.env.NODE_ENV?.trim() || 'development',
    databaseUrl: required('DATABASE_URL'),
    host: required('HOST'),
    port: requiredPort('PORT'),
    adminPassword: required('ADMIN_PASSWORD'),
    adminJwtSecret: required('ADMIN_JWT_SECRET'),
    minioHost: required('MINIO_HOST'),
    minioPort: requiredPort('MINIO_PORT'),
    minioPublicHost: required('MINIO_PUBLIC_HOST'),
    minioPublicPort: requiredPort('MINIO_PUBLIC_PORT'),
    minioAccessKey: required('MINIO_ACCESS_KEY'),
    minioSecretKey: required('MINIO_SECRET_KEY'),
    minioBucketRecordings: required('MINIO_BUCKET_RECORDINGS'),
    minioBucketScreenshots: required('MINIO_BUCKET_SCREENSHOTS'),
    gatewayBaseUrl: optional('GATEWAY_BASE_URL'),
    gatewayAppId: optional('GATEWAY_APP_ID'),
    gatewayApiKey: optional('GATEWAY_API_KEY'),
    dashscopeApiKey: optional('DASHSCOPE_API_KEY'),
    adminWebDist: optional('ADMIN_WEB_DIST'),
    // 远端字典库只在下拉读取接口被调用时才校验，避免未配置的环境无法启动常规服务。
    remoteDictDbHost: optional('REMOTE_DICT_DB_HOST'),
    remoteDictDbPort: optional('REMOTE_DICT_DB_PORT'),
    remoteDictDbName: optional('REMOTE_DICT_DB_NAME'),
    remoteDictDbUser: optional('REMOTE_DICT_DB_USER'),
    remoteDictDbPassword: optional('REMOTE_DICT_DB_PASSWORD'),
    remoteDictDbSsl: optional('REMOTE_DICT_DB_SSL'),
    huanyuPushDbHost: optional('HUANYU_PUSH_DB_HOST'),
    huanyuPushDbPort: optional('HUANYU_PUSH_DB_PORT'),
    huanyuPushDbName: optional('HUANYU_PUSH_DB_NAME'),
    huanyuPushDbUser: optional('HUANYU_PUSH_DB_USER'),
    huanyuPushDbPassword: optional('HUANYU_PUSH_DB_PASSWORD'),
    huanyuPushDbSsl: optional('HUANYU_PUSH_DB_SSL'),
    abiRefundAuthUrl: required('ABI_REFUND_AUTH_URL'),
    abiRefundUrl: required('ABI_REFUND_URL'),
    abiRefundAppId: required('ABI_REFUND_APP_ID'),
    abiRefundAppSecret: required('ABI_REFUND_APP_SECRET'),
    orderAiAnalysisTimes: optional('ORDER_AI_ANALYSIS_TIMES'),
    aliyunSmsAccessKeyId: optional('ALIYUN_SMS_ACCESS_KEY_ID'),
    aliyunSmsAccessKeySecret: optional('ALIYUN_SMS_ACCESS_KEY_SECRET'),
    aliyunSmsSignName: optional('ALIYUN_SMS_SIGN_NAME') || '寰宇医道',
    aliyunSmsTemplatePreDay: optional('ALIYUN_SMS_TEMPLATE_PRE_DAY') || 'SMS_512665048',
    aliyunSmsTemplateSameDay: optional('ALIYUN_SMS_TEMPLATE_SAME_DAY') || 'SMS_512530051'
  }
  return cached
}
