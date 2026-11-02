// Limit repetitive idle-read diagnostics without changing collector events or message handling.
export class NativeChatReadLogThrottle {
  private readonly entries = new Map<string, { at: number; suppressed: number }>()

  constructor(private readonly intervalMs = 5 * 60_000) {}

  take(key: string, now = Date.now()): number | null {
    const previous = this.entries.get(key)
    if (previous && now - previous.at < this.intervalMs) {
      previous.suppressed++
      return null
    }
    this.entries.set(key, { at: now, suppressed: 0 })
    return previous?.suppressed ?? 0
  }
}
