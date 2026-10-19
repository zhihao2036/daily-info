const DAY_MS = 86_400_000;

export interface RetentionResult { deleted: number }
export interface RetentionTestHooks { beforeItemBatch?(itemId: string): Promise<void> }

async function deleteLimited(
  db: D1Database,
  sql: string,
  bindings: Array<string | number | null>,
): Promise<number> {
  const result = await db.prepare(sql).bind(...bindings).run();
  return result.meta.changes;
}

export async function runRetention(
  db: D1Database,
  now: number,
  batchSize = 100,
  testHooks: RetentionTestHooks = {},
): Promise<RetentionResult> {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error('RETENTION_INPUT_INVALID');
  }
  let remaining = batchSize;
  let deleted = 0;
  const consume = (count: number) => { deleted += count; remaining -= count; };

  consume(await deleteLimited(db, `DELETE FROM request_keys WHERE rowid IN (
    SELECT rowid FROM request_keys WHERE expires_at<=?1 ORDER BY expires_at,rowid LIMIT ?2
  )`, [now, remaining]));
  if (remaining === 0) return { deleted };

  consume(await deleteLimited(db, `DELETE FROM source_leases WHERE rowid IN (
    SELECT rowid FROM source_leases WHERE expires_at<=?1 ORDER BY expires_at,rowid LIMIT ?2
  )`, [now - DAY_MS, remaining]));
  if (remaining === 0) return { deleted };

  consume(await deleteLimited(db, `DELETE FROM llm_calls WHERE rowid IN (
    SELECT rowid FROM llm_calls WHERE digest_id IS NULL AND updated_at<?1
      AND state IN ('succeeded','failed') ORDER BY updated_at,id LIMIT ?2
  )`, [now - 365 * DAY_MS, remaining]));
  if (remaining === 0) return { deleted };

  const digestRows = await db.prepare(`
    SELECT d.id FROM digests d
    WHERE ((d.mode='preview' AND d.updated_at<?1) OR (d.mode='scheduled' AND d.updated_at<?2))
      AND d.status IN ('ready','sent','delivery_failed','expired')
      AND NOT EXISTS (SELECT 1 FROM deliveries x WHERE x.digest_id=d.id AND x.status IN ('sending','uncertain'))
      AND NOT EXISTS (SELECT 1 FROM llm_calls c WHERE c.digest_id=d.id AND c.state IN ('reserved','calling','uncertain'))
      AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.digest_id=d.id AND r.state IN ('pending_create','running'))
    ORDER BY d.updated_at,d.id LIMIT ?3
  `).bind(now - 90 * DAY_MS, now - 365 * DAY_MS, remaining).all<{ id: string }>();
  for (const row of digestRows.results) {
    await db.batch([
      db.prepare('DELETE FROM request_keys WHERE run_id IN (SELECT id FROM runs WHERE digest_id=?1)').bind(row.id),
      db.prepare('DELETE FROM runs WHERE digest_id=?1').bind(row.id),
      db.prepare("DELETE FROM llm_calls WHERE digest_id=?1 AND state IN ('succeeded','failed')").bind(row.id),
      db.prepare('DELETE FROM delivery_attempts WHERE delivery_id IN (SELECT id FROM deliveries WHERE digest_id=?1)').bind(row.id),
      db.prepare('DELETE FROM deliveries WHERE digest_id=?1').bind(row.id),
      db.prepare('DELETE FROM digest_events WHERE digest_id=?1').bind(row.id),
      db.prepare('DELETE FROM digest_candidates WHERE digest_id=?1').bind(row.id),
      db.prepare('DELETE FROM digests WHERE id=?1').bind(row.id),
    ]);
    consume(1);
    if (remaining === 0) return { deleted };
  }

  consume(await deleteLimited(db, `DELETE FROM event_versions WHERE rowid IN (
    SELECT v.rowid FROM event_versions v WHERE v.created_at<?1
      AND NOT EXISTS (SELECT 1 FROM digest_events e WHERE e.event_version_id=v.id)
    ORDER BY v.created_at,v.id LIMIT ?2
  )`, [now - 365 * DAY_MS, remaining]));
  if (remaining === 0) return { deleted };

  consume(await deleteLimited(db, `DELETE FROM events WHERE rowid IN (
    SELECT e.rowid FROM events e WHERE e.created_at<?1
      AND NOT EXISTS (SELECT 1 FROM event_versions v WHERE v.event_id=e.id)
    ORDER BY e.created_at,e.id LIMIT ?2
  )`, [now - 365 * DAY_MS, remaining]));
  if (remaining === 0) return { deleted };

  consume(await deleteLimited(db, `DELETE FROM budget_buckets WHERE rowid IN (
    SELECT b.rowid FROM budget_buckets b WHERE b.updated_at<?1
      AND NOT EXISTS (SELECT 1 FROM llm_calls c WHERE c.day_bucket=b.bucket_key OR c.month_bucket=b.bucket_key)
    ORDER BY b.updated_at,b.bucket_key LIMIT ?2
  )`, [now - 365 * DAY_MS, remaining]));
  if (remaining === 0) return { deleted };

  consume(await deleteLimited(db, `DELETE FROM item_versions WHERE rowid IN (
    SELECT v.rowid FROM item_versions v JOIN items i ON i.id=v.item_id
    WHERE v.ingested_at<?1 AND v.revision<>i.current_revision
      AND NOT EXISTS (SELECT 1 FROM digest_candidates c WHERE c.item_version_id=v.id)
    ORDER BY v.ingested_at,v.id LIMIT ?2
  )`, [now - 180 * DAY_MS, remaining]));
  if (remaining === 0) return { deleted };

  const itemRows = await db.prepare(`
    SELECT i.id,(SELECT COUNT(*) FROM item_versions v WHERE v.item_id=i.id) AS version_count FROM items i
    WHERE i.last_seen_at<?1
      AND NOT EXISTS (SELECT 1 FROM digest_candidates c WHERE c.item_id=i.id)
      AND (SELECT COUNT(*) FROM item_versions v WHERE v.item_id=i.id)+1<=?2
    ORDER BY i.last_seen_at,i.id LIMIT ?2
  `).bind(now - 180 * DAY_MS, remaining).all<{ id: string; version_count: number }>();
  for (const row of itemRows.results) {
    const rowCost = Number(row.version_count) + 1;
    if (rowCost > remaining) continue;
    await testHooks.beforeItemBatch?.(row.id);
    const results = await db.batch([
      db.prepare(`DELETE FROM item_versions WHERE item_id=?1 AND EXISTS (
        SELECT 1 FROM items i WHERE i.id=?1 AND i.last_seen_at<?2
          AND NOT EXISTS (SELECT 1 FROM digest_candidates c WHERE c.item_id=i.id)
          AND (SELECT COUNT(*) FROM item_versions current WHERE current.item_id=i.id)+1<=?3
      )`).bind(row.id, now - 180 * DAY_MS, remaining),
      db.prepare(`DELETE FROM items WHERE id=?1 AND last_seen_at<?2
        AND NOT EXISTS (SELECT 1 FROM item_versions v WHERE v.item_id=items.id)
        AND NOT EXISTS (SELECT 1 FROM digest_candidates c WHERE c.item_id=items.id)`)
        .bind(row.id, now - 180 * DAY_MS),
    ]);
    consume((results[0]?.meta.changes ?? 0) + (results[1]?.meta.changes ?? 0));
    if (remaining === 0) return { deleted };
  }

  consume(await deleteLimited(db, `DELETE FROM collection_pages WHERE rowid IN (
    SELECT p.rowid FROM collection_pages p JOIN runs r ON r.id=p.run_id
    WHERE r.updated_at<?1 AND r.state IN ('completed','failed','expired','cancelled')
      AND NOT EXISTS (SELECT 1 FROM item_versions v
        WHERE v.collection_run_id=p.run_id AND v.collection_page_no=p.page_no)
    ORDER BY r.updated_at,p.run_id,p.page_no LIMIT ?2
  )`, [now - 30 * DAY_MS, remaining]));
  if (remaining === 0) return { deleted };

  consume(await deleteLimited(db, `DELETE FROM runs WHERE rowid IN (
    SELECT r.rowid FROM runs r WHERE r.updated_at<?1 AND r.state IN ('completed','failed','expired','cancelled')
      AND NOT EXISTS (SELECT 1 FROM request_keys k WHERE k.run_id=r.id)
      AND NOT EXISTS (SELECT 1 FROM collection_pages p WHERE p.run_id=r.id)
    ORDER BY r.updated_at,r.id LIMIT ?2
  )`, [now - 30 * DAY_MS, remaining]));
  return { deleted };
}
