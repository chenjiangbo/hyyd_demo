export function normalizeReminderDate(value: unknown): string | null {
  const match = /^(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})/.exec(String(value ?? '').trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function sameEscortId(first: unknown, second: unknown): boolean {
  const left = String(first ?? '').trim()
  const right = String(second ?? '').trim()
  return Boolean(left && right && left === right)
}

export function shouldAdvancePeriodicReminder(
  previousOccurrence: number | null,
  previousCycle: string | null,
  nextOccurrence: number,
  nextCycle: string
): boolean {
  if (previousOccurrence === null) return true
  if (nextCycle && previousCycle !== nextCycle) return true
  return previousOccurrence < nextOccurrence
}
