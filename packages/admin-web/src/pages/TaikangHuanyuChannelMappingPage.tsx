import { useEffect, useMemo, useState } from 'react'
import {
  adminApi,
  type HuanyuChannelOption,
  type TaikangHuanyuChannelMapping
} from '../api/client'
import { Card, PageHeader } from '../components/ui'

type Draft = Record<string, { huanyuChannelId: string; enabled: boolean }>

export default function TaikangHuanyuChannelMappingPage(): React.JSX.Element {
  const [mappings, setMappings] = useState<TaikangHuanyuChannelMapping[]>([])
  const [channels, setChannels] = useState<HuanyuChannelOption[]>([])
  const [draft, setDraft] = useState<Draft>({})
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const mergedChannels = useMemo(() => {
    const map = new Map(channels.map((channel) => [channel.id, channel]))
    mappings.forEach((mapping) => {
      if (mapping.huanyuChannelId && !map.has(mapping.huanyuChannelId)) {
        map.set(mapping.huanyuChannelId, { id: mapping.huanyuChannelId, name: mapping.huanyuChannelName || mapping.huanyuChannelId })
      }
    })
    return [...map.values()]
  }, [channels, mappings])

  async function loadMappings(): Promise<void> {
    const data = await adminApi.taikangHuanyuChannelMappings()
    setMappings(data)
    setDraft(Object.fromEntries(data.map((item) => [item.businessKey, {
      huanyuChannelId: item.huanyuChannelId || '', enabled: item.enabled
    }])))
  }

  async function loadChannels(nextSearch = ''): Promise<void> {
    setChannels(await adminApi.huanyuChannels(nextSearch))
  }

  useEffect(() => {
    Promise.all([loadMappings(), loadChannels()])
      .catch((error) => setMessage(error instanceof Error ? error.message : '加载配置失败'))
      .finally(() => setLoading(false))
  }, [])

  async function searchChannels(): Promise<void> {
    try {
      await loadChannels(search.trim())
      setMessage(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '加载 B端渠道失败')
    }
  }

  async function save(mapping: TaikangHuanyuChannelMapping): Promise<void> {
    const value = draft[mapping.businessKey]
    if (!value?.huanyuChannelId) {
      setMessage(`请先为“${mapping.businessName}”选择 B端渠道`)
      return
    }
    setSavingKey(mapping.businessKey)
    setMessage(null)
    try {
      await adminApi.saveTaikangHuanyuChannelMapping(mapping.businessKey, value)
      await loadMappings()
      setMessage(`“${mapping.businessName}”的 B端渠道已保存。后续新建寰宇订单将立即按此配置匹配。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSavingKey(null)
    }
  }

  return (
    <div>
      <PageHeader title="泰康业务渠道配置" subtitle="为泰康绿通、泰康挂号协助选择创建寰宇订单时使用的 B端渠道。" />
      <Card className="mb-4 p-4 text-sm text-fg-muted leading-6">
        <div>渠道下拉数据实时只读自远端 MySQL 维表 <code>dim_hy_qd</code>，保存的是渠道 ID，不依赖名称匹配。</div>
        <div>创建寰宇订单时：泰康业务类型 → 本配置渠道 ID → <code>dim_hy_qd_cp</code> 中服务项目 ID 前四位相同的记录 → 按服务项目名称精确匹配。</div>
        <div className="text-amber-700">配置变更只影响之后新建的寰宇订单；已创建且人工维护过的订单不会被覆盖。</div>
      </Card>

      <Card className="p-4">
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <label className="block text-sm text-fg-muted">
            搜索远端 B端渠道
            <input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void searchChannels() }} placeholder="输入渠道 ID 或名称" className="mt-1 block w-64 rounded border border-line bg-transparent px-2 py-1.5 text-fg outline-none focus:border-accent" />
          </label>
          <button onClick={() => void searchChannels()} className="rounded border border-line px-3 py-1.5 text-sm hover:bg-surface-2">查询渠道</button>
          <button onClick={() => { setSearch(''); void loadChannels() }} className="rounded border border-line px-3 py-1.5 text-sm hover:bg-surface-2">显示默认列表</button>
        </div>

        {message && <div className={`mb-4 rounded px-3 py-2 text-sm ${message.includes('已保存') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>{message}</div>}
        {loading ? <div className="py-10 text-center text-sm text-fg-muted">加载中…</div> : (
          <div className="overflow-x-auto">
            <table className="min-w-[860px] w-full text-left text-sm">
              <thead className="border-b border-line text-fg-muted"><tr><th className="px-2 py-3 font-medium">泰康业务</th><th className="px-2 py-3 font-medium">B端渠道（远端维表）</th><th className="px-2 py-3 font-medium">启用</th><th className="px-2 py-3 font-medium">上次更新</th><th className="px-2 py-3 font-medium"></th></tr></thead>
              <tbody>{mappings.map((mapping) => {
                const value = draft[mapping.businessKey] ?? { huanyuChannelId: '', enabled: true }
                return <tr key={mapping.businessKey} className="border-b border-line/70">
                  <td className="px-2 py-3 font-medium">{mapping.businessName}<div className="mt-1 text-xs font-normal text-fg-subtle">{mapping.businessKey}</div></td>
                  <td className="px-2 py-3"><select value={value.huanyuChannelId} onChange={(event) => setDraft((current) => ({ ...current, [mapping.businessKey]: { ...value, huanyuChannelId: event.target.value } }))} className="w-80 rounded border border-line bg-transparent px-2 py-1.5 outline-none focus:border-accent"><option value="">请选择 B端渠道</option>{mergedChannels.map((channel) => <option key={channel.id} value={channel.id}>{channel.id} · {channel.name}</option>)}</select></td>
                  <td className="px-2 py-3"><label className="inline-flex items-center gap-2"><input type="checkbox" checked={value.enabled} onChange={(event) => setDraft((current) => ({ ...current, [mapping.businessKey]: { ...value, enabled: event.target.checked } }))} /><span>{value.enabled ? '启用' : '停用'}</span></label></td>
                  <td className="px-2 py-3 text-xs text-fg-muted">{new Date(mapping.updatedAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td className="px-2 py-3"><button disabled={savingKey === mapping.businessKey} onClick={() => void save(mapping)} className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60">{savingKey === mapping.businessKey ? '保存中…' : '保存'}</button></td>
                </tr>
              })}</tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
