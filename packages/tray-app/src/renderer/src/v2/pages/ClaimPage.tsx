import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchClaimableOrders, claimOrder, createOrder, type Order, type CreateOrderInput } from '../api'
import { bizType, bizChipClass, sourceStyle, sourceLabelByCode, SOURCE_OPTIONS, monthDay } from '../lib/orderMapping'

/**
 * 待申领台：全局"候选"状态订单池，任何员工可申领。
 * 按池分两类：挂号 / 其他绿通（候选阶段拿不到 poolType，按 serviceType 含"挂号"判定）。
 * 申领 → 订单变"已申领"并分配给本人（后端同时推 ext 申领指令），从列表移除。
 */
type Pool = 'register' | 'general'

function isRegister(o: Order): boolean {
  if (o.rawJson?.poolType === 'register') return true
  const t = o.rawJson?.serviceType || o.rawJson?.itemName || ''
  return /挂号/.test(t)
}
function applicationNoOf(o: Order): string | null {
  const r = (o.rawJson ?? {}) as Record<string, unknown>
  return (r.crmApplyNo as string) || (r.applyNo as string) || null
}
function productOf(o: Order): string | null {
  const r = (o.rawJson ?? {}) as Record<string, unknown>
  return (r.productName as string) || (r.planAlias as string) || (r.planName as string) || null
}
function poolTimeOf(o: Order): string | null {
  const r = (o.rawJson ?? {}) as Record<string, unknown>
  return (r.inPoolTime as string) || (r.applyTime as string) || o.createdAt || o.updatedAt || null
}

