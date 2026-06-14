/**
 * 消息结构化（路线1 的"解释层"）——后端版。
 *
 * 把一帧聊天截图的 OCR 词块结构化成"带说话人"的消息列表。说话人判定不靠 AI 猜，
 * 靠确定性规则：
 *   - 气泡背景"有色(高饱和=绿/蓝)" → self；"灰/白(低饱和)" → other（深浅色模式都成立）
 *   - 辅以左右位置（右=self、左=other）做兜底
 *   - 居中 + 时间/日期/撤回 文案 → system
 *
 * 与早期 C# `MessageStructurer.cs` 的差别：本模块**没有像素**。判颜色所需的"气泡填充色"
 * 由 sidecar 在本机按词块采样好(`colorSample`)随 OCR 块一起上传；这里只做拼行/分组/判定。
 * 这样结构化算法集中在后端、可热更新、好测试，且不必上传图片。
 *
 * 纯函数、无状态、不持久化：每帧自带输入、输出仅依赖本帧。多员工并发调用天然隔离，不会串。
 */

export interface StructRect {
  x: number
  y: number
  width: number
  height: number
}

export interface StructColor {
  r: number
  g: number
  b: number
}

export interface StructBlock {
  text: string
  bbox: StructRect
  /** sidecar 在本机采样的气泡填充色（跳过文字笔画后的底色）。无则按位置兜底判说话人。 */
  colorSample?: StructColor | null
}

export interface StructInput {
  channel: 'wechat' | 'wxwork' | string
  width: number
  height: number
  blocks: StructBlock[]
}

export type Speaker = 'self' | 'other' | 'system'

export interface StructMessage {
  speaker: Speaker
  name: string | null
  text: string
}

function envNum(key: string, dflt: number): number {
  const v = process.env[key]
  const n = v != null ? Number(v) : NaN
  return Number.isFinite(n) ? n : dflt
}

// 气泡"有色"判定的饱和度阈值（≥ 视为 self）
const satThreshold = (): number => envNum('HYYD_BUBBLE_SAT', 0.15)

const TIME_LINE =
  /^\s*(\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*月\s*\d{1,2}\s*日|昨天|星期[一二三四五六日天]|上午|下午|\d{2}\/\d{1,2}\/\d{1,2})/
const SYSTEM_KEYWORD = /撤回|以下为新消息|拍了拍|加入了群聊|邀请|领取了你的|红包/

interface Line {
  words: StructBlock[]
  minX: number
  minY: number
  maxX: number
  maxY: number
}
const centerY = (l: Line): number => (l.minY + l.maxY) / 2
const lineHeight = (l: Line): number => l.maxY - l.minY
const lineText = (l: Line): string =>
  [...l.words].sort((a, b) => a.bbox.x - b.bbox.x).map((w) => w.text).join('')

/**
 * 列检测：把所有词块 X 投影成覆盖直方图，栏与栏之间是宽空白竖条；按空白条切列，
 * 取最宽的密集列 = 聊天区。纯动态：每张图用自己的 OCR 坐标算，不写死比例/坐标，
 * 不受窗口大小、成员面板开合影响。天然排除 图标栏/会话列表/右侧成员面板/工具栏。
 */
function detectChatXRange(blocks: StructBlock[], w: number): [number, number] {
  const gapMin = Math.trunc(envNum('HYYD_CHAT_COL_GAP', 18)) // 视作栏间隙的最小空白宽
  const minBlocks = Math.trunc(envNum('HYYD_CHAT_COL_MINBLOCKS', 5))
  const cover = new Array<number>(w).fill(0)
  for (const b of blocks) {
    const xs = Math.max(0, b.bbox.x)
    const xe = Math.min(w, b.bbox.x + b.bbox.width)
    for (let x = xs; x < xe; x++) cover[x]++
  }
  // 扫描切列：一列持续到遇见 >=gapMin 的连续空白；小于 gapMin 的空白算列内
  const cols: Array<[number, number]> = []
  let i = 0
  while (i < w) {
    while (i < w && cover[i] === 0) i++
    if (i >= w) break
    const s = i
    let lastNonZero = i
    while (i < w) {
      if (cover[i] > 0) {
        lastNonZero = i
        i++
      } else {
        let z = i
        while (z < w && cover[z] === 0) z++
        if (z - i >= gapMin) break // 栏间隙，列结束
        i = z // 列内小空白，继续
      }
    }
    cols.push([s, lastNonZero + 1])
  }
  // 取 块数>=minBlocks 的列里最宽的
  let best: [number, number] = [0, w]
  let bestWidth = -1
  for (const [s, e] of cols) {
    const n = blocks.filter((b) => {
      const cx = b.bbox.x + b.bbox.width / 2
      return cx >= s && cx < e
    }).length
    if (n >= minBlocks && e - s > bestWidth) {
      bestWidth = e - s
      best = [s, e]
    }
  }
  return best
}

