const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
})

export function shanghaiDateParts(date: Date): Record<string, string> {
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(date)) parts[part.type] = part.value
  return parts
}

export function shanghaiDateTime(date: Date): string {
  const p = shanghaiDateParts(date)
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}

export function shanghaiDate(date: Date): string {
  const p = shanghaiDateParts(date)
  return `${p.year}-${p.month}-${p.day}`
}

/** datetime-local 输入没有时区标记，项目约定按北京时间解释。 */
export function parseShanghaiDateTimeLocal(value: string): Date {
  const normalized = value.trim().replaceAll('/', '-').replace(' ', 'T')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(normalized)) return new Date(NaN)
  const withSeconds = normalized.length === 16 ? `${normalized}:00` : normalized
  return new Date(`${withSeconds}+08:00`)
}

/** Parse either an ISO instant or a timezone-free timestamp interpreted as Beijing time. */
export function parseShanghaiTimestamp(value: string): Date {
  const text = value.trim()
  if (/(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(text)) return new Date(text)
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return parseShanghaiDateTimeLocal(`${text}T00:00`)
  return parseShanghaiDateTimeLocal(text)
}

export function shanghaiDateTimeLocal(date: Date): string {
  const p = shanghaiDateParts(date)
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}
