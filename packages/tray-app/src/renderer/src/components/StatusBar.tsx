import { useEffect, useState } from 'react'
import { getClientConfig, type Presence } from '../api/client'

interface Props {
  backendOk: boolean | null
  presence?: Presence | null
}

export default function StatusBar({ backendOk, presence }: Props): React.JSX.Element {
  const [config, setConfig] = useState(getClientConfig())
  const [matCounts, setMatCounts] = useState<MaterialSyncCounts | null>(null)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (window.api?.materialsStatus) {
        const c = await window.api.materialsStatus().catch(() => null)
        if (!cancelled && c) setMatCounts(c)
      }
    }
    tick().catch(() => {})
    const timer = setInterval(() => tick().catch(() => {}), 5000)
    const configTimer = setInterval(() => setConfig(getClientConfig()), 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
      clearInterval(configTimer)
    }
  }, [])

  const dot =
    backendOk === null
      ? 'bg-slate-400'
      : backendOk
        ? 'bg-emerald-500'
        : 'bg-red-500'
  const text =
    backendOk === null ? '连接中…' : backendOk ? '后端已连接' : '后端无响应'

  // 插件状态
  const extDot = !presence?.extConnected
    ? 'bg-slate-400'
    : presence.taikangTabOpen
      ? 'bg-emerald-500'
      : 'bg-amber-500'
  const extText = !presence?.extConnected
    ? '插件未连接'
    : presence.taikangTabOpen
      ? '插件在线'
      : '插件在线但未打开泰康'

  // 泰康保活：插件每 5 分钟拉一次个人池，这个动作本身在帮泰康会话续期；
  // 若插件检测到接口 401 / TOKEN_EXPIRED，会上报 tokenOk=false，
  // 这时我们点红 + 在 PresenceBanner 上弹红条提醒员工去重登。
  const tokenOk = presence?.tokenOk
  const tokenDot =
    tokenOk === undefined || tokenOk === null
      ? 'bg-slate-400'
      : tokenOk
        ? 'bg-emerald-500'
        : 'bg-red-500'
  const tokenText =
    tokenOk === undefined || tokenOk === null
      ? '泰康保活: 待首次检测'
      : tokenOk
        ? `泰康保活: 正常${presence?.tokenLastCheckAt ? ` (${new Date(presence.tokenLastCheckAt).toLocaleTimeString('zh-CN')})` : ''}`
        : `泰康保活: 失效，请重新登录${presence?.tokenReason ? ` (${presence.tokenReason})` : ''}`
  const mobileLastSeen = presence?.mobileLastSeenAt
    ? new Date(presence.mobileLastSeenAt).toLocaleTimeString('zh-CN')
    : '无'
  const mobileDot =
    presence?.mobileState === 'active'
      ? 'bg-emerald-500'
      : presence?.mobileState === 'background'
        ? 'bg-amber-500'
        : 'bg-red-500'
  const mobileText =
    presence?.mobileState === 'active'
      ? '移动端在线采集中'
      : presence?.mobileState === 'background'
        ? '移动端后台等待中'
        : '移动端需要打开 App'

  return (
    <footer className="border-t border-line bg-surface px-5 py-2 flex items-center justify-between text-xs text-fg-muted shrink-0">
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1.5">
          <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
          {text}
        </span>
        <span className="flex items-center gap-1.5">
          <span className={`inline-block w-2 h-2 rounded-full ${extDot}`} />
          {extText}
        </span>
        <span className="flex items-center gap-1.5" title={tokenText}>
          <span className={`inline-block w-2 h-2 rounded-full ${tokenDot}`} />
          {tokenText}
        </span>
        <span className="flex items-center gap-1.5" title={`最后联系: ${mobileLastSeen} · 来源: ${presence?.mobileHeartbeatSource ?? '无'} · Android 后台不保证持续心跳，红色表示需要打开 App 触发补传`}>
          <span className={`inline-block w-2 h-2 rounded-full ${mobileDot}`} />
          {mobileText}
        </span>
        <MaterialSyncBadge counts={matCounts} />
        <span className="text-fg-subtle">{config.backendUrl}</span>
      </div>
      <div className="text-fg-subtle">员工 {config.employeeCode}</div>
    </footer>
  )
}

function MaterialSyncBadge({ counts }: { counts: MaterialSyncCounts | null }): React.JSX.Element | null {
  if (!counts) return null
  const queue = counts.pending + counts.syncing + counts.pendingDelete
  if (counts.failed === 0 && queue === 0) return null
  if (counts.failed > 0) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
        <span>素材同步失败 {counts.failed}</span>
        <button
          type="button"
          title="把这些失败的素材重新加入同步队列再试一次"
          onClick={async () => {
            await window.api?.materialsRetryFailed?.()
          }}
          className="text-[11px] px-1.5 py-0.5 rounded ring-1 ring-line bg-surface hover:bg-surface-2 text-fg-muted"
        >
          重试
        </button>
        <button
          type="button"
          title="放弃这些失败的素材（仅清本地、不上传）"
          onClick={async () => {
            if (!confirm(`将丢弃 ${counts.failed} 条同步失败的素材，本地与服务器都不会保留。确定？`))
              return
            await window.api?.materialsDiscardFailed?.()
          }}
          className="text-[11px] px-1.5 py-0.5 rounded ring-1 ring-line bg-surface hover:bg-red-50 hover:text-danger hover:ring-danger/40"
        >
          丢弃
        </button>
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1.5" title="后台正在上传素材到后端">
      <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
      素材同步中 {queue}
    </span>
  )
}
