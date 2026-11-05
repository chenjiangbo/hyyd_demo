import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { confirmPetImageOrder, dismissPetImage } from './petImageConfirmation.js'

async function run(): Promise<void> {
  const prisma = new PrismaClient()
  try {
    await prisma.$executeRawUnsafe('CREATE TABLE pet_image_analysis_records (id integer PRIMARY KEY, employee_id integer NOT NULL, order_id integer, image_analysis jsonb, registration_match jsonb, updated_at timestamp NOT NULL DEFAULT NOW())')
    const analysis = JSON.stringify({ imageType: '挂号凭证' })
    const match = JSON.stringify({ candidateApplications: [{ applicationNo: 'APP1', orders: [{ orderId: 10 }] }] })
    await prisma.$executeRawUnsafe('INSERT INTO pet_image_analysis_records (id,employee_id,image_analysis,registration_match) VALUES (1,1,$1::jsonb,$2::jsonb),(2,1,$1::jsonb,$2::jsonb)', analysis, match)
    assert.equal(await dismissPetImage(prisma, 1, 2), 0)
    assert.equal(await dismissPetImage(prisma, 1, 1), 1)
    assert.equal(await confirmPetImageOrder(prisma, { recordId: 1, employeeId: 1, applicationNo: 'APP2', orderId: 20, manualSelection: true }), 0)
    assert.equal(await confirmPetImageOrder(prisma, { recordId: 2, employeeId: 1, applicationNo: 'APP2', orderId: 20, manualSelection: false }), 0)
    assert.equal(await confirmPetImageOrder(prisma, { recordId: 2, employeeId: 1, applicationNo: 'APP2', orderId: 20, manualSelection: true }), 1)
    assert.equal(await confirmPetImageOrder(prisma, { recordId: 2, employeeId: 1, applicationNo: 'APP2', orderId: 20, manualSelection: true }), 1)
    assert.equal(await confirmPetImageOrder(prisma, { recordId: 2, employeeId: 1, applicationNo: 'APP3', orderId: 30, manualSelection: true }), 0)
    assert.equal(await dismissPetImage(prisma, 2, 1), 0)
    const rows = await prisma.$queryRawUnsafe<Array<{ id: number; order_id: number | null; registration_match: { managerResolution?: { status: string }; confirmedSelection?: { selectionSource: string } } }>>('SELECT id, order_id, registration_match FROM pet_image_analysis_records ORDER BY id')
    assert.equal(rows[0].registration_match.managerResolution?.status, 'manager_not_applicable')
    assert.equal(rows[0].order_id, null)
    assert.equal(rows[1].order_id, 20)
    assert.equal(rows[1].registration_match.confirmedSelection?.selectionSource, 'order_list')
    console.log('petImageConfirmation: ownership, manual choice, idempotency and dismissal passed')
  } finally { await prisma.$disconnect() }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
