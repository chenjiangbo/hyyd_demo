CREATE TABLE "pingan_accounts" (
  "pingan_user_id" VARCHAR(40) PRIMARY KEY,
  "display_name" TEXT,
  "employee_id" INTEGER REFERENCES "employees"("id") ON DELETE SET NULL,
  "first_seen_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL,
  "created_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "pingan_accounts_employee_id_last_seen_at_idx"
  ON "pingan_accounts" ("employee_id", "last_seen_at" DESC);

CREATE TABLE "pingan_collection_runs" (
  "id" UUID PRIMARY KEY,
  "pingan_user_id" VARCHAR(40) NOT NULL REFERENCES "pingan_accounts"("pingan_user_id") ON DELETE CASCADE,
  "employee_id" INTEGER REFERENCES "employees"("id") ON DELETE SET NULL,
  "install_date" DATE NOT NULL,
  "scan_start_date" DATE NOT NULL,
  "scan_end_date" DATE NOT NULL,
  "started_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL,
  "completed_at" TIMESTAMP(3) WITHOUT TIME ZONE,
  "state" VARCHAR(32) NOT NULL,
  "unique_order_count" INTEGER,
  "list_rows" INTEGER,
  "detail_count" INTEGER,
  "decrypted_field_count" INTEGER,
  "attachment_count" INTEGER,
  "error_count" INTEGER,
  "error" TEXT,
  "created_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "pingan_collection_runs_started_at_id_idx"
  ON "pingan_collection_runs" ("started_at" DESC, "id" DESC);
CREATE INDEX "pingan_collection_runs_employee_id_started_at_idx"
  ON "pingan_collection_runs" ("employee_id", "started_at" DESC);

CREATE TABLE "pingan_collection_pages" (
  "run_id" UUID NOT NULL REFERENCES "pingan_collection_runs"("id") ON DELETE CASCADE,
  "order_type" VARCHAR(80) NOT NULL,
  "page_num" INTEGER NOT NULL,
  "page_count" INTEGER NOT NULL,
  "page_size" INTEGER NOT NULL,
  "total" INTEGER NOT NULL,
  "row_count" INTEGER NOT NULL,
  "state" VARCHAR(32) NOT NULL,
  "captured_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL,
  "completed_at" TIMESTAMP(3) WITHOUT TIME ZONE,
  "query" JSONB NOT NULL,
  PRIMARY KEY ("run_id", "order_type", "page_num")
);

CREATE INDEX "pingan_collection_pages_run_order_type_page_num_idx"
  ON "pingan_collection_pages" ("run_id", "order_type", "page_num");

CREATE TABLE "pingan_orders" (
  "pingan_user_id" VARCHAR(40) NOT NULL REFERENCES "pingan_accounts"("pingan_user_id") ON DELETE CASCADE,
  "order_id" VARCHAR(120) NOT NULL,
  "employee_id" INTEGER REFERENCES "employees"("id") ON DELETE SET NULL,
  "order_type" VARCHAR(80) NOT NULL,
  "order_type_name" VARCHAR(120) NOT NULL,
  "status" VARCHAR(120) NOT NULL DEFAULT '',
  "status_name" VARCHAR(160) NOT NULL DEFAULT '',
  "list_json" JSONB NOT NULL,
  "detail_json" JSONB,
  "decrypted_fields" JSONB NOT NULL,
  "capture_state" VARCHAR(32) NOT NULL,
  "errors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "list_fingerprint" TEXT NOT NULL,
  "detail_fingerprint" TEXT,
  "first_seen_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL,
  "last_seen_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL,
  "created_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("pingan_user_id", "order_id")
);

CREATE INDEX "pingan_orders_employee_id_last_seen_at_order_id_idx"
  ON "pingan_orders" ("employee_id", "last_seen_at" DESC, "order_id");
CREATE INDEX "pingan_orders_order_type_status_last_seen_at_idx"
  ON "pingan_orders" ("order_type", "status", "last_seen_at" DESC);

CREATE TABLE "pingan_order_attachments" (
  "pingan_user_id" VARCHAR(40) NOT NULL,
  "order_id" VARCHAR(120) NOT NULL,
  "attachment_id" VARCHAR(240) NOT NULL,
  "file_name" VARCHAR(500) NOT NULL,
  "file_type" VARCHAR(120) NOT NULL,
  "mime_type" VARCHAR(160) NOT NULL,
  "byte_size" BIGINT NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "minio_bucket" VARCHAR(120) NOT NULL,
  "minio_key" VARCHAR(1000) NOT NULL,
  "captured_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL,
  "created_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("pingan_user_id", "order_id", "attachment_id"),
  CONSTRAINT "pingan_order_attachments_order_fkey"
    FOREIGN KEY ("pingan_user_id", "order_id")
    REFERENCES "pingan_orders"("pingan_user_id", "order_id") ON DELETE CASCADE
);

CREATE INDEX "pingan_order_attachments_pingan_user_id_order_id_idx"
  ON "pingan_order_attachments" ("pingan_user_id", "order_id");
