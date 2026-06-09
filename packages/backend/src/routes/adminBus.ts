/**
 * 管理后台实时推送总线。
 *
 * - 持有所有已认证的 /ws/admin 连接。
 * - 员工端在创建素材 / 通话时调用 broadcastAdmin()，把事件推给所有在线管理员。
 * - 单独成模块，避免 routes/api.ts ↔ routes/admin.ts 循环依赖。
 */

export type AdminEvent =
  | { type: 'material_created'; payload: { employeeId: number; orderId: number; materialType: string } }
  | { type: 'call_created'; payload: { employeeId: number; orderId: number | null } }
  | { type: 'connected' }
  | { type: 'pong' }

const sockets = new Set<any>()

export function addAdminSocket(socket: any): void {
  sockets.add(socket)
}

export function removeAdminSocket(socket: any): void {
  sockets.delete(socket)
}

export function adminSocketCount(): number {
  return sockets.size
}

export function broadcastAdmin(evt: AdminEvent): void {
  const msg = JSON.stringify(evt)
  for (const s of sockets) {
    // readyState === 1 即 OPEN
    if (s.readyState === 1) {
      try {
        s.send(msg)
      } catch {
        /* 忽略单连接发送失败 */
      }
    }
  }
}
