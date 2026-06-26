CREATE TABLE IF NOT EXISTS "application_briefs" (
  "id" SERIAL PRIMARY KEY,
  "application_no" TEXT NOT NULL,
  "brief_json" JSONB,
  "brief_updated_at" TIMESTAMP(3),
  "brief_last_msg_id" INTEGER,
  "brief_last_call_id" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "application_briefs_application_no_key"
  ON "application_briefs" ("application_no");
