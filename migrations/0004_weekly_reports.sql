ALTER TABLE digests ADD COLUMN report_kind TEXT NOT NULL DEFAULT 'daily'
  CHECK(report_kind IN ('daily','weekly'));
DROP INDEX uq_digest_scheduled;
CREATE UNIQUE INDEX uq_digest_scheduled ON digests(profile_id,timezone,local_date,report_kind)
  WHERE mode='scheduled';
