import { useEffect, useRef, useState, useCallback } from 'react'
import { api, type Order, type OrderDetailResponse } from '../api/client'
import MaterialPanel from './MaterialPanel'

interface Props {
  order: Order | null
  commandId?: number | null
  onClose: () => void
}

const POLL_INTERVAL_MS = 1500
const POLL_TIMEOUT_MS = 20_000

/**
 * 订单详情弹窗（现场采集版）。
 *
 * 主体：「素材录入」区（粘贴 + 时间线 + 同步状态），默认展开。
 * 折叠：「订单详情」区（caseInfo + 附件），默认收起；
 *      插件改成只调 recommendations 后，原 caseInfo/latestRegisterInfo
 *      字段大多落空，等 chrome 插件那边定型再补回。
 *
 * 详情数据流：进来先用 props.order 兜底，再 GET /orders/:id/detail，
 * 没拿到就轮询，直到 detailFetchedAt 出现或超时。
 */
export default function OrderDetailModal({
  order,
  commandId,
  onClose
}: Props): React.JSX.Element | null {
  const [detailResp, setDetailResp] = useState<OrderDetailResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const pollAbortRef = useRef<boolean>(false)

  useEffect(() => {
    if (!order) {
      setDetailResp(null)
      setError(null)
      pollAbortRef.current = true
      return
    }
    pollAbortRef.current = false
    setDetailResp(null)
    setError(null)
    setLoading(true)

    const start = Date.now()
    const poll = async (): Promise<void> => {
      while (!pollAbortRef.current) {
        try {
          const resp = await api.getOrderDetail(order.id)
          setDetailResp(resp)
          setError(null)
          if (resp.order.detailFetchedAt || resp.attachments.length > 0) {
            setLoading(false)
            return
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
        if (Date.now() - start > POLL_TIMEOUT_MS) {
          setLoading(false)
          return
        }
        await sleep(POLL_INTERVAL_MS)
      }
    }
    void poll()
    return () => {
      pollAbortRef.current = true
    }
  }, [order?.id])

  // ESC 关闭
  useEffect(() => {
    if (!order) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [order, onClose])

  const handleRefresh = useCallback(async () => {
    if (!order) return
    setRefreshing(true)
    setError(null)
    try {
      await api.refreshOrderDetail(order.id)
      pollAbortRef.current = true
      await sleep(50)
      pollAbortRef.current = false
      setLoading(true)
      const start = Date.now()
      while (!pollAbortRef.current) {
        const resp = await api.getOrderDetail(order.id)
        const wasFetchedAt = detailResp?.order.detailFetchedAt
        if (resp.order.detailFetchedAt && resp.order.detailFetchedAt !== wasFetchedAt) {
          setDetailResp(resp)
          break
        }
        if (Date.now() - start > POLL_TIMEOUT_MS) break
        await sleep(POLL_INTERVAL_MS)
      }
      setLoading(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRefreshing(false)
    }
  }, [order, detailResp?.order.detailFetchedAt])

  if (!order) return null

  // 现行 chrome 插件抓的详情统一挂在 recommendations 下（旧的 caseInfo/
  // latestRegisterInfo/intendClinicInfo 都没了，直接读 recommendations）。
  const rec: Record<string, any> = (detailResp?.detail?.recommendations as any) ?? {}
  const rawList = (order.rawJson ?? {}) as Record<string, any>
  const attachments = detailResp?.attachments ?? []

  // header 摘要：列表字段兜底，详情字段优先
  const customerName = rec.patientName ?? rawList.patientName ?? order.customerName
  const phone = rec.paMobile ?? rawList.paMobile ?? null
  const hospital = rec.intendHos ?? rec.visitingHospital ?? rawList.hospital ?? null
  const dept = rec.intendDept ?? rawList.dept ?? null

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-bg text-fg ring-1 ring-line rounded-lg shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ─── Header ─── */}
        <header className="px-5 py-3 border-b border-line bg-surface flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold text-fg truncate">{customerName}</h2>
              <code className="text-[11px] text-fg-muted">{order.sourceOrderNo}</code>
              {order.status && (
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-surface-2 text-fg-muted ring-1 ring-line">
                  {order.status}
                </span>
              )}
            </div>
            <p className="text-[11px] text-fg-subtle mt-0.5 truncate">
              {hospital ?? ''}{hospital && dept ? ' · ' : ''}{dept ?? ''}
              {phone && <span className="ml-2">📞 {phone}</span>}
              {commandId != null && (
                <span className="ml-2">指令 #{commandId}</span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 w-7 h-7 rounded text-fg-muted hover:text-fg hover:bg-surface-2"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>

        {/* ─── Body ─── */}
        <div className="flex-1 overflow-y-auto">
          {/* 主体：素材录入 */}
          <MaterialPanel orderId={order.id} />

          {/* 详情区（折叠） */}
          <section className="border-t border-line">
            <button
              type="button"
              onClick={() => setDetailOpen((v) => !v)}
              className="w-full px-5 py-2.5 flex items-center justify-between text-left bg-surface hover:bg-surface-2 transition-colors"
            >
              <span className="text-[13px] font-medium text-fg">
                订单详情{' '}
                <span className="text-fg-subtle font-normal ml-1">
                  {detailResp?.order.detailFetchedAt
                    ? '已抓取'
                    : loading
                      ? '抓取中…'
                      : '等待 Chrome 插件接入'}
                </span>
              </span>
              <span className="text-fg-muted text-xs">
                {detailOpen ? '▲ 收起' : '▼ 展开'}
              </span>
            </button>

            {detailOpen && (
              <div className="px-5 py-4 space-y-4 bg-bg">
                <div className="flex items-center justify-end">
                  <button
                    onClick={handleRefresh}
                    disabled={refreshing || loading}
                    className="text-[12px] px-2.5 py-1 ring-1 ring-line bg-surface hover:bg-surface-2 disabled:opacity-50 rounded text-fg-muted"
                  >
                    {refreshing ? '刷新中…' : '🔄 重抓详情'}
                  </button>
                </div>

                {loading && !detailResp?.order.detailFetchedAt && (
                  <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-2 text-xs text-amber-800">
                    ⏳ 正在抓取订单详情（插件调泰康接口）…
                  </div>
                )}
                {error && <ErrorBanner error={error} onRetry={handleRefresh} />}

                <Section title="基础信息">
                  <Row label="泰康订单号" value={rec.subOrderNo ?? rawList.orderId ?? order.sourceOrderNo} mono />
                  <Row label="申请号" value={rec.applyNo ?? rawList.applyNo} mono />
                  <Row label="CRM 申请号" value={rec.crmApplyNo} mono />
                  <Row label="就诊人" value={rec.patientName ?? rawList.patientName ?? order.customerName} />
                  <Row label="性别" value={rec.sex ?? rawList.sex} />
                  <Row label="生日" value={rec.birthday} />
                  <Row label="证件类型" value={rec.cardType} />
                  <Row label="联系电话" value={rec.paMobile} />
                  <Row label="客户等级" value={rec.cusLevel} />
                  <Row label="客户关系" value={rec.relationship} />
                </Section>

                <Section title="投保 / 联系人">
                  <Row label="投保人" value={rec.insurName} />
                  <Row label="保单号" value={rec.insurNo} mono />
                  <Row label="保单机构" value={rec.insurBrhName} />
                  <Row label="紧急联系电话" value={rec.ecpPhone} />
                  <Row label="与投保人关系" value={rec.patEcpRelationship} />
                  <Row label="社保号" value={rec.socSecNo} mono />
                </Section>

                <Section title="就诊意向">
                  <Row label="意向医院" value={rec.intendHos} />
                  <Row label="意向城市" value={[rec.intendProvince, rec.intendCity].filter(Boolean).join(' / ') || rec.intendCity} />
                  <Row label="意向科室" value={rec.intendDept} />
                  <Row label="意向医生" value={rec.intendDoc} />
                  <Row label="医生职称" value={rec.intendDocTitle} />
                  <Row label="就诊日期" value={[rec.intendDate, rec.intendDateAmorpm].filter(Boolean).join(' ')} />
                  <Row label="疑似疾病" value={rec.suspectDisease} />
                  <Row label="确诊情况" value={rec.approveDetail} />
                  <Row label="确诊详情" value={rec.approveDiseaseDesc} />
                </Section>

                <Section title="服务记录（已就诊 / 已分配）">
                  <Row label="服务医院" value={rec.visitingHospital} />
                  <Row label="服务城市" value={[rec.visitingProvince, rec.visitingCity].filter(Boolean).join(' / ') || rec.visitingCity} />
                  <Row label="出发地" value={rec.departureAddress} />
                  <Row label="服务详址" value={rec.visitingHospitalDetailAddress} />
                  <Row label="家属姓名" value={rec.accompanyFamilyMembersName} />
                  <Row label="家属电话" value={rec.accompanyFamilyMembersMobile} />
                  <Row label="预计出院" value={rec.estimateOutHospitalDate} />
                </Section>

                <Section title="方案 / 产品">
                  <Row label="服务项" value={rec.serviceItemName ?? rec.serviceName ?? rawList.serviceType} />
                  <Row label="子方案" value={rec.subPlanName} />
                  <Row label="套餐" value={rec.packetName ?? rawList.packetName} />
                  <Row label="方案" value={rec.planName ?? rawList.planName} />
                  <Row label="方案别名" value={rec.planAlias} />
                  <Row label="产品" value={rec.productName ?? rawList.productName} />
                  <Row label="标签" value={rec.labelName ?? rawList.networkTag} />
                </Section>

                <Section title="流程 / 状态">
                  <Row label="订单状态" value={rec.orderStateName ?? rawList.status ?? order.status} />
                  <Row label="当前阶段" value={rec.stageName} />
                  <Row label="服务状态" value={rec.servStateName} />
                  <Row label="申请方式" value={rec.applyWayDesc} />
                  <Row label="申请时间" value={rec.applicationDate ?? rawList.applyTime} />
                  <Row label="受理时间" value={rec.mmgrApplyDate} />
                  <Row label="服务开始" value={rec.startDate} />
                </Section>

                <section>
                  <h3 className="text-[11px] font-medium text-fg-muted uppercase tracking-wide mb-2">
                    附件（{attachments.length}）
                  </h3>
                  {attachments.length === 0 ? (
                    <div className="text-[11px] text-fg-subtle py-3 text-center border border-dashed border-line rounded">
                      {loading ? '抓取中…' : '该订单暂无证件 / 附件'}
                    </div>
                  ) : (
                    <AttachmentGallery items={attachments} onPreview={setPreviewUrl} />
                  )}
                </section>

                <details className="border border-line rounded">
                  <summary className="px-3 py-1.5 text-[11px] text-fg-muted cursor-pointer hover:bg-surface-2">
                    完整详情 JSON（debug）
                  </summary>
                  <pre className="px-3 py-2 bg-surface-2 text-[11px] text-fg-muted overflow-x-auto max-h-64">
                    {JSON.stringify(detailResp?.detail ?? order.rawJson, null, 2)}
                  </pre>
                </details>
              </div>
            )}
          </section>
        </div>
      </div>

      {previewUrl && (
        <div
          className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-8"
          onClick={(e) => {
            // 阻止冒泡到外层订单详情的 backdrop（否则会把订单详情也关掉）
            e.stopPropagation()
            setPreviewUrl(null)
          }}
        >
          <img
            src={previewUrl}
            alt="附件预览"
            className="max-h-full max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────────
// 详情区辅助组件（沿用旧实现，待 chrome 插件接入新结构再大改）
// ───────────────────────────────────────────────────────────────

const FILE_TYPE_LABELS: Record<string, string> = {
  '40': '身份证',
  '41': '社保卡',
  '5000': '病历',
  '5001': '其他附件'
}
function fileTypeLabel(t: string): string {
  return FILE_TYPE_LABELS[t] ?? `类型 ${t}`
}

function AttachmentGallery({
  items,
  onPreview
}: {
  items: NonNullable<OrderDetailResponse['attachments']>
  onPreview: (url: string) => void
}): React.JSX.Element {
  const groups = new Map<string, typeof items>()
  for (const a of items) {
    const arr = groups.get(a.fileType) ?? []
    arr.push(a)
    groups.set(a.fileType, arr)
  }
  const knownOrder = ['40', '41', '5001', '5000']
  const sortedTypes = Array.from(groups.keys()).sort((a, b) => {
    const ia = knownOrder.indexOf(a)
    const ib = knownOrder.indexOf(b)
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
  })

  return (
    <div className="space-y-3">
      {sortedTypes.map((type) => {
        const groupItems = groups.get(type) ?? []
        return (
          <div key={type}>
            <div className="text-[11px] text-fg-muted mb-1.5">
              <span className="font-medium text-fg">{fileTypeLabel(type)}</span>
              <span className="text-fg-subtle ml-1.5">· {groupItems.length} 张</span>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {groupItems.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onPreview(a.url)}
                  className="group ring-1 ring-line rounded overflow-hidden hover:ring-accent text-left"
                >
                  <div className="aspect-square bg-surface-2 flex items-center justify-center overflow-hidden">
                    {a.mimeType.startsWith('image/') ? (
                      <img
                        src={a.url}
                        alt={a.fileName}
                        className="object-cover w-full h-full group-hover:scale-105 transition-transform"
                      />
                    ) : (
                      <span className="text-fg-subtle text-xs">非图片</span>
                    )}
                  </div>
                  <div className="px-1.5 py-1 text-[10px] text-fg-muted">
                    <div className="truncate" title={a.fileName}>{a.fileName}</div>
                    <div className="text-fg-subtle">{(a.byteSize / 1024).toFixed(0)} KB</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ErrorBanner({ error, onRetry }: { error: string; onRetry: () => void }): React.JSX.Element {
  let title = '抓取失败'
  let hint: string | null = null
  let bg = 'bg-red-50 border-red-200 text-red-700'
  if (/TOKEN_EXPIRED/i.test(error)) {
    title = '泰康登录已过期'
    hint = '请去浏览器里的泰康标签页重新登录后回来点"重试"。'
    bg = 'bg-amber-50 border-amber-200 text-amber-800'
  } else if (/NEED_LOGIN/i.test(error)) {
    title = '未检测到泰康登录态'
    hint = '请确认浏览器已登录泰康 CCM。'
    bg = 'bg-amber-50 border-amber-200 text-amber-800'
  } else if (/EMPTY_DATA|EMPTY_DETAIL/i.test(error)) {
    title = '泰康未返回该订单详情'
  }
  return (
    <div className={`border rounded-md px-3 py-2 text-xs ${bg}`}>
      <div className="font-medium flex items-center gap-2">
        <span>⚠️</span>
        <span>{title}</span>
      </div>
      {hint && <div className="mt-0.5 opacity-90">{hint}</div>}
      <details className="mt-1.5 text-[11px] opacity-70">
        <summary className="cursor-pointer">原始错误</summary>
        <code className="block mt-1 break-all">{error}</code>
      </details>
      <button
        onClick={onRetry}
        className="mt-1.5 px-2.5 py-0.5 text-[11px] bg-white border border-current rounded hover:bg-black/5"
      >
        🔄 重试
      </button>
    </div>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section>
      <h3 className="text-[11px] font-medium text-fg-muted uppercase tracking-wide mb-1.5">
        {title}
      </h3>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[13px]">{children}</div>
    </section>
  )
}

function Row({
  label,
  value,
  mono = false
}: {
  label: string
  value: any
  mono?: boolean
}): React.JSX.Element {
  const display = value === null || value === undefined || value === '' ? '—' : String(value)
  return (
    <div className="flex">
      <span className="w-20 text-fg-muted shrink-0">{label}</span>
      <span className={`text-fg break-all ${mono ? 'font-mono text-[11px]' : ''}`}>{display}</span>
    </div>
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
