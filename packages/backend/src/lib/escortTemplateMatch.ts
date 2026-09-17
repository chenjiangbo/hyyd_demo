/**
 * 陪诊派单模板解析与识别模块
 * 
 * 规则要求：
 * 1. 匹配约定的标准陪诊派单模板；
 * 2. 提取「订单号」(匹配 orders.source_order_no)；
 * 3. 严格卡控：「陪诊人」与「陪诊人电话」必须同时存在且不为空（已落实派单）；
 * 4. 仅用于将该条派单消息精准关联到目标订单，绝不污染整个会话的其他消息。
 */

export interface EscortDispatchMatchResult {
  matched: boolean
  sourceOrderNo?: string
  escortName?: string
  escortPhone?: string
  serviceItem?: string
  patientName?: string
  hospital?: string
  appointmentDate?: string
  rawFields?: Record<string, string>
}

// 无效的占位符文案（若陪诊人为这些，视为未落实）
const PLACEHOLDER_VALUES = new Set(['', '无', '暂无', '待定', '待分配', '未分配', '空', 'null', 'undefined', '-'])

/**
 * 从文本中解析键值对（支持中英文冒号）
 */
function parseKeyValueLines(text: string): Record<string, string> {
  const map: Record<string, string> = {}
  const lines = text.split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    const colonIdx = line.indexOf('：') > -1 ? line.indexOf('：') : line.indexOf(':')
    if (colonIdx > -1) {
      const key = line.slice(0, colonIdx).trim()
      const val = line.slice(colonIdx + 1).trim()
      if (key) {
        map[key] = val
      }
    }
  }
  return map
}

/**
 * 检查并解析文本是否为符合要求的陪诊派单消息
 */
export function parseEscortDispatchTemplate(text: string | null | undefined): EscortDispatchMatchResult {
  if (!text || typeof text !== 'string') {
    return { matched: false }
  }

  const fields = parseKeyValueLines(text)

  // 1. 提取订单号 (如 订单号: COD3cf4a3152b1be349)
  let orderNo = fields['订单号'] || fields['订单编号'] || fields['工单号'] || fields['申请号'] || ''
  if (!orderNo) {
    // 兼容正则回退提取
    const m = text.match(/(?:订单号|订单编号|工单号)\s*[:：]\s*([a-zA-Z0-9]+)/i)
    if (m && m[1]) {
      orderNo = m[1].trim()
    }
  }

  if (!orderNo) {
    return { matched: false }
  }

  // 2. 提取陪诊人 (如 陪诊人: 张文娟)
  const escortName = fields['陪诊人'] || fields['陪诊人员'] || fields['陪诊老师'] || fields['就医顾问'] || ''
  const trimmedName = escortName.trim()
  if (!trimmedName || PLACEHOLDER_VALUES.has(trimmedName.toLowerCase())) {
    return { matched: false }
  }

  // 3. 提取陪诊人电话 (如 陪诊人电话: 13683106089)
  const escortPhone =
    fields['陪诊人电话'] ||
    fields['陪诊人员电话'] ||
    fields['陪诊老师电话'] ||
    fields['陪诊人手机'] ||
    fields['陪诊员电话'] ||
    fields['陪诊电话'] ||
    ''
  const cleanPhoneDigits = escortPhone.replace(/\D/g, '')
  // 电话号码通常为 7~15 位数字
  if (!cleanPhoneDigits || cleanPhoneDigits.length < 7 || PLACEHOLDER_VALUES.has(escortPhone.trim().toLowerCase())) {
    return { matched: false }
  }

  return {
    matched: true,
    sourceOrderNo: orderNo.trim(),
    escortName: trimmedName,
    escortPhone: escortPhone.trim(),
    serviceItem: fields['服务项目'] || '',
    patientName: fields['就诊人'] || fields['患者'] || '',
    hospital: fields['医院'] || '',
    appointmentDate: fields['就诊日期'] || fields['预约时间'] || '',
    rawFields: fields
  }
}
