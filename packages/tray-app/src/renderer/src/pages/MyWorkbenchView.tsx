import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, getClientConfig, isEmployeeConfigured, type Order } from '../api/client'
import OrderDetailModal from '../components/OrderDetailModal'

// 工作台只展示"已被申领到当前员工"的个人池订单。
// 子 tab 按业务大类分：
//   - 挂号协助 (poolType=register)
//   - 绿通业务 (poolType=general) —— 陪诊 / 住院 / ...
// 列表以紧凑表格呈现，单行高度，挂号 / 绿通列字段略有差异。
// 数据全部从泰康原文透传（rawJson），未脱敏。

type PoolTab = 'register' | 'general'

export default function MyWorkbenchView(): React.JSX.Element {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [pool, setPool] = useState<PoolTab>('register')
  const [selected, setSelected] = useState<Order | null>(null)

  const refresh = useCallback(async () => {
    // 员工 ID 未配置时不发请求 —— 否则后端要么报错、要么按"无过滤"返回全部
    // 订单，两种都误导。让员工先去设置页填。
    if (!isEmployeeConfigured()) {
      setOrders([])
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await api.listOrders({
        assignedEmployeeCode: getClientConfig().employeeCode
      })
      data.sort(
        (a, b) =>
          new Date(b.claimedAt).getTime() - new Date(a.claimedAt).getTime()
      )
      setOrders(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // 按池分组：插件给的 rawJson.poolType；老数据没标签的兜底归到绿通
  const byPool = useMemo(() => {
    const reg: Order[] = []
    const gen: Order[] = []
    for (const o of orders) {
      const p = (o.rawJson as any)?.poolType
      if (p === 'register') reg.push(o)
      else gen.push(o)
    }
    return { register: reg, general: gen }
  }, [orders])

  const currentPoolOrders = pool === 'register' ? byPool.register : byPool.general

  const filtered = useMemo(() => {
    let list = currentPoolOrders
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter((o) => {
        const raw = (o.rawJson ?? {}) as Record<string, any>
        return (
          o.sourceOrderNo.toLowerCase().includes(q) ||
          (raw.applyNo ?? '').toString().toLowerCase().includes(q) ||
          o.customerName.toLowerCase().includes(q) ||
          (o.customerPhone ?? '').toLowerCase().includes(q) ||
          (o.hospital ?? '').toLowerCase().includes(q) ||
          (o.doctor ?? '').toLowerCase().includes(q)
        )
      })
    }
    return list
  }, [currentPoolOrders, query])

  const employeeCode = getClientConfig().employeeCode

  return (
    <div className="h-full flex flex-col">
      {/* 顶部信息条 */}
      <header className="shrink-0 px-6 pt-5 pb-3">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-fg">我的工作台</h1>
            <p className="text-xs text-fg-muted mt-1">
              员工 <span className="font-mono">{employeeCode}</span> 名下个人池订单，按申领时间倒序
            </p>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className="h-8 px-3 text-[13px] rounded ring-1 ring-line bg-surface text-fg hover:bg-surface-2 disabled:opacity-50 transition-colors"
          >
            {loading ? '刷新中…' : '🔄 刷新'}
          </button>
        </div>

        {/* 业务子 tab */}
        <div className="mt-4 flex items-center gap-1 border-b border-line">
          <PoolTabBtn
            label="挂号协助"
            count={byPool.register.length}
            active={pool === 'register'}
            onClick={() => setPool('register')}
          />
          <PoolTabBtn
            label="绿通业务"
            count={byPool.general.length}
            active={pool === 'general'}
            onClick={() => setPool('general')}
          />
        </div>

        {/* 搜索 */}
        <div className="mt-3 flex items-center gap-2">
          <div className="flex-1" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索订单号 / 申请号 / 客户 / 手机号 / 医院 / 医生"
            className="h-8 w-96 px-3 text-[13px] rounded bg-surface ring-1 ring-line focus:ring-accent text-fg placeholder-fg-subtle outline-none transition-colors"
          />
        </div>
      </header>

      {error && (
        <div className="mx-6 mb-2 px-4 py-2 bg-red-50 border border-red-200 text-sm text-red-700 rounded">
          ❌ {error}
        </div>
      )}

      {/* 表格 */}
      <main className="flex-1 overflow-auto px-6 pb-6">
        {filtered.length === 0 ? (
          <EmptyHint loading={loading} hasAny={currentPoolOrders.length > 0} pool={pool} />
        ) : pool === 'register' ? (
          <RegisterTable orders={filtered} onPick={setSelected} />
        ) : (
          <GeneralTable orders={filtered} onPick={setSelected} />
        )}
      </main>

      {selected && (
        <OrderDetailModal
          order={selected}
          onClose={() => {
            setSelected(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────
//  顶部组件
// ────────────────────────────────────────────────────────────────

function PoolTabBtn({
  label,
  count,
  active,
  onClick
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'px-3 h-9 text-[13px] -mb-px border-b-2 transition-colors',
        active
          ? 'border-accent text-fg font-medium'
          : 'border-transparent text-fg-muted hover:text-fg'
      ].join(' ')}
    >
      {label}
      <span className="ml-1.5 text-fg-subtle text-[11px]">({count})</span>
    </button>
  )
}

// ────────────────────────────────────────────────────────────────
//  挂号协助 表
// ────────────────────────────────────────────────────────────────

function RegisterTable({
  orders,
  onPick
}: {
  orders: Order[]
  onPick: (o: Order) => void
}): React.JSX.Element {
  return (
    <div className="ring-1 ring-line rounded-md overflow-hidden bg-surface">
      <table className="w-full text-[12px] table-fixed">
        <thead className="bg-surface-2 text-fg-muted">
          <tr className="text-left">
            <Th className="w-6"></Th>
            <Th className="w-[150px]">订单号</Th>
            <Th className="w-[150px]">申请号</Th>
            <Th className="w-[80px]">客户</Th>
            <Th className="w-[110px]">手机号</Th>
            <Th>医院 · 科室 · 医生</Th>
            <Th className="w-[110px]">就诊日期</Th>
            <Th className="w-[100px]">状态</Th>
            <Th className="w-[70px]">申请</Th>
            <Th className="w-[70px]">申领</Th>
            <Th className="w-[130px]">素材</Th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const r = (o.rawJson ?? {}) as Record<string, any>
            return (
              <tr
                key={o.id}
                onClick={() => onPick(o)}
                className="border-t border-line hover:bg-surface-2 cursor-pointer"
              >
                <Td>
                  <DotCell recorded={o.materialCount > 0} />
                </Td>
                <Td mono>{o.sourceOrderNo}</Td>
                <Td mono className="text-fg-muted">{r.applyNo ?? '—'}</Td>
                <Td>{o.customerName}</Td>
                <Td mono>{o.customerPhone ?? '—'}</Td>
                <Td className="truncate">
                  {[o.hospital, o.dept, o.doctor].filter(Boolean).join(' · ') || '—'}
                </Td>
                <Td>{[o.intendDate, o.intendDateAmorpm].filter(Boolean).join(' ') || '—'}</Td>
                <Td>
                  <StatusPill text={o.status} />
                </Td>
                <Td className="text-fg-muted">{formatShortDate(r.applyTime ?? r.applicationDate)}</Td>
                <Td className="text-fg-muted">{formatShortDate(o.claimedAt)}</Td>
                <Td>
                  <MaterialCell o={o} />
                </Td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────
//  绿通业务 表
// ────────────────────────────────────────────────────────────────

function GeneralTable({
  orders,
  onPick
}: {
  orders: Order[]
  onPick: (o: Order) => void
}): React.JSX.Element {
  return (
    <div className="ring-1 ring-line rounded-md overflow-hidden bg-surface">
      <table className="w-full text-[12px] table-fixed">
        <thead className="bg-surface-2 text-fg-muted">
          <tr className="text-left">
            <Th className="w-6"></Th>
            <Th className="w-[150px]">订单号</Th>
            <Th className="w-[150px]">申请号</Th>
            <Th className="w-[80px]">客户</Th>
            <Th className="w-[110px]">手机号</Th>
            <Th className="w-[140px]">业务</Th>
            <Th>医院 · 科室</Th>
            <Th className="w-[100px]">状态</Th>
            <Th className="w-[70px]">申请</Th>
            <Th className="w-[70px]">申领</Th>
            <Th className="w-[130px]">素材</Th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const r = (o.rawJson ?? {}) as Record<string, any>
            // 只显示业务名，方案/套餐放进详情里看就行（用户反馈：列表里"方案"
            // 列大都是同一个"重疾绿通服务"，重复信息浪费列宽）
            const businessName = r.serviceType ?? r.itemName ?? '—'
            return (
              <tr
                key={o.id}
                onClick={() => onPick(o)}
                className="border-t border-line hover:bg-surface-2 cursor-pointer"
              >
                <Td>
                  <DotCell recorded={o.materialCount > 0} />
                </Td>
                <Td mono>{o.sourceOrderNo}</Td>
                <Td mono className="text-fg-muted">{r.applyNo ?? '—'}</Td>
                <Td>{o.customerName}</Td>
                <Td mono>{o.customerPhone ?? '—'}</Td>
                <Td className="truncate">{businessName}</Td>
                <Td className="truncate">
                  {[o.hospital, o.dept].filter(Boolean).join(' · ') || '—'}
                </Td>
                <Td>
                  <StatusPill text={o.status} />
                </Td>
                <Td className="text-fg-muted">{formatShortDate(r.applyTime ?? r.applicationDate)}</Td>
                <Td className="text-fg-muted">{formatShortDate(o.claimedAt)}</Td>
                <Td>
                  <MaterialCell o={o} />
                </Td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────
//  通用单元格 / 小组件
// ────────────────────────────────────────────────────────────────

function Th({
  children,
  className = ''
}: {
  children?: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <th className={`px-2 py-2 font-medium text-[11px] uppercase tracking-wide ${className}`}>
      {children}
    </th>
  )
}

function Td({
  children,
  className = '',
  mono = false
}: {
  children?: React.ReactNode
  className?: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <td
      className={[
        'px-2 py-2 align-middle',
        mono ? 'font-mono text-[11px]' : '',
        className
      ].join(' ')}
    >
      {children}
    </td>
  )
}

function DotCell({ recorded }: { recorded: boolean }): React.JSX.Element {
  return (
    <span
      className={[
        'inline-block w-2 h-2 rounded-full',
        recorded ? 'bg-accent' : 'bg-fg-subtle/40'
      ].join(' ')}
      title={recorded ? '已录入素材' : '尚未录入'}
      aria-hidden
    />
  )
}

function StatusPill({ text }: { text: string | null | undefined }): React.JSX.Element {
  if (!text) return <span className="text-fg-subtle">—</span>
  return (
    <span className="inline-block px-1.5 py-0.5 rounded bg-surface-2 text-fg-muted ring-1 ring-line text-[11px] whitespace-nowrap">
      {text}
    </span>
  )
}

function MaterialCell({ o }: { o: Order }): React.JSX.Element {
  if (o.materialCount === 0) {
    return <span className="text-fg-subtle italic">未录入</span>
  }
  return (
    <span className="flex items-center gap-2 text-fg-muted">
      {o.textCount > 0 && <span title="文字">💬{o.textCount}</span>}
      {o.imageCount > 0 && <span title="图片">📷{o.imageCount}</span>}
      {o.audioCount > 0 && <span title="录音">🎙{o.audioCount}</span>}
      {o.lastMaterialAt && (
        <span className="text-fg-subtle text-[10px]" title={new Date(o.lastMaterialAt).toLocaleString('zh-CN')}>
          · {formatRelative(o.lastMaterialAt)}
        </span>
      )}
    </span>
  )
}

function EmptyHint({
  loading,
  hasAny,
  pool
}: {
  loading: boolean
  hasAny: boolean
  pool: PoolTab
}): React.JSX.Element {
  const { backendUrl, employeeCode } = getClientConfig()
  if (loading) return <p className="text-center text-fg-subtle text-sm py-12">加载中…</p>
  if (!hasAny)
    return (
      <div className="text-center text-sm py-12 max-w-lg mx-auto space-y-3">
        <p className="text-fg-muted">
          当前员工 <span className="font-mono">{employeeCode}</span> 在「
          {pool === 'register' ? '挂号协助' : '绿通业务'}」池里**暂无订单**。
        </p>
        <p className="text-fg-subtle text-[12px] leading-relaxed">
          订单数据全部来自后端服务器（<span className="font-mono">{backendUrl}</span>
          ）。可能原因：
        </p>
        <ul className="text-fg-subtle text-[12px] leading-relaxed text-left list-disc pl-6 space-y-1">
          <li>这位员工本身就没有「{pool === 'register' ? '挂号协助' : '绿通业务'}」这类业务的订单，可以切到另一个 tab 看看</li>
          <li>tray-app 里设的员工 ID 跟 Chrome 插件 popup 里设的<strong>不一致</strong>，去设置 ⚙ 检查</li>
          <li>Chrome 插件还没采过：去 Chrome 打开泰康 ccm.taikang.com 登录，插件每 2 分钟自动采一轮，F5 立刻触发</li>
          <li>后端连不通（看右下角"后端"指示灯）</li>
        </ul>
      </div>
    )
  return (
    <p className="text-center text-fg-subtle text-sm py-12">没有符合搜索条件的订单。</p>
  )
}

// ───── 时间格式化 ─────
function formatRelative(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`
  return new Date(iso).toLocaleDateString('zh-CN')
}

function formatShortDate(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return String(s)
  const today = new Date()
  const sameYear = d.getFullYear() === today.getFullYear()
  return sameYear
    ? d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
    : d.toLocaleDateString('zh-CN', { year: '2-digit', month: '2-digit', day: '2-digit' })
}
