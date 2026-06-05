// 第2步用的纯函数：发 VL 前"按时间挑帧"，以及对 AI 还原结果"合并去重"。

// 挑帧：按截图时间戳，第一张 + 每隔 intervalSec 一张 + 永远带最后一张。
// 因为一条消息会在屏幕上停留较久，按时间间隔抽样不会漏小消息（如"OK"）。
export function sampleFrames<T extends { capturedAt: string | null }>(
  frames: T[],
  intervalSec = 20
): T[] {
  if (frames.length <= 2) return [...frames]
  const sorted = [...frames].sort((a, b) => ts(a.capturedAt) - ts(b.capturedAt))
  const picked: T[] = []
  let lastT = -Infinity
  for (const f of sorted) {
    const t = ts(f.capturedAt)
    if (picked.length === 0 || !Number.isFinite(t) || t - lastT >= intervalSec * 1000) {
      picked.push(f)
      lastT = Number.isFinite(t) ? t : lastT
    }
  }
  const last = sorted[sorted.length - 1]
  if (picked[picked.length - 1] !== last) picked.push(last)
  return picked
}

function ts(s: string | null): number {
  if (!s) return Number.NaN
  const t = Date.parse(s)
  return Number.isNaN(t) ? Number.NaN : t
}

// 去重键：发送者 + 规范化内容（去掉所有空白）
function dedupKey(m: AiReconstructMessage): string {
  return `${m.sender}|${m.content.replace(/\s+/g, '')}`
}

// 对单次 AI 结果去重（VL 偶尔会重复输出）
export function dedupMessages(msgs: AiReconstructMessage[]): {
  kept: AiReconstructMessage[]
  removed: number
} {
  const seen = new Set<string>()
  const kept: AiReconstructMessage[] = []
  for (const m of msgs) {
    if (!m.content.trim()) continue
    const k = dedupKey(m)
    if (seen.has(k)) continue
    seen.add(k)
    kept.push(m)
  }
  return { kept, removed: msgs.length - kept.length }
}

// 把本次新结果并入已累积列表（跨多次还原），返回新增/重复计数
export function mergeInto(
  existing: AiReconstructMessage[],
  incoming: AiReconstructMessage[]
): { merged: AiReconstructMessage[]; added: number; duplicate: number } {
  const seen = new Set(existing.map(dedupKey))
  const merged = [...existing]
  let added = 0
  let duplicate = 0
  for (const m of incoming) {
    if (!m.content.trim()) continue
    const k = dedupKey(m)
    if (seen.has(k)) {
      duplicate++
      continue
    }
    seen.add(k)
    merged.push(m)
    added++
  }
  return { merged, added, duplicate }
}
