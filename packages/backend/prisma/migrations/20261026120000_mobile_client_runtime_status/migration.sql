ALTER TABLE "calls"
    ADD COLUMN "recording_uploaded_at" TIMESTAMP(3);
CREATE INDEX "calls_employee_recording_uploaded_idx"
    ON "calls"("employee_id", "recording_uploaded_at" DESC);

CREATE TABLE "mobile_client_states" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "installation_id" TEXT NOT NULL,
    "app_version" TEXT NOT NULL,
    "app_visibility" TEXT NOT NULL DEFAULT 'unknown',
    "service_running" BOOLEAN NOT NULL DEFAULT false,
    "service_started_at" TIMESTAMP(3),
    "background_since" TIMESTAMP(3),
    "heartbeat_source" TEXT NOT NULL,
    "last_heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sync_running" BOOLEAN NOT NULL DEFAULT false,
    "sync_started_at" TIMESTAMP(3),
    "sync_stage" TEXT NOT NULL DEFAULT 'idle',
    "recordings_total" INTEGER NOT NULL DEFAULT 0,
    "recordings_processed" INTEGER NOT NULL DEFAULT 0,
    "recordings_uploaded" INTEGER NOT NULL DEFAULT 0,
    "recordings_failed" INTEGER NOT NULL DEFAULT 0,
    "current_recording_name" TEXT,
    "last_error" TEXT,

    CONSTRAINT "mobile_client_states_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mobile_client_events" (
    "id" BIGSERIAL NOT NULL,
    "client_state_id" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "details" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mobile_client_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mobile_client_states_employee_installation_key"
    ON "mobile_client_states"("employee_id", "installation_id");
CREATE INDEX "mobile_client_states_employee_seen_idx"
    ON "mobile_client_states"("employee_id", "last_heartbeat_at" DESC);
CREATE INDEX "mobile_client_events_state_time_idx"
    ON "mobile_client_events"("client_state_id", "occurred_at" DESC);

ALTER TABLE "mobile_client_states"
    ADD CONSTRAINT "mobile_client_states_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mobile_client_events"
    ADD CONSTRAINT "mobile_client_events_client_state_id_fkey"
    FOREIGN KEY ("client_state_id") REFERENCES "mobile_client_states"("id") ON DELETE CASCADE ON UPDATE CASCADE;
