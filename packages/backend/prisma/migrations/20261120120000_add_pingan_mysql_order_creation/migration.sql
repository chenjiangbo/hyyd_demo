BEGIN;

CREATE TABLE IF NOT EXISTS taikang_huanyu_channel_mappings (
  id BIGSERIAL PRIMARY KEY,
  business_key VARCHAR(40) NOT NULL UNIQUE,
  business_name VARCHAR(100) NOT NULL,
  huanyu_channel_id VARCHAR(40),
  huanyu_channel_name VARCHAR(200),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE taikang_huanyu_channel_mappings
  DROP CONSTRAINT IF EXISTS taikang_huanyu_channel_mappings_business_key_check;
ALTER TABLE taikang_huanyu_channel_mappings
  ADD CONSTRAINT taikang_huanyu_channel_mappings_business_key_check
  CHECK (business_key IN ('green_pass', 'register_assist', 'pingan'));

INSERT INTO taikang_huanyu_channel_mappings (business_key, business_name)
VALUES ('pingan', '平安好医生')
ON CONFLICT (business_key) DO NOTHING;

CREATE TABLE pingan_mysql_order_jobs (
  order_id VARCHAR(120) PRIMARY KEY,
  pingan_user_id VARCHAR(40) NOT NULL,
  candidate_ddbh VARCHAR(50) NOT NULL UNIQUE,
  state VARCHAR(24) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'created', 'skipped')),
  huanyu_order_no VARCHAR(50),
  needs_identity BOOLEAN NOT NULL DEFAULT false,
  checked_attachments VARCHAR(32),
  lease_id UUID,
  next_attempt_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  failure_code VARCHAR(120),
  CONSTRAINT pingan_mysql_order_jobs_source_fkey FOREIGN KEY (pingan_user_id, order_id)
    REFERENCES pingan_orders(pingan_user_id, order_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX pingan_mysql_order_jobs_next_attempt_at_order_id_idx
  ON pingan_mysql_order_jobs(next_attempt_at, order_id);

CREATE INDEX pingan_order_attachments_order_id_idx ON pingan_order_attachments(order_id);

COMMIT;
