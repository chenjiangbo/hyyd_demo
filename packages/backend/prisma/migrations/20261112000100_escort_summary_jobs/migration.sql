-- Only messages sent after this feature is installed are eligible.
CREATE TABLE escort_summary_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled_since TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO escort_summary_settings (id) VALUES (1);
CREATE TABLE escort_summary_jobs (
  message_id INTEGER PRIMARY KEY REFERENCES native_chat_messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT,
  result JSONB,
  updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX escort_summary_jobs_pending_idx ON escort_summary_jobs (status, next_attempt_at);
