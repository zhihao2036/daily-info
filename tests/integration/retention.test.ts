import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { runRetention } from '../../src/maintenance/retention';

const tables = [
  'delivery_attempts', 'deliveries', 'digest_events', 'digest_candidates', 'event_versions', 'events',
  'llm_calls', 'budget_buckets', 'request_keys', 'item_versions', 'collection_pages', 'items',
  'source_leases', 'runs', 'digests', 'sources',
] as const;

async function reset(): Promise<void> {
  await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}

async function seedVersion(input: { suffix: string; now: number; referenced: boolean }): Promise<void> {
  const old = input.now - 200 * 86_400_000;
  const sourceId = `source-${input.suffix}`;
  const runId = `run-${input.suffix}`;
  const itemId = `item-${input.suffix}`;
  const versionId = `version-${input.suffix}`;
  await env.DB.prepare(`INSERT INTO sources(id,kind,name,url,config_json,enabled,is_core,config_hash,cursor_json,created_at,updated_at)
    VALUES (?1,'rss',?1,'https://example.com/feed','{}',0,0,'hash','{}',?2,?2)`).bind(sourceId, old).run();
  await env.DB.prepare(`INSERT INTO runs(id,job_key,workflow_id,kind,state,source_id,scheduled_at,deadline_at,params_json,created_at,finished_at,updated_at)
    VALUES (?1,?2,?3,'collect','completed',?4,?5,?5,'{}',?5,?5,?5)`)
    .bind(runId, `job-${input.suffix}`, `wf-${input.suffix}`, sourceId, old).run();
  await env.DB.prepare(`INSERT INTO collection_pages(run_id,page_no,request_cursor_json,status,item_count,committed_at)
    VALUES (?1,0,'null','committed',1,?2)`).bind(runId, old).run();
  await env.DB.prepare(`INSERT INTO items(id,source_id,external_key,canonical_url,first_seen_at,last_seen_at,current_revision)
    VALUES (?1,?2,?3,?4,?5,?5,1)`).bind(itemId, sourceId, input.suffix, `https://example.com/${input.suffix}`, old).run();
  await env.DB.prepare(`INSERT INTO item_versions(id,item_id,revision,ingest_key,collection_run_id,collection_page_no,
    content_hash,title,canonical_url,ingested_at,body_text,quality,metadata_json)
    VALUES (?1,?2,1,?3,?4,0,?5,?6,?7,?8,'body','full','{}')`)
    .bind(versionId, itemId, `ingest-${input.suffix}`, runId, `hash-${input.suffix}`, input.suffix,
      `https://example.com/${input.suffix}`, old).run();
  if (!input.referenced) return;
  await env.DB.prepare(`INSERT INTO digests(id,profile_id,local_date,timezone,mode,status,window_start_at,cutoff_at,
    build_deadline_at,send_at,send_deadline_at,frozen_at,build_generation,config_snapshot_json,created_at,updated_at)
    VALUES (?1,'personal','2026-06-01','Asia/Shanghai','scheduled','sent',?2,?3,?4,?5,?6,?3,0,'{}',?2,?2)`)
    .bind(`digest-${input.suffix}`, old, old + 1000, old + 2000, old + 3000, old + 4000).run();
  await env.DB.prepare(`INSERT INTO digest_candidates(digest_id,item_id,item_version_id,ordinal,reason)
    VALUES (?1,?2,?3,1,'new')`).bind(`digest-${input.suffix}`, itemId, versionId).run();
}

describe('bounded retention', () => {
  beforeEach(reset);

  it('deletes only expired unreferenced versions and respects the row batch size', async () => {
    const now = Date.parse('2026-09-21T00:00:00Z');
    await seedVersion({ suffix: 'unreferenced-a', now, referenced: false });
    await seedVersion({ suffix: 'unreferenced-b', now, referenced: false });
    await seedVersion({ suffix: 'referenced', now, referenced: true });

    const result = await runRetention(env.DB, now, 2);

    expect(result.deleted).toBe(2);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM item_versions WHERE id LIKE 'version-unreferenced-%'")
      .first<{ count: number }>())?.count).toBe(1);
    expect(await env.DB.prepare("SELECT id FROM item_versions WHERE id='version-referenced'").first())
      .toMatchObject({ id: 'version-referenced' });
  });

  it('removes an old non-current revision while retaining the active item and current revision', async () => {
    const now = Date.parse('2026-09-21T00:00:00Z');
    await seedVersion({ suffix: 'active', now, referenced: false });
    await env.DB.prepare(`INSERT INTO item_versions(id,item_id,revision,ingest_key,collection_run_id,collection_page_no,
      content_hash,title,canonical_url,ingested_at,body_text,quality,metadata_json)
      VALUES ('version-active-current','item-active',2,'ingest-active-current','run-active',0,
        'hash-active-current','active','https://example.com/active',?1,'current','full','{}')`).bind(now).run();
    await env.DB.prepare("UPDATE items SET current_revision=2,last_seen_at=?1 WHERE id='item-active'").bind(now).run();

    const result = await runRetention(env.DB, now, 1);

    expect(result.deleted).toBe(1);
    expect(await env.DB.prepare("SELECT id,current_revision FROM items WHERE id='item-active'").first())
      .toMatchObject({ id: 'item-active', current_revision: 2 });
    expect((await env.DB.prepare("SELECT id FROM item_versions WHERE item_id='item-active' ORDER BY revision")
      .all<{ id: string }>()).results).toEqual([{ id: 'version-active-current' }]);
  });

  it('rechecks an old item after selection and preserves a concurrently refreshed current revision', async () => {
    const now = Date.parse('2026-09-21T00:00:00Z');
    await seedVersion({ suffix: 'refreshed', now, referenced: false });

    const result = await runRetention(env.DB, now, 3, { beforeItemBatch: async (itemId) => {
      expect(itemId).toBe('item-refreshed');
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO item_versions(id,item_id,revision,ingest_key,collection_run_id,collection_page_no,
          content_hash,title,canonical_url,ingested_at,body_text,quality,metadata_json)
          VALUES ('version-refreshed-current','item-refreshed',2,'ingest-refreshed-current','run-refreshed',0,
            'hash-refreshed-current','refreshed','https://example.com/refreshed',?1,'new current','full','{}')`).bind(now),
        env.DB.prepare("UPDATE items SET current_revision=2,last_seen_at=?1 WHERE id='item-refreshed'").bind(now),
      ]);
    } });

    expect(result.deleted).toBe(0);
    expect(await env.DB.prepare("SELECT id,current_revision,last_seen_at FROM items WHERE id='item-refreshed'").first())
      .toMatchObject({ id: 'item-refreshed', current_revision: 2, last_seen_at: now });
    expect((await env.DB.prepare("SELECT id FROM item_versions WHERE item_id='item-refreshed' ORDER BY revision")
      .all<{ id: string }>()).results).toEqual([{ id: 'version-refreshed' }, { id: 'version-refreshed-current' }]);
  });
});
