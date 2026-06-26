ALTER TABLE "messages" ADD COLUMN "application_no" TEXT;
ALTER TABLE "calls" ADD COLUMN "application_no" TEXT;

CREATE INDEX "messages_employee_id_application_no_sort_time_idx"
  ON "messages"("employee_id", "application_no", "sort_time");

CREATE INDEX "calls_employee_id_application_no_started_at_idx"
  ON "calls"("employee_id", "application_no", "started_at");
