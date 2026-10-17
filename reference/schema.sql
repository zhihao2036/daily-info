-- Reference migration for the implementation specification, SQLite/D1 dialect.
-- All *_at/*_ms values are integer UTC milliseconds. No application is deployed by this file.
PRAGMA foreign_keys = ON;
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('rss','github_releases','html_list')),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  is_core INTEGER NOT NULL DEFAULT 0 CHECK(is_core IN (0,1)),
  config_hash TEXT NOT NULL,
  cursor_json TEXT CHECK(cursor_json IS NULL OR json_valid(cursor_json)),
  cursor_version INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  last_modified TEXT,
  last_success_at INTEGER,
  last_error_code TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  browser_cooldown_until INTEGER,
  last_browser_error_code TEXT,
  browser_fallback_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE source_leases (
  source_id TEXT PRIMARY KEY REFERENCES sources(id),
  owner_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK(fencing_token > 0),
  expires_at INTEGER NOT NULL
);
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_key TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  current_revision INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source_id, external_key)
);
CREATE INDEX idx_items_url ON items(canonical_url);
CREATE INDEX idx_items_seen ON items(first_seen_at, id);
CREATE TABLE item_versions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  ingest_key TEXT NOT NULL,
  collection_run_id TEXT NOT NULL,
  collection_page_no INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  published_at INTEGER,
  source_updated_at INTEGER,
  ingested_at INTEGER NOT NULL,
  body_text TEXT NOT NULL,
  quality TEXT NOT NULL CHECK(quality IN ('full','partial','metadata_only')),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  UNIQUE(item_id, revision),
  UNIQUE(item_id, ingest_key),
  FOREIGN KEY(collection_run_id,collection_page_no) REFERENCES collection_pages(run_id,page_no)
);
CREATE INDEX idx_versions_cutoff ON item_versions(ingested_at, item_id, revision);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  organization TEXT NOT NULL,
  product TEXT NOT NULL,
  product_version TEXT NOT NULL,
  change_kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE event_versions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  facts_hash TEXT NOT NULL,
  card_json TEXT NOT NULL CHECK(json_valid(card_json)),
  created_at INTEGER NOT NULL,
  UNIQUE(event_id, revision),
  UNIQUE(event_id, facts_hash)
);
CREATE TABLE digests (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  timezone TEXT NOT NULL CHECK(timezone='Asia/Shanghai'),
  mode TEXT NOT NULL CHECK(mode IN ('scheduled','preview')),
  status TEXT NOT NULL CHECK(status IN ('collecting','building','ready','sending','sent','delivery_failed','uncertain','expired')),
  window_start_at INTEGER NOT NULL,
  cutoff_at INTEGER NOT NULL,
  build_deadline_at INTEGER NOT NULL,
  send_at INTEGER NOT NULL,
  send_deadline_at INTEGER NOT NULL,
  frozen_at INTEGER,
  build_generation INTEGER NOT NULL DEFAULT 0,
  config_snapshot_json TEXT NOT NULL CHECK(json_valid(config_snapshot_json)),
  coverage_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(coverage_json)),
  content_json TEXT CHECK(content_json IS NULL OR json_valid(content_json)),
  rendered_text TEXT,
  rendered_html TEXT,
  content_hash TEXT,
  degraded_reason TEXT,
  accepted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(cutoff_at <= build_deadline_at AND build_deadline_at < send_at AND send_at < send_deadline_at)
);
CREATE UNIQUE INDEX uq_digest_scheduled ON digests(profile_id,timezone,local_date) WHERE mode='scheduled';
CREATE INDEX idx_digests_status ON digests(mode,status,send_at);
CREATE TABLE digest_candidates (
  digest_id TEXT NOT NULL REFERENCES digests(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  item_version_id TEXT NOT NULL REFERENCES item_versions(id),
  ordinal INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('new','late','updated','initial')),
  PRIMARY KEY(digest_id,item_id),
  UNIQUE(digest_id,ordinal)
);
CREATE TABLE digest_events (
  digest_id TEXT NOT NULL REFERENCES digests(id),
  event_version_id TEXT NOT NULL REFERENCES event_versions(id),
  ordinal INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  PRIMARY KEY(digest_id,event_version_id),
  UNIQUE(digest_id,ordinal)
);
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  digest_id TEXT NOT NULL REFERENCES digests(id),
  channel TEXT NOT NULL CHECK(channel IN ('dummy','cloudflare_email','telegram','feishu')),
  destination_key TEXT NOT NULL,
  destination_config_ref TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','uncertain','suppressed')),
  attempt_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0,1)),
  next_attempt_at INTEGER,
  claimed_at INTEGER,
  provider_message_id TEXT,
  accepted_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(digest_id,channel,destination_key)
);
CREATE INDEX idx_delivery_retry ON deliveries(status,retryable,next_attempt_at);
CREATE TABLE delivery_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id),
  state TEXT NOT NULL CHECK(state IN ('reserved','calling','succeeded','failed','uncertain')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  provider_message_id TEXT,
  error_code TEXT,
  response_summary_json TEXT CHECK(response_summary_json IS NULL OR json_valid(response_summary_json))
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  job_key TEXT NOT NULL UNIQUE,
  workflow_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('collect','digest','recovery','preview')),
  state TEXT NOT NULL CHECK(state IN ('pending_create','running','completed','failed','expired','cancelled')),
  source_id TEXT REFERENCES sources(id),
  digest_id TEXT REFERENCES digests(id),
  generation INTEGER NOT NULL DEFAULT 0,
  scheduled_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  params_json TEXT NOT NULL CHECK(json_valid(params_json)),
  checkpoint_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(checkpoint_json)),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_runs_reconcile ON runs(state,deadline_at,created_at);
CREATE TABLE collection_pages (
  run_id TEXT NOT NULL REFERENCES runs(id),
  page_no INTEGER NOT NULL,
  request_cursor_json TEXT NOT NULL CHECK(json_valid(request_cursor_json)),
  next_cursor_json TEXT CHECK(next_cursor_json IS NULL OR json_valid(next_cursor_json)),
  status TEXT NOT NULL CHECK(status IN ('pending','committed','failed')),
  item_count INTEGER NOT NULL DEFAULT 0,
  committed_at INTEGER,
  error_code TEXT,
  PRIMARY KEY(run_id,page_no)
);
CREATE TABLE request_keys (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  minute_slot INTEGER NOT NULL,
  slot_number INTEGER NOT NULL CHECK(slot_number BETWEEN 0 AND 4),
  UNIQUE(scope,minute_slot,slot_number),
  PRIMARY KEY(scope,idempotency_key)
);
CREATE TABLE budget_buckets (
  bucket_key TEXT PRIMARY KEY,
  limit_microusd INTEGER NOT NULL CHECK(limit_microusd >= 0),
  reserved_microusd INTEGER NOT NULL DEFAULT 0 CHECK(reserved_microusd >= 0),
  spent_microusd INTEGER NOT NULL DEFAULT 0 CHECK(spent_microusd >= 0),
  updated_at INTEGER NOT NULL
);
CREATE TABLE llm_calls (
  id TEXT PRIMARY KEY,
  cache_key TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  attempt_no INTEGER NOT NULL CHECK(attempt_no > 0),
  digest_id TEXT REFERENCES digests(id),
  stage TEXT NOT NULL CHECK(stage IN ('filter','group','edit','repair')),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','calling','succeeded','failed','uncertain')),
  day_bucket TEXT NOT NULL REFERENCES budget_buckets(bucket_key),
  month_bucket TEXT NOT NULL REFERENCES budget_buckets(bucket_key),
  reserved_microusd INTEGER NOT NULL CHECK(reserved_microusd > 0),
  actual_microusd INTEGER CHECK(actual_microusd IS NULL OR actual_microusd >= 0),
  usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
  output_json TEXT CHECK(output_json IS NULL OR json_valid(output_json)),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(invocation_id,attempt_no)
);
CREATE INDEX idx_llm_cache ON llm_calls(cache_key,state);
CREATE INDEX idx_llm_day ON llm_calls(day_bucket,state);
CREATE INDEX idx_llm_month ON llm_calls(month_bucket,state);

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
