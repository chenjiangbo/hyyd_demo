/**
 * 订单业务映射：把泰康/平安的原始状态、池类型等，翻译成 v2 工作台的展示语义。
 * 映射规则集中在这里，方便后续按真实业务调整（这是和用户约定可随时改的地方）。
 */
import type { Order } from '../api'

export type LaneKey = 'todo' | 'doing' | 'await_backfill' | 'done'

export interface LaneDef {
  key: LaneKey
  label: string
  /** 圆点颜色 class（待确认回填用 AI 机器人图标，不用圆点） */
  dotClass?: string
  ai?: boolean
}

export const LANES: LaneDef[] = [
  { key: 'todo', label: '待处理', dotClass: 'bg-status-urgent' },
  { key: 'doing', label: '进行中', dotClass: 'bg-status-info' },
  { key: 'await_backfill', label: '待确认回填', ai: true },
  { key: 'done', label: '待结束', dotClass: 'bg-status-success' }
]

/** 泳道左色条（卡片 border-l 颜色），与泳道点同语义 */
export const LANE_ACCENT: Record<LaneKey, string> = {
  todo: 'border-l-status-urgent',
  doing: 'border-l-status-info',
  await_backfill: 'border-l-ai-purple',
  done: 'border-l-status-success'
}

/** 把订单原始状态映射到泳道 */
export function laneOf(o: Order): LaneKey {
  if (
    o.workbenchLane === 'todo' ||
    o.workbenchLane === 'doing' ||
    o.workbenchLane === 'await_backfill' ||
    o.workbenchLane === 'done'
  ) {
    return o.workbenchLane
  }

  const s = o.taikangOrderStateName || o.status || ''
  if (['已完成', '已取消', '爽约'].includes(s)) return 'done'
  if (['待录入', '取消待确认', '点名待确认', '爽约待确认', '关闭待确认', '待退款'].includes(s)) {
    return 'await_backfill'
  }
  if (['待处理', '确认申请', '更改申请', '待补充资料', '已申领'].includes(s)) return 'todo'
  return 'doing'
}

/** 服务生命周期阶段（绿通/挂号共用的抽象阶段） */
export const LIFECYCLE_STAGES = ['已申领', '需求沟通', '办理交付', '回填结算期', '待结束'] as const

/** 当前订单走到生命周期的第几阶段（索引）。由泳道粗映射，后续可按真实状态细化。 */
export function stageIndexOf(o: Order): number {
  switch (laneOf(o)) {
    case 'todo':
      return 1 // 已申领，待需求沟通
    case 'doing':
      return 2 // 办理交付中
    case 'await_backfill':
      return 3 // 回填结算期
    case 'done':
      return 4 // 待结束
    default:
      return 1
  }
}

/** 业务类型展示标签：挂号池 → 挂号协助；绿通池 → 具体服务名 */
export function bizType(o: Order): string {
  if (o.rawJson?.poolType === 'register') return '挂号协助'
  return o.rawJson?.serviceType || o.rawJson?.itemName || '绿通业务'
}

/**
 * 业务类型调色板：不同业务给不同颜色，便于一眼区分。
 * 用 Tailwind 任意色值（字面量出现在源码里，JIT 才会生成），不依赖主题 token。
 */
export interface BizPalette {
  text: string
  bg: string
  accent: string // 卡片左侧色条 border-l 颜色
}

const BIZ_PALETTES: Record<string, BizPalette> = {
  blue: { text: 'text-[#1e40af]', bg: 'bg-[#dbeafe]', accent: 'border-l-[#3b82f6]' },
  amber: { text: 'text-[#b45309]', bg: 'bg-[#fef3c7]', accent: 'border-l-[#f59e0b]' },
  teal: { text: 'text-[#0f766e]', bg: 'bg-[#ccfbf1]', accent: 'border-l-[#14b8a6]' },
  indigo: { text: 'text-[#4338ca]', bg: 'bg-[#e0e7ff]', accent: 'border-l-[#6366f1]' },
  cyan: { text: 'text-[#155e75]', bg: 'bg-[#cffafe]', accent: 'border-l-[#06b6d4]' },
  purple: { text: 'text-[#6d28d9]', bg: 'bg-[#ede9fe]', accent: 'border-l-[#8b5cf6]' },
  rose: { text: 'text-[#be123c]', bg: 'bg-[#ffe4e6]', accent: 'border-l-[#f43f5e]' },
  slate: { text: 'text-[#475569]', bg: 'bg-[#f1f5f9]', accent: 'border-l-[#94a3b8]' }
}

