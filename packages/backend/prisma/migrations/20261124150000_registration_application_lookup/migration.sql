CREATE TABLE IF NOT EXISTS registration_application_lookup (
  source_order_no VARCHAR(50) PRIMARY KEY,
  run_day DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  application_no VARCHAR(50),
  source VARCHAR(20),
  last_error TEXT,
  lease_account VARCHAR(100),
  lease_id VARCHAR(36),
  lease_until TIMESTAMP(3) WITHOUT TIME ZONE,
  updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE registration_application_lookup ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE registration_application_lookup ADD COLUMN IF NOT EXISTS run_day DATE;
CREATE TABLE IF NOT EXISTS registration_application_lookup_attempts (
  source_order_no VARCHAR(50) NOT NULL,
  account VARCHAR(100) NOT NULL,
  outcome VARCHAR(20) NOT NULL,
  error_message TEXT,
  updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_order_no, account)
);
ALTER TABLE registration_application_lookup_attempts ADD COLUMN IF NOT EXISTS error_message TEXT;
CREATE TABLE IF NOT EXISTS registration_application_runs (
  run_hour TIMESTAMP(0) WITHOUT TIME ZONE PRIMARY KEY,
  status VARCHAR(20) NOT NULL,
  version INTEGER NOT NULL DEFAULT 2,
  lease_id VARCHAR(36),
  lease_until TIMESTAMP(3) WITHOUT TIME ZONE,
  updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE registration_application_runs ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
