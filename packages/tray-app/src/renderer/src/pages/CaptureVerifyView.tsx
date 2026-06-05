import { useCallback, useEffect, useMemo, useState } from 'react'

type Channel = 'wxwork' | 'wechat'

const CHANNELS: { key: Channel; label: string }[] = [
  { key: 'wxwork', label: '企业微信' },
  { key: 'wechat', label: '微信' }
]

function channelLabel(ch: string): string {
  return CHANNELS.find((c) => c.key === ch)?.label ?? ch
}

export default function CaptureVerifyView(): React.JSX.Element {
  const [channel, setChannel] = useState<Channel>('wxwork')
  const [shots, setShots] = useState<CaptureShot[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [imgLoading, setImgLoading] = useState(false)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)

  const load = useCallback(async () => {
    if (!window.api) {
      setError('window.api 不可用（仅打包后的 Windows 客户端可用）')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const list = await window.api.getCaptureShots(channel, 60)
      setShots(list)
      if (list.length > 0) setSelectedPath((p) => p ?? list[0].path)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [channel])

  useEffect(() => {
    setSelectedPath(null)
    setDataUrl(null)
    setNatural(null)
    load()
  }, [load])

  // 加载选中原图
  useEffect(() => {
    let cancelled = false
    if (!selectedPath || !window.api) {
      setDataUrl(null)
      setNatural(null)
      return
    }
    setImgLoading(true)
    setNatural(null)
    window.api
      .getCaptureScreenshot(selectedPath)
      .then((url) => {
        if (!cancelled) setDataUrl(url)
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null)
      })
      .finally(() => {
        if (!cancelled) setImgLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedPath])

  const selected = useMemo(
    () => shots.find((s) => s.path === selectedPath) ?? null,
    [shots, selectedPath]
  )

  const clearAll = useCallback(async () => {
    if (!window.api) return
    if (!window.confirm('确定清空磁盘上所有采集截图？此操作不可恢复。')) return
    setLoading(true)
    try {
      const res = await window.api.clearCaptureShots()
      setSelectedPath(null)
      setDataUrl(null)
      setNatural(null)
      await load()
      window.alert(`已删除 ${res.deleted} 张截图`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [load])

  return (
    <div className="flex h-full">
      {/* 左：截图列表 */}
      <div className="w-72 border-r border-slate-200 flex flex-col bg-white">
        <div className="px-4 py-3 border-b border-slate-200">
          <div className="text-sm font-semibold text-slate-800">
            截图验证 <span className="text-slate-400 font-normal">({shots.length})</span>
          </div>
          <div className="mt-2 flex gap-1">
            {CHANNELS.map((c) => (
              <button
                key={c.key}
                onClick={() => setChannel(c.key)}
                className={`px-3 py-1 text-xs rounded transition ${
                  channel === c.key
                    ? 'bg-emerald-500 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {c.label}
              </button>
            ))}
            <button
              onClick={load}
              className="ml-auto px-3 py-1 text-xs rounded bg-slate-100 text-slate-600 hover:bg-slate-200"
            >
              ↻ 刷新
            </button>
            <button
              onClick={clearAll}
              className="px-3 py-1 text-xs rounded bg-rose-50 text-rose-600 hover:bg-rose-100"
            >
              🗑 清空
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {loading && <div className="px-4 py-3 text-xs text-slate-400">加载中…</div>}
          {error && <div className="px-4 py-3 text-xs text-rose-500">{error}</div>}
          {!loading && !error && shots.length === 0 && (
            <div className="px-4 py-6 text-xs text-slate-400 leading-relaxed">
              暂无截图。请在 Windows 上把{channelLabel(channel)}切到前台停留几秒，
              采集会每 3 秒存一张原图，然后点「刷新」。
            </div>
          )}
          {shots.map((s) => (
            <button
              key={s.path}
              onClick={() => setSelectedPath(s.path)}
              className={`w-full text-left px-4 py-2.5 border-b border-slate-100 text-xs transition ${
                s.path === selectedPath ? 'bg-emerald-50' : 'hover:bg-slate-50'
              }`}
            >
              <div className="font-mono text-slate-700">{s.capturedAt ?? s.fileName}</div>
              <div className="text-slate-400 mt-0.5">{channelLabel(s.channel)}</div>
            </button>
          ))}
        </div>
      </div>

      {/* 右：原图 + 元信息 */}
      <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
        {!selected && (
          <div className="flex-1 flex items-center justify-center text-sm text-slate-400">
            选择左侧一张截图查看原图
          </div>
        )}
        {selected && (
          <>
            <div className="px-5 py-3 border-b border-slate-200 bg-white">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
                <Meta label="截图时间" value={selected.capturedAt ?? '—'} />
                <Meta label="渠道" value={channelLabel(selected.channel)} />
                <Meta
                  label="原始像素尺寸"
                  value={natural ? `${natural.w} × ${natural.h}` : imgLoading ? '加载中…' : '—'}
                  highlight
                />
                <Meta label="文件名" value={selected.fileName} mono />
              </div>
              <div className="mt-2 text-[11px] text-slate-400 leading-relaxed">
                判断要点：①画面是否完整、清晰；②是否只包含{channelLabel(selected.channel)}窗口、
                没有桌面或其它程序；③尺寸是否接近窗口大小（若接近整屏分辨率，可能截多了）。
              </div>
            </div>
            <div className="flex-1 overflow-auto p-5">
              {imgLoading && <div className="text-xs text-slate-400">原图加载中…</div>}
              {!imgLoading && !dataUrl && (
                <div className="text-xs text-rose-500">无法读取原图文件</div>
              )}
              {dataUrl && (
                <img
                  src={dataUrl}
                  alt={selected.fileName}
                  onLoad={(e) =>
                    setNatural({
                      w: e.currentTarget.naturalWidth,
                      h: e.currentTarget.naturalHeight
                    })
                  }
                  className="border border-slate-300 shadow-sm bg-white max-w-none"
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Meta({
  label,
  value,
  highlight,
  mono
}: {
  label: string
  value: string
  highlight?: boolean
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-slate-400">{label}</span>
      <span
        className={`${highlight ? 'text-emerald-600 font-semibold' : 'text-slate-700'} ${
          mono ? 'font-mono' : ''
        }`}
      >
        {value}
      </span>
    </div>
  )
}
