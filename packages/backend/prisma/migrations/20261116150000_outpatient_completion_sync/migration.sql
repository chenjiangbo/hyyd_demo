CREATE TABLE IF NOT EXISTS outpatient_completion_runs (
  run_day DATE PRIMARY KEY,
  status VARCHAR(16) NOT NULL,
  lease_id VARCHAR(80),
  lease_until TIMESTAMP(3) WITHOUT TIME ZONE,
  updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS outpatient_completion_tasks (
  run_day DATE NOT NULL,
  source_order_no VARCHAR(100) NOT NULL,
  huanyu_order_no VARCHAR(100) NOT NULL,
  created_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'pending',
  lease_account VARCHAR(100),
  lease_id VARCHAR(80),
  lease_until TIMESTAMP(3) WITHOUT TIME ZONE,
  updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_day, source_order_no)
);
CREATE TABLE IF NOT EXISTS outpatient_completion_attempts (
  run_day DATE NOT NULL,
  source_order_no VARCHAR(100) NOT NULL,
  account VARCHAR(100) NOT NULL,
  result VARCHAR(20) NOT NULL,
  remote_state VARCHAR(40),
  remote_state_name VARCHAR(100),
  sync_result VARCHAR(20),
  retry_after TIMESTAMP(3) WITHOUT TIME ZONE,
  updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_day, source_order_no, account)
);
CREATE TABLE IF NOT EXISTS outpatient_completion_preferred (
  source_order_no VARCHAR(100) PRIMARY KEY,
  account VARCHAR(100) NOT NULL,
  updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
