CREATE TABLE IF NOT EXISTS "green_pass_id_card_jobs" (
    "order_id" INTEGER NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
    "updated_at" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "green_pass_id_card_jobs_pkey" PRIMARY KEY ("order_id"),
    CONSTRAINT "green_pass_id_card_jobs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "green_pass_sync_retries" (
    "order_id" INTEGER NOT NULL,
    "updated_at" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "green_pass_sync_retries_pkey" PRIMARY KEY ("order_id"),
    CONSTRAINT "green_pass_sync_retries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
