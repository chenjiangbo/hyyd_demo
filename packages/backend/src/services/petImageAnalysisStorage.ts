import type { PrismaClient } from '@prisma/client'
import type { Client } from 'minio'

/** Save the image before analysis so the analysis record can be inspected later. */
export async function storePetAnalysisImage(
  prisma: Pick<PrismaClient, '$executeRaw'>,
  minio: Pick<Client, 'putObject' | 'removeObject'>,
  employeeId: number,
  recordId: number,
  image: Buffer,
  mimeType: string,
  onCleanupError: (error: unknown) => void
): Promise<void> {
  if (image.length === 0) throw new Error('图片内容为空')
  const bucket = 'materials'
  const key = `pet-image-analysis/${employeeId}/${recordId}`
  await minio.putObject(bucket, key, image, image.length, { 'Content-Type': mimeType })
  try {
    const updated = await prisma.$executeRaw`
      UPDATE pet_image_analysis_records SET image_storage_key = ${key}, image_mime_type = ${mimeType}, updated_at = NOW()
      WHERE id = ${recordId} AND employee_id = ${employeeId}
    `
    if (updated !== 1) throw new Error('图片记录不存在或不属于当前员工')
  } catch (error) {
    await minio.removeObject(bucket, key).catch(onCleanupError)
    throw error
  }
}
