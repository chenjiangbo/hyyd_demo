/**
 * 中国法定节假日与工作日计算工具。
 * 用于住院陪护结束前 2 天提醒等排除周末及法定调休节假日的倒推计算。
 */

// 2025 ~ 2027 年法定节假日（放假不上班的公历日期 YYYY-MM-DD）
const OFFICIAL_HOLIDAYS = new Set<string>([
  // 2025
  '2025-01-01', // 元旦
  '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04', // 春节
  '2025-04-04', '2025-04-05', '2025-04-06', // 清明节
  '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05', // 劳动节
  '2025-05-31', '2025-06-01', '2025-06-02', // 端午节
  '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08', // 中秋国庆

  // 2026
  '2026-01-01', '2026-01-02', '2026-01-03', // 元旦
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23', // 春节
  '2026-04-04', '2026-04-05', '2026-04-06', // 清明节
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', // 劳动节
  '2026-06-19', '2026-06-20', '2026-06-21', // 端午节
  '2026-09-25', '2026-09-26', '2026-09-27', // 中秋节
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', // 国庆节

  // 2027
  '2027-01-01', '2027-01-02', '2027-01-03', // 元旦
  '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', // 春节
  '2027-04-04', '2027-04-05', '2027-04-06', // 清明节
  '2027-05-01', '2027-05-02', '2027-05-03', // 劳动节
  '2027-06-09', '2027-06-10', '2027-06-11', // 端午节
  '2027-09-15', '2027-09-16', '2027-09-17', // 中秋节
  '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04', '2027-10-05', '2027-10-06', '2027-10-07' // 国庆节
])

// 法定调休上班日（周末补班的日期 YYYY-MM-DD）
const WORKDAY_MAKEUPS = new Set<string>([
  // 2025
  '2025-01-26', '2025-02-08', '2025-04-27', '2025-09-28', '2025-10-11',
  // 2026
  '2026-02-15', '2026-02-28', '2026-04-26', '2026-05-09', '2026-09-20', '2026-10-10',
  // 2027
  '2027-01-31', '2027-02-20', '2027-04-25', '2027-05-08', '2027-09-26', '2027-10-09'
])

export function formatYmd(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function parseYmdToShanghaiDate(ymd: string): Date {
  const match = /^(\d{4})[-/]?(\d{1,2})[-/]?(\d{1,2})/.exec(ymd.trim())
  if (!match) return new Date()
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  return new Date(Date.UTC(year, month - 1, day, 1, 0, 0)) // UTC 01:00 is Shanghai 09:00
}

/**
 * 判断某一天是否为有效工作日（排除周末和法定假期，包含周末调休上班日）
 */
export function isWorkday(date: Date): boolean {
  const ymd = formatYmd(date)
  if (WORKDAY_MAKEUPS.has(ymd)) return true
  if (OFFICIAL_HOLIDAYS.has(ymd)) return false

  const dayOfWeek = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short'
  }).format(date)

  if (dayOfWeek === 'Sat' || dayOfWeek === 'Sun') {
    return false
  }

  return true
}

/**
 * 从指定基准日期向前倒推 N 个工作日（排除周六日与法定节假日）。
 */
export function subtractWorkdays(baseDate: Date, workdaysToSubtract = 2): { date: Date; ymd: string } {
  const current = new Date(baseDate.getTime())
  let remaining = workdaysToSubtract

  while (remaining > 0) {
    current.setTime(current.getTime() - 24 * 60 * 60 * 1000)
    if (isWorkday(current)) {
      remaining -= 1
    }
  }

  return {
    date: current,
    ymd: formatYmd(current)
  }
}
