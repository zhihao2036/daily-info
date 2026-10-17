-- Durable accounting for the optional Cloudflare Browser Run fallback.
ALTER TABLE sources ADD COLUMN browser_cooldown_until INTEGER;
ALTER TABLE sources ADD COLUMN last_browser_error_code TEXT;
ALTER TABLE sources ADD COLUMN browser_fallback_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE browser_usage_days (
  date_utc TEXT PRIMARY KEY,
  browser_ms_used INTEGER NOT NULL DEFAULT 0 CHECK(browser_ms_used >= 0),
  pages_used INTEGER NOT NULL DEFAULT 0 CHECK(pages_used >= 0),
  reserved_browser_ms INTEGER NOT NULL DEFAULT 0 CHECK(reserved_browser_ms >= 0),
  reserved_pages INTEGER NOT NULL DEFAULT 0 CHECK(reserved_pages >= 0),
  last_reservation_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE browser_fallback_attempts (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  url_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','succeeded','blocked','failed','uncertain')),
  reserved_ms INTEGER NOT NULL CHECK(reserved_ms = 60000),
  actual_ms INTEGER CHECK(actual_ms IS NULL OR actual_ms >= 0),
  error_code TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE(source_id,run_id,url_hash)
);
CREATE INDEX idx_browser_attempts_source ON browser_fallback_attempts(source_id,state,started_at);
