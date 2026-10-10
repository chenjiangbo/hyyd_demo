CREATE TABLE IF NOT EXISTS order_id_card_ocr_attempts (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  result VARCHAR(24) NOT NULL DEFAULT 'pending'
);
