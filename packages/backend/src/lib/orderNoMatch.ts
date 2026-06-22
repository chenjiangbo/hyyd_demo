/**
 * 订单号模糊解析：把 OCR 从聊天标题里抽到的"残缺/错几位"订单号候选，
 * 在某员工的订单集合里用「OCR 易混字符归一 + 编辑距离」找到唯一最接近的订单。
 *
 * 背景：订单号是 16 位 hex（普客 COD/CCOD/OD…）或 fwyy+长数字（高客）。
 * OCR 在不同机器上不稳：可能多/少空格、把某 1-2 位认错。但真实订单号近乎随机、
 * 彼此差十几位，所以"错 1-2 位的候选"在订单集合里几乎只会离它真正对应的那个最近。
 * 故用编辑距离 ≤2、取唯一最近即可稳定还原。
 */

// OCR 易混的"非 hex 字母 → 对应数字/hex"归一。只映射在 hex 串里不该出现的字母，
// 不动合法 hex（0-9 a-f）；对候选和库内订单号对称应用，只会让匹配更宽松、不会误伤。
const CONFUSION: Record<string, string> = {
  o: '0',
  q: '0',
  i: '1',
  l: '1',
  '|': '1',
  s: '5',
  z: '2',
  g: '9'
}

/** 归一：小写 + 易混字符替换。对候选与库内号都用，保证对称。 */
export function canonicalize(s: string): string {
  let out = ''
  for (const ch of s.toLowerCase()) {
    out += CONFUSION[ch] ?? ch
  }
  return out
}

/** 抽订单号候选：先去空白，再按前缀匹配。body 允许字母（容忍 OCR 把 hex 位认成字母），后续靠归一纠回。 */
const CANDIDATE_RE = /(?:c?cod|od|fwyy)[0-9a-z|]{6,24}/i

export type CandidateKind = 'fwyy' | 'cod' | 'ccod' | 'od' | 'unknown'

export interface ExtractedCandidate {
  raw: string // 去空白后的原始候选（保留大小写，便于展示）
  kind: CandidateKind
}

export function extractOrderCandidate(title: string | null | undefined): ExtractedCandidate | null {
  if (!title) return null
  const compact = title.replace(/\s+/g, '')
  const m = compact.match(CANDIDATE_RE)
  if (!m) return null
  const raw = m[0]
  const lower = raw.toLowerCase()
  const kind: CandidateKind = lower.startsWith('fwyy')
    ? 'fwyy'
    : lower.startsWith('ccod')
      ? 'ccod'
      : lower.startsWith('cod')
        ? 'cod'
        : lower.startsWith('od')
          ? 'od'
          : 'unknown'
  return { raw, kind }
}

/** 带上限的编辑距离（超过 max 提前返回 max+1，省计算）。 */
export function levenshtein(a: string, b: string, max: number): number {
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > max) return max + 1
  let prev = new Array<number>(lb + 1)
  let curr = new Array<number>(lb + 1)
  for (let j = 0; j <= lb; j++) prev[j] = j
  for (let i = 1; i <= la; i++) {
    curr[0] = i
    let rowMin = curr[0]
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      if (curr[j] < rowMin) rowMin = curr[j]
    }
    if (rowMin > max) return max + 1 // 整行都超阈值，不可能再降回来
    ;[prev, curr] = [curr, prev]
  }
  return prev[lb]
}

export interface OrderNoEntry {
  orderId: number
  nos: string[] // 该订单已知的所有订单号（sourceOrderNo / applyNo / crmApplyNo …）
  name?: string | null // 订单客户名，用于"靠容差匹配上"时拿来在标题里二次校验
}

export type ResolveResult =
  | { status: 'matched'; orderId: number; dist: number; matchedNo: string }
  | { status: 'none'; bestDist: number }
  | { status: 'ambiguous'; bestDist: number; orderIds: number[] }
  // 订单号靠容差(距离≥1)匹配上了某单，但该单的客户名没出现在标题里 → 可疑，疑似认错号撞上别人
  | { status: 'name_mismatch'; orderId: number; dist: number; matchedNo: string }

/**
 * 在候选订单集合里找与 candidate 最接近的订单。
 * - 唯一最近且距离 ≤ maxDist → matched；多个订单并列最近 → ambiguous；都超阈值 → none。
 * - 传了 title 时加一道名字校验：距离=0 的精确匹配直接信；距离 1~2 的容差匹配要求订单客户名
 *   出现在 title 里才算 matched，否则 name_mismatch；ambiguous 时用"名字在标题里"破平。
 */
export function resolveOrder(
  candidate: string,
  entries: OrderNoEntry[],
  maxDist = 2,
  title?: string | null
): ResolveResult {
  const c = canonicalize(candidate)
  let bestDist = Infinity
  let tied: { orderId: number; name?: string | null; no: string }[] = []

  for (const e of entries) {
    for (const no of e.nos) {
      if (!no) continue
      const cn = canonicalize(no)
      // 同时比较"候选截到订单号长度"的版本：OCR 常把后面紧邻的数字(时间戳等)粘进候选，
      // 截断后按前缀对齐比较，避免尾部垃圾字符把距离撑大导致漏配。
      const d = Math.min(
        levenshtein(c, cn, maxDist),
        c.length > cn.length ? levenshtein(c.slice(0, cn.length), cn, maxDist) : maxDist + 1
      )
      if (d < bestDist) {
        bestDist = d
        tied = [{ orderId: e.orderId, name: e.name, no }]
      } else if (d === bestDist) {
        // 同一订单的多个号只记一次
        if (!tied.some((t) => t.orderId === e.orderId)) tied.push({ orderId: e.orderId, name: e.name, no })
      }
    }
  }

  if (bestDist > maxDist) return { status: 'none', bestDist: bestDist === Infinity ? -1 : bestDist }

  const nameInTitle = (name?: string | null): boolean => !!name && !!title && title.includes(name)

  // 多单并列：用"客户名是否出现在标题里"破平，只有一个命中才敢选
  if (tied.length > 1) {
    const hit = tied.filter((t) => nameInTitle(t.name))
    if (hit.length === 1) return { status: 'matched', orderId: hit[0].orderId, dist: bestDist, matchedNo: hit[0].no }
    return { status: 'ambiguous', bestDist, orderIds: tied.map((t) => t.orderId) }
  }

  // 唯一最近
  const best = tied[0]
  if (bestDist === 0) return { status: 'matched', orderId: best.orderId, dist: 0, matchedNo: best.no }
  // 容差匹配：能验证（有客户名且传了标题）时，名字不在标题里 → 判可疑；否则维持 matched
  if (best.name && title && !nameInTitle(best.name)) {
    return { status: 'name_mismatch', orderId: best.orderId, dist: bestDist, matchedNo: best.no }
  }
  return { status: 'matched', orderId: best.orderId, dist: bestDist, matchedNo: best.no }
}
