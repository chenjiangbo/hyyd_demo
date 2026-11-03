type Candidate = { applicationNo: string; orders: Array<{ orderId: number }> }
type Score = { confidence: number; evidence: string[] }

function score(value: unknown): Score {
  if (!value || typeof value !== 'object') throw new Error('订单匹配 AI 缺少候选评分')
  const item = value as Record<string, unknown>
  if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 100) throw new Error('订单匹配 AI 返回的置信度必须为 0 到 100 的数字')
  if (!Array.isArray(item.evidence) || item.evidence.some((s) => typeof s !== 'string')) throw new Error('订单匹配 AI 返回的证据格式无效')
  return { confidence: item.confidence, evidence: item.evidence as string[] }
}

function winner<T extends Score>(values: T[]): T | null {
  const ranked = [...values].sort((a, b) => b.confidence - a.confidence)
  return ranked.length && ranked[0].confidence > 90 && (ranked.length === 1 || ranked[0].confidence - ranked[1].confidence >= 10) ? ranked[0] : null
}

/** Validate that the model scored every supplied candidate, then apply the business thresholds. */
export function selectRegistrationProofScores(raw: unknown, candidates: Candidate[]) {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Record<string, unknown>).applications)) throw new Error('订单匹配 AI 未返回申领号候选评分')
  const applications = (raw as { applications: unknown[] }).applications
  if (applications.length !== candidates.length) throw new Error('订单匹配 AI 返回的申领号候选不完整')
  const scored = candidates.map((candidate) => {
    const matches = applications.filter((v) => v && typeof v === 'object' && (v as Record<string, unknown>).applicationNo === candidate.applicationNo)
    if (matches.length !== 1) throw new Error('订单匹配 AI 返回了重复或缺失的申领号候选')
    const item = matches[0] as Record<string, unknown>
    if (!Array.isArray(item.orders) || item.orders.length !== candidate.orders.length) throw new Error('订单匹配 AI 返回的订单候选不完整')
    const orders = candidate.orders.map(({ orderId }) => {
      const matching = (item.orders as unknown[]).filter((v) => v && typeof v === 'object' && (v as Record<string, unknown>).orderId === orderId)
      if (matching.length !== 1) throw new Error('订单匹配 AI 返回了重复或缺失的订单候选')
      return { orderId, ...score(matching[0]) }
    })
    return { applicationNo: candidate.applicationNo, ...score(item), orders }
  })
  const application = scored.length === 1 ? scored[0] : winner(scored)
  const order = application ? winner(application.orders) : null
  return { scored, application, order }
}
