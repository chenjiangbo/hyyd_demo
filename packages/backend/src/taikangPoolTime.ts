/** Parse Taikang's pool-entry time as a real instant. Unzoned Taikang values are China Standard Time. */
export function parseTaikangPoolEnteredAt(input: Record<string, unknown>): Date | null {
  const records = [input.taikangRawJson, input.rawJson, input]
    .filter((value): value is Record<string, unknown> =>
      Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    )

  for (const record of records) {
    for (const field of ['applyDate', 'poolEnteredAt', 'inPoolTime', 'enterPoolTime']) {
      const value = record[field]
      if (typeof value !== 'string' || !value.trim()) continue

      const normalized = value.trim().replace(/\//g, '-').replace(' ', 'T')
      const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)
      const localDateTime = /^\d{4}-\d{1,2}-\d{1,2}$/.test(normalized)
        ? `${normalized}T00:00:00`
        : normalized
      const parsed = new Date(hasTimezone ? localDateTime : `${localDateTime}+08:00`)
      if (Number.isFinite(parsed.getTime())) return parsed
    }
  }

  return null
}
