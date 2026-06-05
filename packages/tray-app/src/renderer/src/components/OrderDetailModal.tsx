import { useEffect, useRef, useState } from 'react'
import { api, type Order, type OrderDetailResponse } from '../api/client'

interface Props {
  order: Order | null
  commandId?: number | null
  onClose: () => void
}

const POLL_INTERVAL_MS = 1500
const POLL_TIMEOUT_MS = 20_000

/**
 * 订单详情弹窗。
 * 数据流：先用 props.order 兜底渲染列表里已有的字段；
 * 打开后调 /api/v1/orders/:id/detail，没拿到详情就轮询，直到 detailFetchedAt 出现或超时。
 */
export default function OrderDetailModal({ order, commandId, onClose }: Props): React.JSX.Element | null {
  const [detailResp, setDetailResp] = useState<OrderDetailResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
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

  if (!order) return null

  const caseInfo: Record<string, any> = detailResp?.detail?.caseInfo ?? {}
  const latest: Record<string, any> = detailResp?.detail?.latestRegisterInfo ?? {}
  const intend: Record<string, any> = detailResp?.detail?.intendClinicInfo ?? {}
  // 兜底：详情没回来前，先展示列表的 rawJson
  const rawList = (order.rawJson ?? {}) as Record<string, any>
  const attachments = detailResp?.attachments ?? []

  const handleRefresh = async () => {
    setRefreshing(true)
    setError(null)
    try {
      await api.refreshOrderDetail(order.id)
      // 重置轮询起点
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
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-6"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-800">订单详情</h2>
            <p className="text-xs text-slate-500 mt-1">
              已下发申领指令 · 指令 ID: <code>{commandId ?? '—'}</code>
              {detailResp?.order.detailFetchedAt && (
                <span className="ml-3 text-emerald-600">
                  详情已更新 · {new Date(detailResp.order.detailFetchedAt).toLocaleTimeString('zh-CN')}
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefresh}
              disabled={refreshing || loading}
              className="text-xs px-3 py-1 border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded"
            >
              {refreshing ? '刷新中…' : '🔄 重抓详情'}
            </button>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-700 text-2xl leading-none"
            >
              ×
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {loading && !detailResp?.order.detailFetchedAt && (
            <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3 text-sm text-amber-800 flex items-center gap-2">
              <span className="animate-pulse">⏳</span>
              <span>正在抓取订单详情（插件在调用泰康接口）…先展示列表已有信息</span>
            </div>
          )}

          {detailResp?.order.detailFetchedAt && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-md px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
              <span>✓</span>
              <span>详情已抓取完成</span>
            </div>
          )}

          {error && <ErrorBanner error={error} onRetry={handleRefresh} />}

          <Section title="基础信息">
            <Row label="泰康订单号" value={caseInfo.subOrderNo ?? rawList.orderId ?? order.sourceOrderNo} mono />
            <Row label="申请号" value={caseInfo.applyNo ?? rawList.applyNo} mono />
            <Row label="CRM 申请号" value={caseInfo.crmApplyNo} mono />
            <Row label="就诊人" value={caseInfo.patientName ?? rawList.patientName ?? order.customerName} />
            <Row label="性别" value={caseInfo.sex} />
            <Row label="生日" value={caseInfo.birthday} />
            <Row label="证件类型" value={caseInfo.cardType} />
            <Row label="证件号" value={caseInfo.cardId} mono />
            <Row label="联系电话" value={caseInfo.paMobile} />
            <Row label="客户等级" value={caseInfo.cusLevel} />
          </Section>

          <Section title="就诊意向">
            <Row label="医院" value={caseInfo.intendHos ?? latest.hosName} />
            <Row label="城市" value={caseInfo.intendCity ?? latest.city} />
            <Row label="科室" value={caseInfo.intendDept ?? latest.hosDept ?? intend.hosDept} />
            <Row label="医生" value={caseInfo.intendDoc} />
            <Row label="职称" value={caseInfo.intendDocTitle} />
            <Row label="就诊日期" value={caseInfo.intendDate ?? latest.intendClinicDate} />
            <Row label="时段" value={caseInfo.intendDateAmorpm ?? latest.intendClinicDateAmorpm} />
            <Row label="疑似疾病" value={caseInfo.suspectDisease} />
          </Section>

          <Section title="方案 / 产品">
            <Row label="服务项" value={caseInfo.serviceItemName ?? rawList.serviceType} />
            <Row label="套餐" value={caseInfo.packetName ?? rawList.packetName} />
            <Row label="方案" value={caseInfo.planName ?? rawList.planName} />
            <Row label="方案别名" value={caseInfo.planAlias ?? rawList.planAlias} />
            <Row label="产品" value={caseInfo.productName ?? rawList.productName} />
            <Row label="标签" value={caseInfo.labelName ?? rawList.networkTag} />
          </Section>

          <Section title="投保人 / 联系人">
            <Row label="投保人" value={caseInfo.insurName} />
            <Row label="紧急联系人" value={caseInfo.ecpName} />
            <Row label="紧急联系电话" value={caseInfo.ecpPhone} />
            <Row label="与投保人关系" value={caseInfo.patEcpRelationship} />
          </Section>

          <Section title="流程 / 状态">
            <Row label="订单状态" value={caseInfo.orderStateName ?? rawList.status ?? order.status} />
            <Row label="当前阶段" value={caseInfo.stageName} />
            <Row label="申请方式" value={caseInfo.applyWayDesc} />
            <Row label="申请时间" value={caseInfo.applicationDate ?? rawList.applyTime} />
            <Row label="受理时间" value={caseInfo.mmgrApplyDate} />
            <Row label="预计出院" value={caseInfo.estimateOutHospitalDate} />
          </Section>

          <section>
            <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
              附件（{attachments.length}）
            </h3>
            {attachments.length === 0 ? (
              <div className="text-xs text-slate-400 py-4 text-center border border-dashed border-slate-200 rounded">
                {loading ? '抓取中…' : '该订单暂无证件 / 附件'}
              </div>
            ) : (
              <AttachmentGallery items={attachments} onPreview={setPreviewUrl} />
            )}
          </section>

          <details className="border border-slate-200 rounded">
            <summary className="px-4 py-2 text-xs text-slate-600 cursor-pointer hover:bg-slate-50">
              查看完整详情 JSON（debug）
            </summary>
            <pre className="px-4 py-3 bg-slate-50 text-[11px] text-slate-700 overflow-x-auto max-h-64">
              {JSON.stringify(detailResp?.detail ?? order.rawJson, null, 2)}
            </pre>
          </details>
        </div>

        <footer className="px-6 py-3 border-t border-slate-200 bg-slate-50 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm bg-white border border-slate-300 hover:bg-slate-100 rounded"
          >
            关闭
          </button>
        </footer>
      </div>

      {previewUrl && (
        <div
          className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-8"
          onClick={() => setPreviewUrl(null)}
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

// fileType 语义字典：根据观察 + 用户提供
// 注：5000 出现过但都是空数据，估计是"病历"类，留个占位
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
  // 按 fileType 分组展示，每组里再按 id 顺序
  const groups = new Map<string, typeof items>()
  for (const a of items) {
    const arr = groups.get(a.fileType) ?? []
    arr.push(a)
    groups.set(a.fileType, arr)
  }
  // 排序：已知 fileType 在前
  const knownOrder = ['40', '41', '5001', '5000']
  const sortedTypes = Array.from(groups.keys()).sort((a, b) => {
    const ia = knownOrder.indexOf(a)
    const ib = knownOrder.indexOf(b)
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
  })

  return (
    <div className="space-y-4">
      {sortedTypes.map((type) => {
        const groupItems = groups.get(type) ?? []
        return (
          <div key={type}>
            <div className="text-xs text-slate-500 mb-1.5 flex items-center gap-2">
              <span className="font-medium text-slate-700">{fileTypeLabel(type)}</span>
              <span className="text-slate-400">· {groupItems.length} 张</span>
              <span className="text-slate-300 text-[10px]">(原 type={type})</span>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
              {groupItems.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onPreview(a.url)}
                  className="group border border-slate-200 rounded overflow-hidden hover:border-blue-400 hover:shadow text-left"
                >
                  <div className="aspect-square bg-slate-50 flex items-center justify-center overflow-hidden">
                    {a.mimeType.startsWith('image/') ? (
                      <img
                        src={a.url}
                        alt={a.fileName}
                        className="object-cover w-full h-full group-hover:scale-105 transition-transform"
                      />
                    ) : (
                      <span className="text-slate-400 text-xs">非图片</span>
                    )}
                  </div>
                  <div className="px-2 py-1 text-[10px] text-slate-600">
                    <div className="truncate" title={a.fileName}>{a.fileName}</div>
                    <div className="text-slate-400">{(a.byteSize / 1024).toFixed(0)} KB</div>
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
  // 根据错误前缀判定类型并给出引导
  let title = '抓取失败'
  let hint: string | null = null
  let bg = 'bg-red-50 border-red-200 text-red-700'
  if (/TOKEN_EXPIRED/i.test(error)) {
    title = '泰康登录已过期'
    hint = '请去浏览器里的泰康标签页随便点一下（让它弹出登录框），重新登录后回来点"重试"。'
    bg = 'bg-amber-50 border-amber-200 text-amber-800'
  } else if (/NEED_LOGIN/i.test(error)) {
    title = '未检测到泰康登录态'
    hint = '请确认浏览器已登录泰康 CCM 系统，并保持泰康标签页打开。'
    bg = 'bg-amber-50 border-amber-200 text-amber-800'
  } else if (/EMPTY_DATA/i.test(error)) {
    title = '泰康未返回该订单详情'
    hint = '该订单可能不在当前登录账号的权限范围内，或泰康那边数据未完整入库。'
  } else if (/未找到泰康标签页/.test(error)) {
    title = '未打开泰康页面'
    hint = '请先在浏览器中打开 ccm.taikang.com 并登录，再点"重试"。'
    bg = 'bg-amber-50 border-amber-200 text-amber-800'
  } else if (/Could not establish connection/i.test(error)) {
    title = '插件与泰康页面通信失败'
    hint = '请去 chrome://extensions 刷新插件，并 F5 刷新泰康标签页后重试。'
    bg = 'bg-amber-50 border-amber-200 text-amber-800'
  }
  return (
    <div className={`border rounded-md px-4 py-3 text-sm ${bg}`}>
      <div className="font-medium flex items-center gap-2">
        <span>⚠️</span>
        <span>{title}</span>
      </div>
      {hint && <div className="mt-1 text-xs opacity-90">{hint}</div>}
      <details className="mt-2 text-[11px] opacity-70">
        <summary className="cursor-pointer">原始错误</summary>
        <code className="block mt-1 break-all">{error}</code>
      </details>
      <button
        onClick={onRetry}
        className="mt-2 px-3 py-1 text-xs bg-white border border-current rounded hover:bg-black/5"
      >
        🔄 重试抓取
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
      <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
        {title}
      </h3>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">{children}</div>
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
      <span className="w-24 text-slate-500 shrink-0">{label}</span>
      <span className={`text-slate-800 break-all ${mono ? 'font-mono text-xs' : ''}`}>
        {display}
      </span>
    </div>
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
