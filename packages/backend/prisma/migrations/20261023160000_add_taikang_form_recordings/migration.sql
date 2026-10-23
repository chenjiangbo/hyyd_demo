CREATE TABLE "taikang_form_sessions" (
  "id" UUID PRIMARY KEY,
  "employee_id" INTEGER NOT NULL REFERENCES "employees"("id"),
  "taikang_account" TEXT NOT NULL,
  "taikang_user_id" INTEGER NOT NULL,
  "route_kind" TEXT NOT NULL,
  "source_order_no" TEXT,
  "service_name" TEXT,
  "started_at" TIMESTAMP(3) NOT NULL,
  "last_event_at" TIMESTAMP(3) NOT NULL,
  "ended_at" TIMESTAMP(3),
  "event_count" INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX "taikang_form_sessions_started_at_id_idx"
  ON "taikang_form_sessions" ("started_at" DESC, "id" DESC);
CREATE INDEX "taikang_form_sessions_employee_id_started_at_idx"
  ON "taikang_form_sessions" ("employee_id", "started_at" DESC);
CREATE INDEX "taikang_form_sessions_source_order_no_started_at_idx"
  ON "taikang_form_sessions" ("source_order_no", "started_at" DESC);

CREATE TABLE "taikang_form_events" (
  "id" UUID PRIMARY KEY,
  "session_id" UUID NOT NULL REFERENCES "taikang_form_sessions"("id") ON DELETE CASCADE,
  "sequence" INTEGER NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "taikang_form_events_session_id_sequence_key"
  ON "taikang_form_events" ("session_id", "sequence");
CREATE INDEX "taikang_form_events_session_id_occurred_at_idx"
  ON "taikang_form_events" ("session_id", "occurred_at");
