import crypto from 'crypto'
import type { PrismaClient } from '@prisma/client'
import { getEnv } from '../env.js'

export interface AliyunSmsConfig {
  enabled: boolean
  accessKeyId: string
  accessKeySecret: string
  signName: string
  templatePreDay: string
  templateSameDay: string
}

export interface SendSmsParams {
  phoneNumbers: string
  signName?: string
  templateCode: string
  templateParam?: Record<string, string | number>
}

export interface SendSmsResult {
  success: boolean
  code: string
  message: string
  bizId?: string
  requestId?: string
}

let cachedSmsConfig: AliyunSmsConfig | null = null

export async function getSmsConfig(prisma?: PrismaClient, forceRefresh = false): Promise<AliyunSmsConfig> {
  if (cachedSmsConfig && !forceRefresh) {
    return cachedSmsConfig
  }

  const env = getEnv()
  let dbConfig: Partial<AliyunSmsConfig> = {}

  if (prisma) {
    try {
      const rows = await prisma.$queryRawUnsafe<Array<{ value: unknown }>>(
        `SELECT value FROM sys_settings WHERE key = 'aliyun_sms_config' LIMIT 1;`
      )
      if (rows && rows.length > 0 && rows[0].value) {
        dbConfig = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : (rows[0].value as any)
      }
    } catch {
      // fallback to env
    }
  }

  const merged: AliyunSmsConfig = {
    enabled: dbConfig.enabled !== undefined ? Boolean(dbConfig.enabled) : true,
    accessKeyId: dbConfig.accessKeyId !== undefined && dbConfig.accessKeyId !== '' ? dbConfig.accessKeyId : (env.aliyunSmsAccessKeyId || ''),
    accessKeySecret: dbConfig.accessKeySecret !== undefined && dbConfig.accessKeySecret !== '' ? dbConfig.accessKeySecret : (env.aliyunSmsAccessKeySecret || ''),
    signName: dbConfig.signName || env.aliyunSmsSignName || '寰宇医道',
    templatePreDay: dbConfig.templatePreDay || env.aliyunSmsTemplatePreDay || 'SMS_512665048',
    templateSameDay: dbConfig.templateSameDay || env.aliyunSmsTemplateSameDay || 'SMS_512530051'
  }

  cachedSmsConfig = merged
  return merged
}

export async function saveSmsConfig(
  prisma: PrismaClient,
  newConfig: Partial<AliyunSmsConfig>
): Promise<AliyunSmsConfig> {
  const current = await getSmsConfig(prisma, true)
  const updated: AliyunSmsConfig = {
    enabled: newConfig.enabled !== undefined ? Boolean(newConfig.enabled) : current.enabled,
    accessKeyId: newConfig.accessKeyId !== undefined ? String(newConfig.accessKeyId).trim() : current.accessKeyId,
    accessKeySecret: newConfig.accessKeySecret !== undefined ? String(newConfig.accessKeySecret).trim() : current.accessKeySecret,
    signName: newConfig.signName !== undefined ? String(newConfig.signName).trim() : current.signName,
    templatePreDay: newConfig.templatePreDay !== undefined ? String(newConfig.templatePreDay).trim() : current.templatePreDay,
    templateSameDay: newConfig.templateSameDay !== undefined ? String(newConfig.templateSameDay).trim() : current.templateSameDay
  }

  await prisma.$executeRawUnsafe(
    `INSERT INTO sys_settings (key, value, updated_at)
     VALUES ('aliyun_sms_config', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE
     SET value = EXCLUDED.value, updated_at = NOW();`,
    JSON.stringify(updated)
  )

  cachedSmsConfig = updated
  return updated
}

function percentEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
}

/**
 * 原生安全 POP RPC 签名调用阿里云短信 SendSms 接口。
 * 纯 Node.js 标准库实现，零三方依赖，性能极高且无版本冲突。
 */
export async function sendAliyunSms(
  params: SendSmsParams,
  configOverride?: Partial<AliyunSmsConfig>
): Promise<SendSmsResult> {
  const activeConfig = cachedSmsConfig || (await getSmsConfig())
  const accessKeyId = configOverride?.accessKeyId ?? activeConfig.accessKeyId
  const accessKeySecret = configOverride?.accessKeySecret ?? activeConfig.accessKeySecret
  const signName = params.signName || configOverride?.signName || activeConfig.signName || '寰宇医道'

  if (!accessKeyId || !accessKeySecret) {
    return {
      success: false,
      code: 'ALIYUN_SMS_CONFIG_MISSING',
      message: '未配置 ALIYUN_SMS_ACCESS_KEY_ID 或 ALIYUN_SMS_ACCESS_KEY_SECRET'
    }
  }

  const cleanPhone = (params.phoneNumbers || '').trim()
  if (!/^1\d{10}$/.test(cleanPhone)) {
    return {
      success: false,
      code: 'INVALID_PHONE_NUMBER',
      message: `陪诊人员手机号无效或格式不正确: '${params.phoneNumbers}'`
    }
  }

  try {
    const queryParams: Record<string, string> = {
      AccessKeyId: accessKeyId,
      Action: 'SendSms',
      Format: 'JSON',
      PhoneNumbers: cleanPhone,
      SignName: signName,
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      SignatureVersion: '1.0',
      TemplateCode: params.templateCode,
      TemplateParam: JSON.stringify(params.templateParam ?? {}),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      Version: '2017-05-25'
    }

    const sortedKeys = Object.keys(queryParams).sort()
    const canonicalizedQueryString = sortedKeys
      .map((key) => `${percentEncode(key)}=${percentEncode(queryParams[key])}`)
      .join('&')

    const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalizedQueryString)}`
    const signature = crypto
      .createHmac('sha1', `${accessKeySecret}&`)
      .update(stringToSign)
      .digest('base64')

    const url = `https://dysmsapi.aliyuncs.com/?${canonicalizedQueryString}&Signature=${percentEncode(signature)}`

    const response = await fetch(url, { method: 'GET' })
    const data = (await response.json()) as any

    if (data && data.Code === 'OK') {
      return {
        success: true,
        code: data.Code,
        message: data.Message || 'OK',
        bizId: data.BizId,
        requestId: data.RequestId
      }
    }

    return {
      success: false,
      code: data?.Code || 'ALIYUN_API_ERROR',
      message: data?.Message || JSON.stringify(data),
      requestId: data?.RequestId
    }
  } catch (err) {
    return {
      success: false,
      code: 'NETWORK_ERROR',
      message: err instanceof Error ? err.message : String(err)
    }
  }
}
