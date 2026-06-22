/**
 * 解析微信/企微聊天里的"时间分隔条"文本 → 绝对时刻（中国时区 UTC+8）。
 *
 * 聊天记录里时间锚点出现在一批消息的上方，本函数把锚点文字 + 截图时刻(ref) 还原成绝对时间，
 * 用来给消息排真实顺序（往上翻看的历史消息靠它定位，而不是用"我们截到它的时刻"）。
 * 解析不出返回 null（调用方对该消息用 capturedAt 兜底排序）。
 *
 * 支持格式（已与现场确认，无"几分钟前"这类）：
 *   HH:mm / h:mm
 *   上午|下午|晚上|凌晨|中午 h:mm
 *   今天|昨天|前天 HH:mm
 *   星期X|周X HH:mm   （X = 一二三四五六/日/天）
 *   M月D日 [HH:mm]
 *   YYYY年M月D日 [HH:mm]
 *
 * 中国不实行夏令时，按固定 +8 偏移换算即可。
 */

const TZ_OFFSET_MS = 8 * 3600 * 1000

// 把某 UTC 瞬间换算成"北京时间的年月日星期"（先平移 +8 再读 UTC 字段的常用技巧）
function beijingParts(ref: Date): { y: number; mo: number; d: number; wd: number } {
  const b = new Date(ref.getTime() + TZ_OFFSET_MS)
  return { y: b.getUTCFullYear(), mo: b.getUTCMonth() + 1, d: b.getUTCDate(), wd: b.getUTCDay() }
}

// 给定"北京时间的年月日时分" → 对应的 UTC 瞬间
function beijingToUtc(y: number, mo: number, d: number, h: number, min: number): Date {
  return new Date(Date.UTC(y, mo - 1, d, h, min) - TZ_OFFSET_MS)
}

const WEEKDAY: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }

export function parseChatTime(textRaw: string, ref: Date): Date | null {
  const text = (textRaw ?? '').replace(/\s+/g, '')
  if (!text) return null

  // 时间部分 HH:mm（可能没有；纯日期时默认 00:00）
  const tm = text.match(/(\d{1,2}):(\d{2})/)
  let hh = tm ? parseInt(tm[1], 10) : 0
  const mm = tm ? parseInt(tm[2], 10) : 0
  if (/下午|晚上/.test(text) && hh < 12) hh += 12
  else if (/中午/.test(text) && hh < 12) hh = 12
  else if (/上午|凌晨/.test(text) && hh === 12) hh = 0
  if (hh > 23 || mm > 59) return null

  const r = beijingParts(ref)

  // YYYY年M月D日
  let m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
  if (m) return beijingToUtc(+m[1], +m[2], +m[3], hh, mm)

  // M月D日（无年 → 取不晚于截图日的最近一年）
  m = text.match(/(\d{1,2})月(\d{1,2})日/)
  if (m) {
    const mo = +m[1]
    const d = +m[2]
    let y = r.y
    const cand = beijingToUtc(y, mo, d, hh, mm)
    if (cand.getTime() > ref.getTime() + 86400e3) y -= 1 // 比截图日还晚 → 是去年的
    return beijingToUtc(y, mo, d, hh, mm)
  }

  // 相对日：以截图当天(北京)为基准往回数 n 天
  const dayShift = (n: number): Date => {
    const baseMidnight = new Date(Date.UTC(r.y, r.mo - 1, r.d) - TZ_OFFSET_MS) // 截图当天 0 点(北京)
    const target = beijingParts(new Date(baseMidnight.getTime() - n * 86400e3))
    return beijingToUtc(target.y, target.mo, target.d, hh, mm)
  }
  if (/今天/.test(text)) return dayShift(0)
  if (/昨天/.test(text)) return dayShift(1)
  if (/前天/.test(text)) return dayShift(2)

  // 星期X / 周X：取最近的"过去"那天；同名当天按一周前算（当天会显示时间而非星期）
  const wm = text.match(/(?:星期|周)([一二三四五六日天])/)
  if (wm) {
    const w = WEEKDAY[wm[1]]
    let back = (r.wd - w + 7) % 7
    if (back === 0) back = 7
    return dayShift(back)
  }

  // 只剩纯时间 HH:mm → 当天
  if (tm) return dayShift(0)

  return null
}
