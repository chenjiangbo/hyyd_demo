import type { PrismaClient } from '@prisma/client'
import { applyChineseWorkdayCalendarYear } from '../lib/chineseWorkdays.js'

const SETTINGS_KEY = 'chinese_workday_calendar'
const API_TIMEOUT_MS = 8_000
const MAX_TIMER_DELAY_MS = 2_000_000_000
// 数据来自 Hi8 节假日 API，源数据依据国务院办公厅年度安排公告整理。
const API_BASE_URL = 'https://hi8.com/api/holiday'

type CalendarDay = { date: string; isOffDay: boolean; name?: string | null }
type SyncedYear = { published: true; days: CalendarDay[]; syncedAt: string }
type CalendarState = {
  lastCheckedYmd?: string
  years?: Record<string, SyncedYear>
}
type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string, err?: unknown) => void }

let timer: NodeJS.Timeout | null = null

function parseState(value: unknown): CalendarState {
  if (!value) return {}
  if (typeof value === 'string') {
    try { return JSON.parse(value) as CalendarState } catch { return {} }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as CalendarState : {}
}

async function readState(prisma: PrismaClient): Promise<CalendarState> {
  const rows = await prisma.$queryRawUnsafe<Array<{ value: unknown }>>(
    'SELECT value FROM sys_settings WHERE key = $1 LIMIT 1', SETTINGS_KEY
  )
  return parseState(rows[0]?.value)
}

async function saveState(prisma: PrismaClient, state: CalendarState): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO sys_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    SETTINGS_KEY,
    JSON.stringify(state)
  )
}

function shanghaiDateParts(date = new Date()): { year: number; month: number; day: number; ymd: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  const year = Number(get('year'))
  const month = Number(get('month'))
  const day = Number(get('day'))
  return { year, month, day, ymd: `${get('year')}-${get('month')}-${get('day')}` }
}

function delayUntilShanghaiMidnight(year: number, month: number, day: number): number {
  const target = new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:05:00+08:00`)
  return Math.max(1_000, target.getTime() - Date.now())
}

function nextCheckDelay(now: ReturnType<typeof shanghaiDateParts>, completed: boolean): number {
  if (completed || (now.month === 12 && now.day === 31)) {
    return delayUntilShanghaiMidnight(now.year + 1, 12, 1)
  }
  if (now.month !== 12) return delayUntilShanghaiMidnight(now.year, 12, 1)
  return delayUntilShanghaiMidnight(now.year, 12, now.day + 1)
}

function validateDays(year: number, rawDays: unknown): CalendarDay[] {
  if (!Array.isArray(rawDays) || rawDays.length === 0) throw new Error('节假日接口未返回有效日期列表')
  const seen = new Set<string>()
  const days = rawDays.map((raw: any) => {
    const parsedDate = typeof raw?.date === 'string' ? new Date(`${raw.date}T00:00:00Z`) : null
    const validDate = parsedDate !== null && !Number.isNaN(parsedDate.getTime()) &&
      parsedDate.toISOString().slice(0, 10) === raw.date
    if (!raw || typeof raw.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date) ||
      !validDate ||
      !raw.date.startsWith(`${year}-`) || typeof raw.isOffDay !== 'boolean' || seen.has(raw.date)) {
      throw new Error(`节假日接口返回了无效日期: ${JSON.stringify(raw)}`)
    }
    seen.add(raw.date)
    return { date: raw.date, isOffDay: raw.isOffDay, name: typeof raw.name === 'string' ? raw.name : null }
  })
  return days
}

async function checkCalendar(prisma: PrismaClient, logger: Logger): Promise<boolean> {
  const now = shanghaiDateParts()
  if (now.month !== 12) return false

  const year = now.year + 1
  const state = await readState(prisma)
  const savedYear = state.years?.[String(year)]
  if (savedYear?.published) return true
  if (state.lastCheckedYmd === now.ymd) return false

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    const response = await fetch(`${API_BASE_URL}/${year}.json`, {
      headers: { 'User-Agent': 'HuanyuReminder/1.0' },
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`节假日接口 HTTP ${response.status}`)

    const result = await response.json() as { year?: number; published?: boolean; days?: unknown }
    if (result.year !== year || typeof result.published !== 'boolean') {
      throw new Error('节假日接口返回格式不符合预期')
    }

    if (!result.published) {
      await saveState(prisma, { ...state, lastCheckedYmd: now.ymd })
      logger.info(`[workday-calendar] ${year} 年安排尚未发布，明日继续检查`)
      return false
    }

    const days = validateDays(year, result.days)
    const nextState: CalendarState = {
      lastCheckedYmd: now.ymd,
      years: { ...(state.years ?? {}), [String(year)]: { published: true, days, syncedAt: new Date().toISOString() } }
    }
    await saveState(prisma, nextState)
    applyChineseWorkdayCalendarYear(year, days)
    logger.info(`[workday-calendar] ${year} 年节假日和调休安排已同步（${days.length} 条），本年度检查结束`)
    return true
  } finally {
    clearTimeout(timeout)
  }
}

/** Load previously synced calendar data and check next year's official schedule each day from Dec 1 through Dec 31. */
export async function loadChineseWorkdayCalendar(prisma: PrismaClient): Promise<void> {
  const state = await readState(prisma)
  for (const [year, saved] of Object.entries(state.years ?? {})) {
    if (saved?.published && Array.isArray(saved.days)) applyChineseWorkdayCalendarYear(Number(year), saved.days)
  }
}

export async function startChineseWorkdayCalendarSync(prisma: PrismaClient, logger: Logger): Promise<void> {
  if (timer) clearTimeout(timer)

  const schedule = (delay: number) => {
    timer = setTimeout(() => { void tick() }, Math.min(delay, MAX_TIMER_DELAY_MS))
  }

  const tick = async () => {
    const now = shanghaiDateParts()
    let completed = false
    try {
      if (now.month === 12) completed = await checkCalendar(prisma, logger)
    } catch (err) {
      logger.error('[workday-calendar] 同步检查失败，将在下一次检查时重试:', err)
    }
    schedule(nextCheckDelay(now, completed))
  }

  await tick()
}

export function stopChineseWorkdayCalendarSync(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
