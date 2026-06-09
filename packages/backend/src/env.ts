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
  gatewayBaseUrl: string
  gatewayAppId: string
  gatewayApiKey: string
  dashscopeApiKey: string
  adminWebDist?: string
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
    gatewayBaseUrl: required('GATEWAY_BASE_URL'),
    gatewayAppId: required('GATEWAY_APP_ID'),
    gatewayApiKey: required('GATEWAY_API_KEY'),
    dashscopeApiKey: required('DASHSCOPE_API_KEY'),
    adminWebDist: optional('ADMIN_WEB_DIST')
  }
  return cached
}
