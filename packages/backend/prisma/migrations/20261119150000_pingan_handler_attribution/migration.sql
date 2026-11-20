CREATE TABLE "pingan_staff" (
  "pingan_staff_id" VARCHAR(40) PRIMARY KEY,
  "display_name" TEXT,
  "employee_id" INTEGER REFERENCES "employees"("id") ON DELETE SET NULL,
  "first_seen_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL,
  "created_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "pingan_staff_employee_id_last_seen_at_idx"
  ON "pingan_staff" ("employee_id", "last_seen_at" DESC);

ALTER TABLE "pingan_orders"
  ADD COLUMN "handler_user_id" VARCHAR(40),
  ADD COLUMN "handler_name" TEXT,
  ADD COLUMN "attachment_state" VARCHAR(32) NOT NULL DEFAULT 'not_captured',
  ADD COLUMN "attachment_errors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "pingan_orders"
SET "handler_user_id" = CASE
      WHEN "list_json"->>'handlerUserId' ~ '^[0-9]{1,40}$' THEN "list_json"->>'handlerUserId'
      ELSE NULL
    END,
    "handler_name" = NULLIF("list_json"->>'handlerName', ''),
    "employee_id" = NULL;

UPDATE "pingan_orders"
SET "attachment_errors" = ARRAY(
      SELECT issue FROM unnest("errors") AS issue
      WHERE issue ILIKE '%附件%' OR issue ILIKE '%文件键%'
    ),
    "attachment_state" = CASE
      WHEN "capture_state" = 'complete' THEN 'complete'
      WHEN EXISTS (
        SELECT 1 FROM unnest("errors") AS issue
        WHERE issue ILIKE '%附件%' OR issue ILIKE '%文件键%'
      ) THEN 'partial_failure'
      ELSE 'not_captured'
    END;

INSERT INTO "pingan_staff" ("pingan_staff_id", "display_name", "first_seen_at", "last_seen_at")
SELECT DISTINCT ON ("handler_user_id")
  "handler_user_id",
  NULLIF("handler_name", ''),
  MIN("first_seen_at") OVER (PARTITION BY "handler_user_id"),
  MAX("last_seen_at") OVER (PARTITION BY "handler_user_id")
FROM "pingan_orders"
WHERE "handler_user_id" IS NOT NULL
ORDER BY "handler_user_id", "last_seen_at" DESC;

ALTER TABLE "pingan_orders"
  ADD CONSTRAINT "pingan_orders_handler_user_id_fkey"
    FOREIGN KEY ("handler_user_id") REFERENCES "pingan_staff"("pingan_staff_id") ON DELETE SET NULL;

CREATE INDEX "pingan_orders_handler_user_id_last_seen_at_idx"
  ON "pingan_orders" ("handler_user_id", "last_seen_at" DESC);

DROP INDEX IF EXISTS "pingan_accounts_employee_id_last_seen_at_idx";
ALTER TABLE "pingan_accounts" DROP COLUMN "employee_id";

DROP INDEX IF EXISTS "pingan_collection_runs_employee_id_started_at_idx";
ALTER TABLE "pingan_collection_runs" DROP COLUMN "employee_id";
