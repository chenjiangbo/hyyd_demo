import type { Presence } from '../api/client'

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
  if (!presence.taikangTabOpen) {
    return (
      <Banner color="amber">
        ⚠️ 未检测到泰康标签页。在工作台点"申领"后插件无法点击对应按钮。
        请先在 Chrome 打开 <code className="px-1 bg-amber-100 rounded">https://ccm.taikang.com</code> 并登录。
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
  // pool_reader 没在追踪池页面时也提示一下，避免读者忘了切页面
  if (presence.mode === 'pool_reader' && !presence.trackingPoolPageActive) {
    return (
      <Banner color="blue">
        ℹ️ 当前为 Pool Reader 模式，但未在追踪池页面。请打开
        <code className="px-1 bg-blue-100 rounded">trackIngPoolList</code> 以采集候选订单。
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