function bizCategory(o: Order): keyof typeof BIZ_PALETTES {
  if (o.rawJson?.poolType === 'register') return 'blue'
  const t = o.rawJson?.serviceType || o.rawJson?.itemName || ''
  if (t.includes('加急') || t.includes('检查')) return 'amber'
  if (t.includes('住院') || t.includes('护工')) return 'teal'
  if (t.includes('接送')) return 'cyan'
  if (t.includes('会诊') || t.includes('第二') || t.includes('专家') || t.includes('MDT')) return 'purple'
  if (t.includes('门诊') || t.includes('问诊') || t.includes('就诊')) return 'indigo'
  return 'slate'
}

export function bizPalette(o: Order): BizPalette {
  return BIZ_PALETTES[bizCategory(o)]
}

/** 业务类型 chip 配色（text + bg） */
export function bizChipClass(o: Order): string {
  const p = bizPalette(o)
  return `${p.text} ${p.bg}`
}

const SOURCE_LABELS: Record<string, string> = {
  taikang: '泰康',
  pingan: '平安',
  picc: '人保',
  taiping: '太平洋',
  guoshou: '人寿',
  xinhua: '新华'
}

export function sourceLabel(o: Order): string {
  return SOURCE_LABELS[o.source] || o.source || '未知来源'
}

/** 按来源码取标签（给筛选/建单用，不依赖 Order 对象） */
export function sourceLabelByCode(code: string): string {
  return SOURCE_LABELS[code] || code
}

/** 手工建单可选来源（保司） */
export const SOURCE_OPTIONS: { code: string; label: string }[] = [
  { code: 'taikang', label: '泰康' },
  { code: 'pingan', label: '平安' },
  { code: 'picc', label: '人保' },
  { code: 'taiping', label: '太平洋' },
  { code: 'guoshou', label: '人寿' },
  { code: 'xinhua', label: '新华' }
]

/** 来源（甲方保险公司）配色：不同来源不同色 */
export interface SourceStyle {
  label: string
  text: string
  bg: string
}

const SOURCE_STYLES: Record<string, SourceStyle> = {
  taikang: { label: '泰康', text: 'text-[#047857]', bg: 'bg-[#d1fae5]' },
  pingan: { label: '平安', text: 'text-[#c2410c]', bg: 'bg-[#ffedd5]' },
  picc: { label: '人保', text: 'text-[#0e7490]', bg: 'bg-[#cffafe]' },
  taiping: { label: '太平洋', text: 'text-[#1d4ed8]', bg: 'bg-[#dbeafe]' },
  guoshou: { label: '人寿', text: 'text-[#b91c1c]', bg: 'bg-[#fee2e2]' },
  xinhua: { label: '新华', text: 'text-[#6d28d9]', bg: 'bg-[#ede9fe]' }
}

export function sourceStyle(o: Order): SourceStyle {
  return SOURCE_STYLES[o.source] || { label: sourceLabel(o), text: 'text-[#475569]', bg: 'bg-[#f1f5f9]' }
}

/** 姓名取首字（中文取姓，英文取首字母），用于头像/角标 */
export function initials(name: string): string {
  if (!name) return '?'
  const t = name.trim()
  return /[A-Za-z]/.test(t[0]) ? t.slice(0, 2).toUpperCase() : t[0]
}

/** 日期：M月D日 */
export function monthDay(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 相对时间：刚刚 / X分钟前 / X小时前 / X天前 / 日期 */
export function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const diff = Date.now() - t
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min}分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}
