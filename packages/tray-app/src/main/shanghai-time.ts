const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  fractionalSecondDigits: 3, hourCycle: 'h23'
})

export function parseShanghaiTimestamp(value: string | Date): Date {
  if (value instanceof Date) return new Date(value.getTime())
  const text = value.trim().replaceAll('/', '-').replace(' ', 'T')
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date(`${text}T00:00:00+08:00`)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)) {
    return new Date(`${text}+08:00`)
  }
  return new Date(text)
}

export function formatShanghaiTimestamp(value: Date): string {
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(value)) parts[part.type] = part.value
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}`
}

export function normalizeShanghaiTimestamp(value: string | Date): string {
  const parsed = parseShanghaiTimestamp(value)
  return Number.isNaN(parsed.getTime()) ? String(value) : formatShanghaiTimestamp(parsed)
}
