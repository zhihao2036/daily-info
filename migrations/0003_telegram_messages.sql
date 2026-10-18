CREATE TABLE telegram_messages (
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  text_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','uncertain')),
  attempt_id TEXT,
  provider_message_id TEXT,
  accepted_at INTEGER,
  retryable INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  error_code TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(delivery_id,ordinal)
);
