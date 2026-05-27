import type { Order } from '../api/client'

interface Props {
  order: Order | null
  commandId?: number | null
  onClose: () => void
}

/**
 * 订单详情弹窗：申领成功后展示该订单的所有已知字段。
 * 数据来源：数据库里这条订单 + Chrome 插件之前扫描时存入的 rawJson。
 */
export default function OrderDetailModal({ order, commandId, onClose }: Props): React.JSX.Element | null {
  if (!order) return null

  const raw = (order.rawJson ?? {}) as Record<string, string>

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-6"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-800">订单详情</h2>
            <p className="text-xs text-slate-500 mt-1">
              已下发申领指令到浏览器 · 指令 ID: <code>{commandId ?? '—'}</code>
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 text-2xl leading-none"
          >
            ×
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* 状态条 */}
          <div className="bg-emerald-50 border border-emerald-200 rounded-md px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
            <span className="text-lg">✓</span>
            <span>
              已申领。Chrome 插件正在自动点击该订单的"详情"按钮。
            </span>
          </div>

          {/* 主要信息 */}
          <Section title="基础信息">
            <Row label="泰康订单号" value={order.sourceOrderNo} mono />
            <Row label="申请号" value={raw.applyNo} mono />
            <Row label="就诊人" value={order.customerName} />
            <Row label="服务类型" value={raw.serviceType} />
            <Row label="订单状态" value={raw.status ?? order.status} />
          </Section>

          <Section title="方案 / 套餐">
            <Row label="网络标签" value={raw.networkTag} />
            <Row label="方案名称" value={raw.planName} />
            <Row label="方案别名" value={raw.planAlias} />
            <Row label="套餐名称" value={raw.packetName} />
            <Row label="产品名称" value={raw.productName} />
            <Row label="单元项" value={raw.unitItem} />
          </Section>

          <Section title="时间 / 来源">
            <Row label="入池时间" value={raw.inPoolTime} />
            <Row label="申请时间" value={raw.applyTime} />
            <Row label="供应商" value={raw.supplier} />
            <Row label="入库时间" value={new Date(order.createdAt).toLocaleString('zh-CN')} />
          </Section>

          {/* 原始数据折叠 */}
          <details className="border border-slate-200 rounded">
            <summary className="px-4 py-2 text-xs text-slate-600 cursor-pointer hover:bg-slate-50">
              查看原始抓取数据 (rawJson)
            </summary>
            <pre className="px-4 py-3 bg-slate-50 text-[11px] text-slate-700 overflow-x-auto">
              {JSON.stringify(order.rawJson, null, 2)}
            </pre>
          </details>
        </div>

        {/* Footer */}
        <footer className="px-6 py-3 border-t border-slate-200 bg-slate-50 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm bg-white border border-slate-300 hover:bg-slate-100 rounded"
          >
            关闭
          </button>
        </footer>
      </div>
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
  value: string | null | undefined
  mono?: boolean
}): React.JSX.Element {
  const display = value && value.length > 0 ? value : '—'
  return (
    <div className="flex">
      <span className="w-20 text-slate-500 shrink-0">{label}</span>
      <span className={`text-slate-800 break-all ${mono ? 'font-mono text-xs' : ''}`}>
        {display}
      </span>
    </div>
  )
}
