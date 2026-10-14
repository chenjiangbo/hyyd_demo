CREATE TABLE IF NOT EXISTS "order_huanyu_sync_logs" (
  "id" BIGSERIAL PRIMARY KEY,
  "order_id" INTEGER NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "source_order_no" VARCHAR(100) NOT NULL,
  "pool" VARCHAR(20) NOT NULL,
  "assigned_employee_id" INTEGER REFERENCES "employees"("id") ON DELETE SET NULL,
  "assigned_employee_name" VARCHAR(100),
  "action" VARCHAR(40) NOT NULL,
  "huanyu_order_no" VARCHAR(100),
  "error_message" TEXT,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "order_huanyu_sync_logs_order_created_idx"
  ON "order_huanyu_sync_logs" ("order_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "order_huanyu_sync_claims" (
  "order_id" INTEGER PRIMARY KEY REFERENCES "orders"("id") ON DELETE CASCADE,
  "claimed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);