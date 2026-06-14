-- CreateTable
CREATE TABLE "unmatched_order_refs" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "conversation_name" TEXT NOT NULL,
    "candidate" TEXT NOT NULL,
    "candidate_kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "best_dist" INTEGER,
    "candidate_order_ids" JSONB,
    "screenshot_oss_key" TEXT,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "seen_count" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolved_order_id" INTEGER,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unmatched_order_refs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "unmatched_order_refs_employee_id_candidate_key" ON "unmatched_order_refs"("employee_id", "candidate");

-- AddForeignKey
ALTER TABLE "unmatched_order_refs" ADD CONSTRAINT "unmatched_order_refs_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
