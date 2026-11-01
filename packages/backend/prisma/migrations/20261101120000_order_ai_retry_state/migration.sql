CREATE TABLE "order_ai_retry_state" (
  "order_id" INTEGER PRIMARY KEY REFERENCES "orders"("id") ON DELETE CASCADE,
  "source_key" TEXT NOT NULL,
  "failure_count" INTEGER NOT NULL DEFAULT 0,
  "next_retry_at" TIMESTAMP(3),
  "last_error" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
