import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { getHuanyuWriterPool } from '../huanyuMysqlPush.js'

const cancellationRemark = '监控到泰康系统该订单状态为已取消，同步寰宇系统订单状态为已取消'

/** 按 B 端订单号在一个事务中更新关联的 ABI 订单；调用方负责确认泰康取消状态和去重。 */
export async function cancelTaikangRemoteOrders(sourceOrderNo: string, supplied?: PoolConnection): Promise<number> {
  const source = sourceOrderNo.trim()
  if (!source || source.length > 50) throw new Error('泰康订单号无效')
  const connection = supplied ?? await getHuanyuWriterPool().getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT DDBH, DDFWBZ FROM HY_FACT_DDCX_NEW WHERE BDQD_DDBH = ? FOR UPDATE', [source]
    )
    if (!rows.length) throw new Error('未找到关联的寰宇订单')
    const updates = rows.map(row => {
      const original = row.DDFWBZ == null ? '' : String(row.DDFWBZ)
      const remark = original.includes(cancellationRemark) ? original : `${original}${original ? '\n' : ''}${cancellationRemark}`
      if (Array.from(remark).length > 2000) throw new Error('订单备注空间不足，无法追加取消说明')
      return { id: String(row.DDBH), remark }
    })
    for (const row of updates) {
      const [result] = await connection.execute<ResultSetHeader>(
        'UPDATE HY_FACT_DDCX_NEW SET DD_state = ?, DDJE = ?, DDFWBZ = ? WHERE DDBH = ? AND BDQD_DDBH = ?',
        ['已取消', 0, row.remark, row.id, source]
      )
      if (result.affectedRows !== 1) throw new Error('寰宇订单关联已发生变化')
    }
    await connection.commit()
    return updates.length
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    if (!supplied) connection.release()
  }
}
