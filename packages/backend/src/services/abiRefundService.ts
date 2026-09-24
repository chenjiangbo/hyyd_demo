import { getEnv } from '../env.js'

interface AbiTokenResponse {
  status?: unknown
  message?: unknown
  data?: {
    access_token?: unknown
    access_sign?: unknown
  } | null
}

interface AbiRefundResponse {
  success?: unknown
  msg?: unknown
  data?: unknown
}

export interface AbiRefundInput {
  orderNo: string
  aliTradeNo: string
  refundAmount: number
}

export interface AbiRefundResult {
  message: string
  data: unknown
}

const ABI_REQUEST_TIMEOUT_MS = 15_000

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

async function readJson(response: Response, requestName: string): Promise<unknown> {
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`${requestName}失败（HTTP ${response.status}）`)
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new Error(`${requestName}返回了非 JSON 数据`)
  }
}

function endpointUrl(value: string, name: string): URL {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
    return url
  } catch {
    throw new Error(`${name}必须是有效的 http/https 地址`)
  }
}

async function obtainAbiAccessCredentials(): Promise<{ accessToken: string; accessSign: string }> {
  const env = getEnv()
  const authUrl = endpointUrl(env.abiRefundAuthUrl, 'ABI_REFUND_AUTH_URL')
  authUrl.searchParams.set('appid', env.abiRefundAppId)
  authUrl.searchParams.set('appsecret', env.abiRefundAppSecret)

  let response: Response
  try {
    response = await fetch(authUrl, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(ABI_REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    const suffix = error instanceof Error && error.name === 'TimeoutError' ? '超时' : '网络异常'
    throw new Error(`ABI 鉴权请求${suffix}`)
  }

  const payload = await readJson(response, 'ABI 鉴权请求') as AbiTokenResponse
  if (payload.status !== 200) {
    throw new Error(textValue(payload.message) || 'ABI 鉴权未成功')
  }
  const accessToken = textValue(payload.data?.access_token)
  const accessSign = textValue(payload.data?.access_sign)
  if (!accessToken || !accessSign) {
    throw new Error('ABI 鉴权响应缺少 access_token 或 access_sign')
  }
  return { accessToken, accessSign }
}

/**
 * ABI 支付宝退款。appsecret 只用于服务端取临时 token，绝不返回到客户端或写入日志。
 */
export async function requestAbiRefund(input: AbiRefundInput): Promise<AbiRefundResult> {
  const orderNo = input.orderNo.trim()
  const aliTradeNo = input.aliTradeNo.trim()
  if (!orderNo || !aliTradeNo || !Number.isFinite(input.refundAmount) || input.refundAmount <= 0) {
    throw new Error('ABI 退款请求参数不完整')
  }

  const { accessToken, accessSign } = await obtainAbiAccessCredentials()
  const env = getEnv()
  const refundUrl = endpointUrl(env.abiRefundUrl, 'ABI_REFUND_URL')
  let response: Response
  try {
    response = await fetch(refundUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        access_token: accessToken,
        access_sign: accessSign
      },
      body: JSON.stringify({ orderNo, aliTradeNo, refundAmount: input.refundAmount }),
      signal: AbortSignal.timeout(ABI_REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    const suffix = error instanceof Error && error.name === 'TimeoutError' ? '超时' : '网络异常'
    throw new Error(`ABI 退款请求${suffix}`)
  }

  const payload = await readJson(response, 'ABI 退款请求') as AbiRefundResponse
  if (payload.success !== true) {
    throw new Error(textValue(payload.msg) || 'ABI 退款失败')
  }
  return { message: textValue(payload.msg) || '退款成功', data: payload.data ?? null }
}
