import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

// 连接 /ws/admin，收到后端推送（新素材/新通话）时让相关 react-query 失效 → 自动重拉。
// 断线自动重连。鉴权靠 httpOnly admin cookie（WebSocket 握手会带上同源 cookie）。
export function useAdminSocket(): void {
  const qc = useQueryClient()

  useEffect(() => {
    let ws: WebSocket | null = null
    let closed = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let pingTimer: ReturnType<typeof setInterval> | undefined

    const connect = (): void => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/ws/admin`)

      ws.onopen = () => {
        // 30s 心跳，保活
        pingTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
        }, 30_000)
      }

      ws.onmessage = (e) => {
        let msg: { type?: string } = {}
        try {
          msg = JSON.parse(e.data)
        } catch {
          return
        }
        if (msg.type === 'material_created') {
          qc.invalidateQueries({ queryKey: ['dashboard'] })
          qc.invalidateQueries({ queryKey: ['materials'] })
          qc.invalidateQueries({ queryKey: ['employees'] })
        } else if (msg.type === 'call_created') {
          qc.invalidateQueries({ queryKey: ['dashboard'] })
          qc.invalidateQueries({ queryKey: ['calls'] })
          qc.invalidateQueries({ queryKey: ['employees'] })
        }
      }

      ws.onclose = () => {
        if (pingTimer) clearInterval(pingTimer)
        if (!closed) retry = setTimeout(connect, 3000) // 3s 后重连
      }
      ws.onerror = () => {
        ws?.close()
      }
    }

    connect()

    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      if (pingTimer) clearInterval(pingTimer)
      ws?.close()
    }
  }, [qc])
}