// 词块 → 行：按 Y 顺序，垂直中心重叠算同一行（列检测已隔离聊天列，不再按 X 间隔断行）
function groupLines(blocks: StructBlock[]): Line[] {
  const sorted = [...blocks].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)
  const lines: Line[] = []
  for (const b of sorted) {
    const cy = b.bbox.y + b.bbox.height / 2
    const last = lines.length > 0 ? lines[lines.length - 1] : null
    if (last && Math.abs(cy - centerY(last)) <= Math.max(b.bbox.height, lineHeight(last)) * 0.6) {
      last.words.push(b)
      last.minX = Math.min(last.minX, b.bbox.x)
      last.minY = Math.min(last.minY, b.bbox.y)
      last.maxX = Math.max(last.maxX, b.bbox.x + b.bbox.width)
      last.maxY = Math.max(last.maxY, b.bbox.y + b.bbox.height)
    } else {
      lines.push({
        words: [b],
        minX: b.bbox.x,
        minY: b.bbox.y,
        maxX: b.bbox.x + b.bbox.width,
        maxY: b.bbox.y + b.bbox.height
      })
    }
  }
  return lines
}

function sideOf(minX: number, maxX: number, midX: number): 'L' | 'R' {
  return (minX + maxX) / 2 >= midX ? 'R' : 'L'
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function toHsvSaturation(c: StructColor): number {
  const max = Math.max(c.r, c.g, c.b) / 255
  const min = Math.min(c.r, c.g, c.b) / 255
  return max <= 0 ? 0 : (max - min) / max
}

// 颜色为主、位置兜底。把一条消息所有词块的颜色样本取平均，算 HSV 饱和度。
function classifySpeaker(words: StructBlock[], center: number, midX: number): Speaker {
  const samples = words.map((w) => w.colorSample).filter((c): c is StructColor => !!c)
  if (samples.length > 0) {
    const avg: StructColor = {
      r: samples.reduce((s, c) => s + c.r, 0) / samples.length,
      g: samples.reduce((s, c) => s + c.g, 0) / samples.length,
      b: samples.reduce((s, c) => s + c.b, 0) / samples.length
    }
    return toHsvSaturation(avg) >= satThreshold() ? 'self' : 'other'
  }
  // 取不到颜色 → 用左右位置
  return center >= midX ? 'self' : 'other'
}

/**
 * 主入口：OCR 词块（含可选颜色样本）→ 带说话人的消息列表。
 */
export function structureMessages(input: StructInput): StructMessage[] {
  const { width: w, height: h, blocks } = input
  if (!blocks || blocks.length === 0) return []

  // 1) 列检测（动态）
  const [chatX0, chatX1] = detectChatXRange(blocks, w)
  // 顶/底按比例轻裁（标题栏/输入框）
  const top = h * envNum('HYYD_CHAT_TOP_FRAC', 0.08)
  const bottom = h - h * envNum('HYYD_CHAT_BOTTOM_FRAC', 0.1)

  const inChat = blocks.filter((b) => {
    const cx = b.bbox.x + b.bbox.width / 2
    const cy = b.bbox.y + b.bbox.height / 2
    return cy >= top && cy <= bottom && cx >= chatX0 && cx < chatX1
  })
  if (inChat.length === 0) return []

  // 2) 词 → 行
  const lines = groupLines(inChat)
  if (lines.length === 0) return []

  let lineH = median(lines.map(lineHeight).filter((x) => x > 0))
  if (lineH <= 0) lineH = 20
  const midX = (chatX0 + chatX1) / 2

  // 3) 行 → 消息（气泡）：垂直间隔大 或 左右侧切换 → 新消息
  const msgs: Line[][] = []
  for (const ln of lines) {
    let newMsg = msgs.length === 0
    if (!newMsg) {
      const cur = msgs[msgs.length - 1]
      const prev = cur[cur.length - 1]
      const gap = ln.minY - prev.maxY
      const sidePrev = sideOf(prev.minX, prev.maxX, midX)
      const sideCur = sideOf(ln.minX, ln.maxX, midX)
      if (gap > lineH * 0.9 || sidePrev !== sideCur) newMsg = true
    }
    if (newMsg) msgs.push([ln])
    else msgs[msgs.length - 1].push(ln)
  }

  // 4) 每条消息判说话人
  const result: StructMessage[] = []
  for (const m of msgs) {
    const text = m.map(lineText).join('\n').trim()
    if (text.length === 0) continue

    const mnX = Math.min(...m.map((l) => l.minX))
    const mxX = Math.max(...m.map((l) => l.maxX))
    const center = (mnX + mxX) / 2

    // system：单行、居中、时间/日期/撤回等
    if (
      m.length === 1 &&
      Math.abs(center - midX) < (chatX1 - chatX0) * 0.18 &&
      (TIME_LINE.test(text) || SYSTEM_KEYWORD.test(text)) &&
      text.length <= 30
    ) {
      result.push({ speaker: 'system', name: null, text })
      continue
    }

    const words = m.flatMap((l) => l.words)
    result.push({ speaker: classifySpeaker(words, center, midX), name: null, text })
  }
  return result
}
