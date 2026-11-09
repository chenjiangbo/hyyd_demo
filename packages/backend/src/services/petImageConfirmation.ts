import type { Prisma } from '@prisma/client'

type QueryClient = Pick<Prisma.TransactionClient, '$executeRaw'>

export async function dismissPetImage(client: QueryClient, id: number, employeeId: number): Promise<number> {
  const resolution = { status: 'manager_not_applicable', confirmedByEmployeeId: employeeId, confirmedAt: new Date().toISOString() }
  return client.$executeRaw`
    UPDATE pet_image_analysis_records
       SET registration_match = jsonb_set(COALESCE(registration_match, '{}'::jsonb), '{managerResolution}', ${JSON.stringify(resolution)}::jsonb, true), updated_at = NOW()
     WHERE id = ${id} AND employee_id = ${employeeId} AND order_id IS NULL
       AND image_analysis->>'imageType' IN ('挂号凭证', '就诊签到记录') AND registration_match IS NOT NULL
  `
}

export async function confirmPetImageOrder(client: QueryClient, input: { recordId: number; employeeId: number; applicationNo: string; orderId: number; manualSelection: boolean }): Promise<number> {
  const { recordId, employeeId, applicationNo, orderId, manualSelection } = input
  const selection = { applicationNo, orderId, selectionSource: manualSelection ? 'order_list' : 'candidate' }
  return client.$executeRaw`
    UPDATE pet_image_analysis_records SET order_id = ${orderId},
      registration_match = jsonb_set(COALESCE(registration_match, '{}'::jsonb), '{confirmedSelection}', ${JSON.stringify(selection)}::jsonb, true), updated_at = NOW()
    WHERE id = ${recordId} AND employee_id = ${employeeId}
      AND image_analysis->>'imageType' IN ('挂号凭证', '就诊签到记录')
      AND (order_id IS NULL OR order_id = ${orderId}) AND registration_match->'managerResolution' IS NULL
      AND (${manualSelection} OR EXISTS (SELECT 1 FROM jsonb_array_elements(registration_match->'candidateApplications') AS candidate
        CROSS JOIN LATERAL jsonb_array_elements(candidate->'orders') AS candidate_order
        WHERE candidate->>'applicationNo' = ${applicationNo} AND candidate_order->>'orderId' = ${String(orderId)}))
  `
}
