import type { PrismaClient, Prisma } from '@prisma/client'

const KEY = 'call_upload_reminder_employee_ids'
type Db = PrismaClient | Prisma.TransactionClient

export async function getCallUploadReminderEmployees(db: Db): Promise<number[]> {
  const rows = await db.$queryRaw<Array<{ value: unknown }>>`SELECT value FROM sys_settings WHERE key=${KEY}`
  const value = rows[0]?.value
  if (value == null) return []
  if (!Array.isArray(value) || value.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('通话上传提醒人员配置无效')
  return [...new Set(value as number[])]
}

export async function expireUnselectedCallUploadReminders(db: Db, employeeIds: number[]): Promise<void> {
  await db.$executeRaw`UPDATE order_reminders SET status='expired', updated_at=NOW(),
      extra_data=COALESCE(extra_data,'{}'::jsonb) || '{"callUploadConfigRemoved":true}'::jsonb
    WHERE type='upload_recording' AND status IN ('pending','unread')
      AND extra_data->>'reminderType'='call_upload_reminder'
      AND NOT (employee_id = ANY(${employeeIds}::int[]))`
}

export async function saveCallUploadReminderEmployees(prisma: PrismaClient, employeeIds: unknown): Promise<number[]> {
  if (!Array.isArray(employeeIds) || employeeIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('请选择有效的员工')
  const ids = [...new Set(employeeIds as number[])]
  return prisma.$transaction(async tx => {
    const employees = await tx.employee.findMany({ where: { id: { in: ids }, enabled: 1 }, select: { id: true } })
    if (employees.length !== ids.length) throw new Error('所选员工不存在或已停用，请刷新后重试')
    await tx.$executeRaw`INSERT INTO sys_settings (key,value,updated_at) VALUES (${KEY},${JSON.stringify(ids)}::jsonb,NOW())
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`
    await expireUnselectedCallUploadReminders(tx, ids)
    return ids
  })
}
