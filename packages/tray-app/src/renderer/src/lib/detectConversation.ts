// 第1层：从一帧的 OCR 文字块判断"这是哪个会话 / 要不要送 AI"
// 规则（企微/微信统一）：
//   - 命中「手机号#姓名」(如 13683106089#张文娟) → 客户 1v1；多处出现时取 y 最小（最靠上）= 标题栏
//   - 含「泰康」→ 泰康工作群（同样取最靠上）
//   - 否则 → none（丢弃，不送 AI）
//
// Windows OCR 特点：一串数字是一个块，但汉字往往一字一块。所以必须先按坐标把
// 同一行的块拼成整行，再匹配。

export type ConvKind = 'customer' | 'taikang_group' | 'none'

export interface ReconLine {
  x: number // 行最左 x
  y: number // 行最上 y
  text: string // 同行块按 x 拼接（去空格）
}

export interface ConvDetect {
  kind: ConvKind
  title: string | null
  phone?: string
  name?: string
  /** 调试用：拼接后的前若干行（自上而下） */
  lines: ReconLine[]
  /** 调试用：命中「手机号#姓名」的所有行（含坐标），按 y 升序 */
  phoneHits: ReconLine[]
}

export interface OcrBlockLike {
  text: string
  bbox: { x: number; y: number; width: number; height: number }
}

// 11 位手机号(1 开头) + # + 中文/英文姓名
const PHONE_NAME = /(1\d{10})#([一-龥A-Za-z·]{1,12})/

// 标题栏的 y 上限：只有靠最顶部(标题栏)的命中才算"当前打开的会话标题"，
// y 更大的属于左侧联系人列表里的别的客户，必须排除。不同分辨率可能要调。
export const TITLE_MAX_Y = 120

// 把单字/碎块按 y 聚成行、行内按 x 拼接
function reconstructLines(blocks: OcrBlockLike[]): ReconLine[] {
  const sorted = [...blocks].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)
  const lines: { cy: number; items: OcrBlockLike[] }[] = []
  for (const b of sorted) {
    const cy = b.bbox.y + b.bbox.height / 2
    const tol = Math.max(10, b.bbox.height * 0.6)
    const line = lines.find((l) => Math.abs(l.cy - cy) <= tol)
    if (line) line.items.push(b)
    else lines.push({ cy, items: [b] })
  }
  return lines
    .map((l) => {
      const items = l.items.sort((a, b) => a.bbox.x - b.bbox.x)
      return {
        x: Math.min(...items.map((i) => i.bbox.x)),
        y: Math.min(...items.map((i) => i.bbox.y)),
        text: items
          .map((i) => i.text)
          .join('')
          .replace(/\s+/g, '')
      }
    })
    .sort((a, b) => a.y - b.y)
}

export function detectConversation(blocks: OcrBlockLike[] | undefined | null): ConvDetect {
  const empty: ConvDetect = { kind: 'none', title: null, lines: [], phoneHits: [] }
  if (!blocks || blocks.length === 0) return empty

  const lines = reconstructLines(blocks)
  const topLines = lines.slice(0, 12)

  // 命中「手机号#姓名」的所有行（按 y 升序，含侧边栏里的，供展示）
  const phoneHits = lines.filter((l) => PHONE_NAME.test(l.text))

  // 1) 客户：只认标题栏区（y ≤ TITLE_MAX_Y）里的命中；侧边栏(y 更大)里的别的客户不算
  const titleHit = phoneHits.find((l) => l.y <= TITLE_MAX_Y)
  if (titleHit) {
    const m = titleHit.text.match(PHONE_NAME)!
    return {
      kind: 'customer',
      title: `${m[1]}#${m[2]}`,
      phone: m[1],
      name: m[2],
      lines: topLines,
      phoneHits
    }
  }
  // 2) 泰康群：标题栏区里含「泰康」
  const tk = lines.find((l) => l.y <= TITLE_MAX_Y && l.text.includes('泰康'))
  if (tk) return { kind: 'taikang_group', title: tk.text, lines: topLines, phoneHits }

  return { ...empty, lines: topLines, phoneHits }
}

export function convKindLabel(d: ConvDetect): string {
  if (d.kind === 'customer') return `客户 ${d.title}`
  if (d.kind === 'taikang_group') return `泰康群 ${d.title ?? ''}`.trim()
  return '未匹配（不送 AI）'
}
