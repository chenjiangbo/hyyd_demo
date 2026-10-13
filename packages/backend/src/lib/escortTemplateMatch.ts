/**
 * 陪诊派单模板解析与识别模块
 * 
 * 规则要求：
 * 1. 只提取正文中的「渠道订单号」；
 * 2. 将它精确匹配 orders.source_order_no；
 * 3. 不使用「订单号」（HYYD...）进行关联，避免把寰宇单号误当渠道单号；
 * 4. 仅用于将该条派单消息精准关联到目标订单，绝不污染整个会话的其他消息。
 */

export interface EscortDispatchMatchResult {
  matched: boolean
  channelOrderNo?: string
}

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
 * 只在正文含有非空「渠道订单号」时返回候选。关联方必须再以该值精确匹配 source_order_no。
 */
export function parseEscortDispatchTemplate(text: string | null | undefined): EscortDispatchMatchResult {
  if (!text || typeof text !== 'string') {
    return { matched: false }
  }

  const fields = parseKeyValueLines(text)

  // 只认渠道订单号；「订单号」通常为 HYYD...，不能拿来匹配 source_order_no。
  let channelOrderNo = fields['渠道订单号'] || fields['渠道订单编号'] || ''
  if (!channelOrderNo) {
    const m = text.match(/(?:渠道订单号|渠道订单编号)\s*[:：]\s*([a-zA-Z0-9]+)/i)
    if (m && m[1]) {
      channelOrderNo = m[1].trim()
    }
  }
  if (!channelOrderNo.trim()) return { matched: false }

  return {
    matched: true,
    channelOrderNo: channelOrderNo.trim()
  }
}
