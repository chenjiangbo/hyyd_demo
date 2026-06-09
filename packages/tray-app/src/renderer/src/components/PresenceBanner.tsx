import { isEmployeeConfigured, type Presence } from '../api/client'

interface Props {
  presence: Presence | null
  backendOk: boolean | null
}

/**
 * 顶部警告条：根据插件 presence 状态显示
 * 优先级（从高到低）：
 *  - 后端无响应
 *  - 插件 WS 未连接
 *  - 插件未打开泰康标签页（申领指令会失败）
 *  - 插件心跳超时（stale）
 */
export default function PresenceBanner({ presence, backendOk }: Props): React.JSX.Element | null {
  // 优先级最高：员工 ID 未配置，所有业务功能都没法用
  if (!isEmployeeConfigured()) {
    return (
      <Banner color="red">
        🔴 员工 ID 未设置。请点右上角齿轮 ⚙ → 设置，填入员工 ID（必须和 Chrome
        插件、移动端一致），保存后再使用。
      </Banner>
    )
  }
  if (backendOk === false) {
    return (
      <Banner color="red">
        ❌ 后端无响应。请确认后端服务在 Mac 上正常运行（pnpm backend:dev）。
      </Banner>
    )
  }
  if (!presence) return null

  if (!presence.extConnected) {
    return (
      <Banner color="amber">
        ⚠️ 浏览器插件未连接到后端。请确认 Chrome 已打开并加载了寰宇插件，且能访问后端地址。
      </Banner>
    )
  }
  // 插件最近一次拉数据时被泰康拒了（token 过期）。这时插件已经停止采集，
  // 员工必须回 Chrome 重登泰康，登完插件会自动恢复。
  if (presence.tokenOk === false) {
    return (
      <Banner color="red">
        🔒 泰康登录已失效（{presence.tokenReason ?? '会话过期'}）。请到 Chrome 的{' '}
        <code className="px-1 bg-red-100 rounded">ccm.taikang.com</code>{' '}
        标签页重新登录，登录后插件会自动恢复采集。
      </Banner>
    )
  }
  if (!presence.taikangTabOpen) {
    return (
      <Banner color="amber">
        ⚠️ 未检测到泰康标签页。请在 Chrome 打开{' '}
        <code className="px-1 bg-amber-100 rounded">ccm.taikang.com</code> 并保持登录，
        插件每 5 分钟会自动采一次个人池。
      </Banner>
    )
  }
  if (presence.stale) {
    return (
      <Banner color="amber">
        ⚠️ 插件心跳超时（&gt; 30s）。可能 Chrome 已挂起或网络不稳。
      </Banner>
    )
  }
  return null
}

function Banner({
  color,
  children
}: {
  color: 'red' | 'amber' | 'blue'
  children: React.ReactNode
}): React.JSX.Element {
  const styles = {
    red: 'bg-red-50 border-red-200 text-red-800',
    amber: 'bg-amber-50 border-amber-200 text-amber-900',
    blue: 'bg-blue-50 border-blue-200 text-blue-800'
  }[color]
  return (
    <div className={`px-5 py-2.5 text-sm border-b ${styles}`}>{children}</div>
  )
}