export default function ClaimPage(): React.JSX.Element {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [claimingId, setClaimingId] = useState<number | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [pool, setPool] = useState<Pool>('register')
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const [showCreate, setShowCreate] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    fetchClaimableOrders()
      .then((list) => {
        setOrders(list)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : '加载待申领订单失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => load(), [load])

  const counts = useMemo(
    () => ({
      register: orders.filter(isRegister).length,
      general: orders.filter((o) => !isRegister(o)).length
    }),
    [orders]
  )

  // 来源筛选项：池内出现过的来源（动态，自动适配泰康/平安/人保…）
  const sources = useMemo(() => {
    const set = new Set<string>()
    for (const o of orders) if (o.source) set.add(o.source)
    return [...set]
  }, [orders])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return orders
      .filter((o) => (pool === 'register' ? isRegister(o) : !isRegister(o)))
      .filter((o) => sourceFilter === 'all' || o.source === sourceFilter)
      .filter((o) => {
        if (!q) return true
        return (
          o.customerName?.toLowerCase().includes(q) ||
          o.sourceOrderNo?.toLowerCase().includes(q) ||
          (applicationNoOf(o) || '').toLowerCase().includes(q) ||
          o.hospital?.toLowerCase().includes(q) ||
          o.customerPhone?.includes(q)
        )
      })
  }, [orders, pool, query, sourceFilter])

  const doClaim = (o: Order): void => {
    if (claimingId) return
    setClaimingId(o.id)
    claimOrder(o.id)
      .then(() => {
        setOrders((prev) => prev.filter((x) => x.id !== o.id))
        setToast(`已申领 ${o.customerName} 的工单，已进入工作台`)
        setTimeout(() => setToast(null), 3000)
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : '申领失败')
        setTimeout(() => setError(null), 4000)
      })
      .finally(() => setClaimingId(null))
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-surface-bg">
      {/* 工具条：标题 + 池子tab + 搜索 + 刷新 */}
      <div className="shrink-0 px-6 py-3 bg-white border-b border-border-subtle flex items-center gap-4 flex-wrap">
        <h1 className="text-h3-title text-text-main shrink-0">待申领</h1>
        <div className="flex items-center bg-surface-bg border border-border-subtle rounded-lg p-0.5 shrink-0">
          <PoolTab label="挂号" count={counts.register} active={pool === 'register'} onClick={() => setPool('register')} />
          <PoolTab label="其他绿通" count={counts.general} active={pool === 'general'} onClick={() => setPool('general')} />
        </div>
        <div className="relative flex-1 max-w-sm min-w-[180px]">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline" style={{ fontSize: '18px' }}>search</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索客户 / 订单号 / 申请号 / 医院…"
            className="w-full pl-9 pr-3 py-1.5 bg-surface-bg border border-border-subtle rounded-lg text-body-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-primary text-white text-body-sm font-semibold hover:bg-primary/90"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>add</span>手工建单
          </button>
          <button
            onClick={load}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-body-sm border border-border-subtle text-text-main hover:bg-surface-container-low"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>refresh</span>刷新
          </button>
        </div>
      </div>

      {/* 来源筛选 */}
      {sources.length > 1 && (
        <div className="shrink-0 px-6 py-2 bg-white border-b border-border-subtle flex items-center gap-1.5 flex-wrap">
          <span className="text-label-caps text-text-muted mr-1">来源</span>
          <SourceChip label="全部" active={sourceFilter === 'all'} onClick={() => setSourceFilter('all')} />
          {sources.map((s) => (
            <SourceChip key={s} label={sourceLabelByCode(s)} active={sourceFilter === s} onClick={() => setSourceFilter(s)} />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateOrderModal
          onClose={() => setShowCreate(false)}
          onCreated={(o) => {
            setShowCreate(false)
            setToast(`已建单：${o.customerName}（候选）`)
            setTimeout(() => setToast(null), 3000)
            load()
          }}
        />
      )}

      {error && <div className="mx-6 mt-3 text-body-sm text-red-600 bg-red-50 rounded px-3 py-2">⚠ {error}</div>}
      {toast && <div className="mx-6 mt-3 text-body-sm text-green-700 bg-green-50 rounded px-3 py-2">✓ {toast}</div>}

      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        {loading ? (
          <div className="text-body-sm text-text-muted py-12 text-center">加载中…</div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 text-text-muted py-16">
            <span className="material-symbols-outlined" style={{ fontSize: '40px' }}>inbox</span>
            <p className="text-body-md text-text-main">
              {query ? '没有匹配的待申领工单' : `暂无${pool === 'register' ? '挂号' : '其他绿通'}待申领工单`}
            </p>
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
            {visible.map((o) => (
              <ClaimCard
                key={o.id}
                order={o}
                claiming={claimingId === o.id}
                disabled={claimingId != null}
                onClaim={() => doClaim(o)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function PoolTab({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={
        'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-body-sm transition-colors ' +
        (active ? 'bg-white text-primary shadow-sm font-medium' : 'text-text-muted hover:text-text-main')
      }
    >
      {label}
      <span className={'text-label-caps px-1.5 rounded-full ' + (active ? 'bg-primary/10 text-primary' : 'bg-surface-container text-text-muted')}>
        {count}
      </span>
    </button>
  )
}

function ClaimCard({ order, claiming, disabled, onClaim }: { order: Order; claiming: boolean; disabled: boolean; onClaim: () => void }): React.JSX.Element {
  const src = sourceStyle(order)
  const applicationNo = applicationNoOf(order)
  const product = productOf(order)
  const poolTime = poolTimeOf(order)

  return (
    <div className="bg-white rounded-lg border border-border-subtle p-3.5 flex flex-col gap-2.5 hover:shadow-sm transition-shadow">
      {/* 头：客户 + 业务 chip + 来源 */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-body-md font-semibold text-text-main truncate">{order.customerName || '未知客户'}</span>
        <span className={'text-label-caps px-1.5 py-0.5 rounded ' + bizChipClass(order)}>{bizType(order)}</span>
        <span className={'inline-flex items-center gap-0.5 text-label-caps ml-auto ' + src.text}>
          <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>verified</span>
          {src.label}
        </span>
      </div>

      {/* 单号区：订单号 + 申请号（完整、等宽、可复制） */}
      <div className="grid grid-cols-1 gap-1 bg-surface-bg rounded-md px-2.5 py-2 border border-border-subtle">
        <CopyRow label="订单号" value={order.sourceOrderNo} />
        <CopyRow label="申请号" value={applicationNo} />
      </div>

      {/* 业务细节 */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-body-sm">
        <Field icon="local_hospital" value={order.hospital ? order.hospital + (order.dept ? ` · ${order.dept}` : '') : '医院待定'} />
        <Field icon="medical_services" value={product || bizType(order)} />
        {order.customerPhone && <Field icon="call" value={order.customerPhone} />}
        <Field icon="schedule" value={poolTime ? `入池 ${monthDay(poolTime)}` : '—'} />
      </div>

      {/* 申领 */}
      <div className="flex justify-end pt-0.5">
        <button
          onClick={onClaim}
          disabled={disabled}
          className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-md bg-primary text-white text-body-sm font-semibold hover:bg-primary/90 disabled:opacity-50"
        >
          <span className={'material-symbols-outlined ' + (claiming ? 'animate-spin' : '')} style={{ fontSize: '15px' }}>
            {claiming ? 'progress_activity' : 'how_to_reg'}
          </span>
          {claiming ? '申领中…' : '申领'}
        </button>
      </div>
    </div>
  )
}

function CopyRow({ label, value }: { label: string; value: string | null }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    if (!value) return
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-label-caps text-text-muted w-10 shrink-0">{label}</span>
      <span className="font-mono-data text-body-sm text-text-main truncate flex-1" title={value || ''}>
        {value || '—'}
      </span>
      {value && (
        <button onClick={copy} title="复制" className="shrink-0 text-text-muted hover:text-primary">
          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>{copied ? 'check' : 'content_copy'}</span>
        </button>
      )}
    </div>
  )
}

function Field({ icon, value }: { icon: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 text-text-muted min-w-0">
      <span className="material-symbols-outlined shrink-0" style={{ fontSize: '14px' }}>{icon}</span>
      <span className="truncate" title={value}>{value}</span>
    </div>
  )
}

function SourceChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={
        'px-2.5 py-0.5 rounded-full text-body-sm border transition-colors ' +
        (active ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle hover:text-primary')
      }
    >
      {label}
    </button>
  )
}

function CreateOrderModal({ onClose, onCreated }: { onClose: () => void; onCreated: (o: Order) => void }): React.JSX.Element {
  const [form, setForm] = useState<CreateOrderInput>({ source: 'taikang', customerName: '' })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (k: keyof CreateOrderInput, v: string): void => setForm((f) => ({ ...f, [k]: v }))

  const submit = (): void => {
    if (!form.customerName.trim()) {
      setErr('请填写客户姓名')
      return
    }
    setSaving(true)
    setErr(null)
    createOrder(form)
      .then(onCreated)
      .catch((e) => setErr(e instanceof Error ? e.message : '建单失败'))
      .finally(() => setSaving(false))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-[420px] max-w-[92vw] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-h3-title text-text-main">手工建单</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-main">
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>close</span>
          </button>
        </div>
        <div className="space-y-3">
          <Labeled label="来源 *">
            <select
              value={form.source}
              onChange={(e) => set('source', e.target.value)}
              className="w-full px-3 py-2 bg-surface-bg border border-border-subtle rounded-lg text-body-md focus:outline-none focus:border-primary"
            >
              {SOURCE_OPTIONS.map((s) => (
                <option key={s.code} value={s.code}>{s.label}</option>
              ))}
            </select>
          </Labeled>
          <Labeled label="客户姓名 *">
            <Input value={form.customerName} onChange={(v) => set('customerName', v)} placeholder="客户姓名" />
          </Labeled>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="业务类型">
              <Input value={form.serviceType || ''} onChange={(v) => set('serviceType', v)} placeholder="如 挂号协助 / 住院" />
            </Labeled>
            <Labeled label="手机号">
              <Input value={form.customerPhone || ''} onChange={(v) => set('customerPhone', v)} placeholder="选填" />
            </Labeled>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="医院">
              <Input value={form.hospital || ''} onChange={(v) => set('hospital', v)} placeholder="选填" />
            </Labeled>
            <Labeled label="科室">
              <Input value={form.dept || ''} onChange={(v) => set('dept', v)} placeholder="选填" />
            </Labeled>
          </div>
          {err && <div className="text-body-sm text-red-600">⚠ {err}</div>}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-3 py-1.5 rounded text-body-sm border border-border-subtle text-text-muted hover:bg-surface-container-low">取消</button>
          <button
            onClick={submit}
            disabled={saving}
            className="px-4 py-1.5 rounded bg-primary text-white text-body-sm font-semibold hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? '建单中…' : '建单'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="block">
      <span className="block text-label-caps text-text-muted mb-1">{label}</span>
      {children}
    </label>
  )
}

function Input({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }): React.JSX.Element {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full px-3 py-2 bg-surface-bg border border-border-subtle rounded-lg text-body-md focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
    />
  )
}
