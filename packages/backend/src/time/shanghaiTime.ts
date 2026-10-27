const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
})

export function parseShanghaiDateTime(value: string | Date): Date {
  if (value instanceof Date) return new Date(value.getTime())
  const text = value.trim()
  const normalized = text.replaceAll('/', '-').replace(' ', 'T')
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return new Date(`${normalized}T00:00:00+08:00`)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(normalized)) {
    return new Date(`${normalized}+08:00`)
  }
  return new Date(normalized)
}

export function shanghaiDateKey(value: Date): string {
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(value)) parts[part.type] = part.value
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function formatShanghaiDateTime(value: Date): string {
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(value)) parts[part.type] = part.value
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

export function startOfShanghaiDay(value = new Date()): Date {
  return parseShanghaiDateTime(`${shanghaiDateKey(value)} 00:00:00`)
}
