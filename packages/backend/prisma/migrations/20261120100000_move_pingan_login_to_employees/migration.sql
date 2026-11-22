BEGIN;

ALTER TABLE "employees"
  ADD COLUMN "pingan_login_user_id" VARCHAR(40),
  ADD COLUMN "pingan_login_display_name" TEXT;

CREATE UNIQUE INDEX "employees_pingan_login_user_id_key"
  ON "employees" ("pingan_login_user_id");

-- Only carry over a binding when the already bound PingAn identity matches exactly.
UPDATE "employees" AS employee
SET "pingan_login_user_id" = account."pingan_user_id",
    "pingan_login_display_name" = account."display_name"
FROM "pingan_accounts" AS account
WHERE employee."pingan_id" = account."pingan_user_id";

ALTER TABLE "pingan_collection_runs"
  ADD COLUMN "collector_employee_id" INTEGER REFERENCES "employees" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD COLUMN "collector_display_name" TEXT;

ALTER TABLE "pingan_orders"
  ADD COLUMN "first_seen_run_id" UUID REFERENCES "pingan_collection_runs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD COLUMN "last_seen_run_id" UUID REFERENCES "pingan_collection_runs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD COLUMN "collector_display_name" TEXT;

ALTER TABLE "pingan_order_attachments"
  ADD COLUMN "upload_run_id" UUID REFERENCES "pingan_collection_runs" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "pingan_collection_runs" AS run
SET "collector_display_name" = account."display_name"
FROM "pingan_accounts" AS account
WHERE run."pingan_user_id" = account."pingan_user_id";

UPDATE "pingan_orders" AS orders
SET "collector_display_name" = account."display_name"
FROM "pingan_accounts" AS account
WHERE orders."pingan_user_id" = account."pingan_user_id";

CREATE INDEX "pingan_collection_runs_collector_employee_id_started_at_idx"
  ON "pingan_collection_runs" ("collector_employee_id", "started_at" DESC);
CREATE INDEX "pingan_collection_runs_pingan_user_id_idx"
  ON "pingan_collection_runs" ("pingan_user_id");

ALTER TABLE "pingan_orders" DROP CONSTRAINT "pingan_orders_pingan_user_id_fkey";
ALTER TABLE "pingan_collection_runs" DROP CONSTRAINT "pingan_collection_runs_pingan_user_id_fkey";

DROP TABLE "pingan_accounts";

COMMIT;
