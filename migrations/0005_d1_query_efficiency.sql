-- Bound page commits to the versions actually collected by that page.
CREATE INDEX idx_versions_collection_page ON item_versions(collection_run_id,collection_page_no,item_id,revision);

-- Retention must seek to old records instead of scanning recent records.
CREATE INDEX idx_items_last_seen ON items(last_seen_at,id);
CREATE INDEX idx_runs_retention ON runs(state,updated_at,id)
  WHERE state IN ('completed','failed','expired','cancelled');
CREATE INDEX idx_request_keys_expiry ON request_keys(expires_at);
CREATE INDEX idx_request_keys_run ON request_keys(run_id);

-- Reverse references protect retained articles without scanning every digest.
CREATE INDEX idx_candidates_item ON digest_candidates(item_id);
CREATE INDEX idx_candidates_version ON digest_candidates(item_version_id);
