import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1Persistence } from '../../src/db/repositories';
import { RequestRepository } from '../../src/db/repositories/requests';
import type { Clock, Json, RawItem, SourceConfig } from '../../src/domain/contracts';

class FakeClock implements Clock {
  constructor(private value: number) {}
  now(): number { return this.value; }
  advance(ms: number): void { this.value += ms; }
}

const tables = [
  'browser_fallback_attempts', 'browser_usage_days',
  'delivery_attempts', 'deliveries', 'digest_events', 'digest_candidates', 'event_versions', 'events',
  'llm_calls', 'budget_buckets', 'request_keys', 'item_versions', 'collection_pages', 'items',
  'source_leases', 'runs', 'digests', 'sources',
] as const;

async function resetDatabase(): Promise<void> {
  await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}

async function insertSource(now: number, id = 'hf-blog'): Promise<void> {
  await env.DB.prepare(`INSERT INTO sources (
    id,kind,name,url,config_json,enabled,is_core,config_hash,cursor_json,created_at,updated_at
  ) VALUES (?1,'rss','Fixture','https://example.com/feed','{}',1,1,'hash',?2,?3,?3)`)
    .bind(id, JSON.stringify({ highWater: null, resume: null, scanStartedAt: null }), now).run();
}

async function insertRun(runId: string, sourceId: string, now: number): Promise<void> {
  await env.DB.prepare(`INSERT INTO runs (
    id,job_key,workflow_id,kind,state,source_id,generation,scheduled_at,deadline_at,params_json,created_at,updated_at
  ) VALUES (?1,?2,?3,'collect','running',?4,0,?5,?6,'{}',?5,?5)`)
    .bind(runId, `job-${runId}`, `wf-${runId}`, sourceId, now, now + 600_000).run();
}

function snapshotSource(id = 'hf-blog'): SourceConfig {
  return { id, name: 'Fixture', kind: 'rss', url: 'https://example.com/feed', enabled: true, core: true,
    priority: 100, authority: 'official', allowedHosts: ['example.com'], intervalHours: 1,
    verification: 'worker_verified', browserFallbackEnabled: false };
}

function configSnapshot(sources: SourceConfig[] = [snapshotSource()]): Json {
  return { app: JSON.parse(env.APP_CONFIG as string), sources } as unknown as Json;
}

async function insertDigest(input: { id: string; now: number; cutoffAt: number; windowStartAt: number;
  generation?: number; localDate?: string; configSnapshot?: Json }): Promise<void> {
  await env.DB.prepare(`INSERT INTO digests (
    id,profile_id,local_date,timezone,mode,status,window_start_at,cutoff_at,build_deadline_at,send_at,
    send_deadline_at,build_generation,config_snapshot_json,created_at,updated_at
  ) VALUES (?1,'personal',?2,'Asia/Shanghai','scheduled','collecting',?3,?4,?5,?6,?7,?8,json(?9),?10,?10)`)
    .bind(input.id, input.localDate ?? '2026-09-21', input.windowStartAt, input.cutoffAt, input.cutoffAt + 1_500_000,
      input.cutoffAt + 1_800_000, input.cutoffAt + 3_600_000, input.generation ?? 0,
      JSON.stringify(input.configSnapshot ?? configSnapshot()), input.now).run();
}

function article(body: string, publishedAt: number | null = Date.parse('2026-09-20T00:00:00Z')): RawItem {
  return {
    externalKey: 'article-1',
    canonicalUrl: 'https://example.com/article-1',
    title: 'Fixture article',
    publishedAt,
    sourceUpdatedAt: null,
    body,
    quality: 'full',
    metadata: { fixture: true },
  };
}

describe('D1 persistence', () => {
  beforeEach(resetDatabase);

  it('runs the real migrations with exactly eighteen application tables', async () => {
    const rows = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'").all<{ name: string }>();
    expect(rows.results.map((row) => row.name).sort()).toEqual([...tables].sort());
  });

  it('prevents an old lease from committing after another owner acquires', async () => {
    const clock = new FakeClock(Date.now());
    const repo = new D1Persistence(env.DB, clock);
    await insertSource(clock.now());
    await insertRun('run-a', 'hf-blog', clock.now());
    const old = await repo.acquireLease('hf-blog', 'run-a', clock.now());
    clock.advance(121_000);
    await insertRun('run-b', 'hf-blog', clock.now());
    const fresh = await repo.acquireLease('hf-blog', 'run-b', clock.now());
    expect(fresh!.fencingToken).toBeGreaterThan(old!.fencingToken);
    await expect(repo.commitPage({ runId: 'run-a', pageNo: 0, lease: old!, items: [article('A')], requestCursor: null, expectedCursorVersion: 0, nextCursor: null, complete: true }))
      .rejects.toThrow('LEASE_LOST');
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM item_versions').first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it('renews only the current unexpired lease without changing its token', async () => {
    const now = Date.now();
    const clock = new FakeClock(now);
    const repo = new D1Persistence(env.DB, clock);
    await insertSource(now);
    const lease = await repo.acquireLease('hf-blog', 'owner', now);
    const renewed = await repo.renewLease(lease!, now + 30_000);
    expect(renewed?.fencingToken).toBe(lease?.fencingToken);
    expect(renewed!.expiresAt).toBeGreaterThan(lease!.expiresAt);
    expect(await repo.renewLease(renewed!, renewed!.expiresAt + 1)).toBeNull();
  });

  it('records source health only for the current fenced owner', async () => {
    const now = Date.now();
    const repo = new D1Persistence(env.DB, new FakeClock(now));
    await insertSource(now);
    const lease = await repo.acquireLease('hf-blog', 'owner', now);
    await repo.markSourceFailure(lease!, 'HTTP_503', now + 1);
    expect(await env.DB.prepare('SELECT failure_count,last_error_code FROM sources WHERE id=?1').bind('hf-blog').first())
      .toMatchObject({ failure_count: 1, last_error_code: 'HTTP_503' });
    await repo.markSourceSuccess(lease!, now + 2, 'etag-1', 'yesterday');
    expect(await env.DB.prepare('SELECT failure_count,last_error_code,last_success_at,etag,last_modified FROM sources WHERE id=?1').bind('hf-blog').first())
      .toMatchObject({ failure_count: 0, last_error_code: null, last_success_at: now + 2, etag: 'etag-1', last_modified: 'yesterday' });
  });

  it('makes a page replay idempotent and preserves A to B to A revisions', async () => {
    const now = Date.now();
    const repo = new D1Persistence(env.DB, new FakeClock(now));
    await insertSource(now);
    await insertRun('run-a', 'hf-blog', now);
    const lease = await repo.acquireLease('hf-blog', 'owner', now);
    await repo.commitPage({ runId: 'run-a', pageNo: 0, lease: lease!, items: [article('A')], requestCursor: null, expectedCursorVersion: 0, nextCursor: null, complete: true });
    await repo.commitPage({ runId: 'run-a', pageNo: 0, lease: lease!, items: [article('A')], requestCursor: null, expectedCursorVersion: 0, nextCursor: null, complete: true });
    await insertRun('run-b', 'hf-blog', now);
    await repo.commitPage({ runId: 'run-b', pageNo: 0, lease: lease!, items: [article('B')], requestCursor: null, expectedCursorVersion: 1, nextCursor: null, complete: true });
    await insertRun('run-c', 'hf-blog', now);
    await repo.commitPage({ runId: 'run-c', pageNo: 0, lease: lease!, items: [article('A')], requestCursor: null, expectedCursorVersion: 2, nextCursor: null, complete: true });
    const revisions = await env.DB.prepare('SELECT revision, body_text FROM item_versions ORDER BY revision').all<{ revision: number; body_text: string }>();
    expect(revisions.results).toEqual([{ revision: 1, body_text: 'A' }, { revision: 2, body_text: 'B' }, { revision: 3, body_text: 'A' }]);
  });

  it('does not replace a full current revision with a transient metadata-only failure', async () => {
    const now = Date.now();
    const repo = new D1Persistence(env.DB, new FakeClock(now));
    await insertSource(now);
    const lease = await repo.acquireLease('hf-blog', 'owner', now);
    await insertRun('run-a', 'hf-blog', now);
    await repo.commitPage({ runId: 'run-a', pageNo: 0, lease: lease!, items: [article('complete body')],
      requestCursor: null, expectedCursorVersion: 0, nextCursor: null, complete: true });
    await insertRun('run-b', 'hf-blog', now);
    await repo.commitPage({ runId: 'run-b', pageNo: 0, lease: lease!, items: [{ ...article(''), quality: 'metadata_only' }],
      requestCursor: null, expectedCursorVersion: 1, nextCursor: null, complete: true });

    expect(await env.DB.prepare(`SELECT v.revision,v.body_text,v.quality FROM items i
      JOIN item_versions v ON v.item_id=i.id AND v.revision=i.current_revision`).first())
      .toMatchObject({ revision: 1, body_text: 'complete body', quality: 'full' });
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM item_versions').first<{ count: number }>())?.count).toBe(1);
  });

  it('keeps staged versions invisible until the whole page is finalized', async () => {
    const now = Date.now();
    const clock = new FakeClock(now);
    const repo = new D1Persistence(env.DB, clock);
    await insertSource(now);
    await insertRun('run-a', 'hf-blog', now);
    const lease = await repo.acquireLease('hf-blog', 'owner', now);
    await repo.beginPage({ runId: 'run-a', pageNo: 0, lease: lease!, requestCursor: null, expectedCursorVersion: 0 });
    await repo.stagePageItems({ runId: 'run-a', pageNo: 0, lease: lease!, expectedCursorVersion: 0, items: [article('A')] });
    clock.advance(121_000);
    await expect(repo.stagePageItems({ runId: 'run-a', pageNo: 0, lease: lease!, expectedCursorVersion: 0, items: [article('B')] }))
      .rejects.toThrow('LEASE_LOST');
    await insertDigest({ id: 'digest-a', now, windowStartAt: now - 172_800_000, cutoffAt: clock.now() + 10_000 });
    expect(await repo.freezeCandidates('digest-a', 0)).toEqual([]);
    const item = await env.DB.prepare('SELECT current_revision FROM items').first<{ current_revision: number }>();
    expect(item?.current_revision).toBe(0);
  });

  it('freezes a recent newly discovered item as late and replays the same snapshot', async () => {
    const now = Date.now();
    const repo = new D1Persistence(env.DB, new FakeClock(now));
    await insertSource(now);
    await insertRun('run-a', 'hf-blog', now);
    const lease = await repo.acquireLease('hf-blog', 'owner', now);
    await repo.commitPage({ runId: 'run-a', pageNo: 0, lease: lease!, items: [article('A', now - 60 * 3_600_000)], requestCursor: null, expectedCursorVersion: 0, nextCursor: null, complete: true });
    await insertDigest({ id: 'digest-a', now, windowStartAt: now - 48 * 3_600_000, cutoffAt: now + 10_000 });
    const first = await repo.freezeCandidates('digest-a', 0);
    const second = await repo.freezeCandidates('digest-a', 0);
    expect(first).toHaveLength(1);
    expect(first[0]?.reason).toBe('late');
    expect(second.map((candidate) => candidate.version.id)).toEqual(first.map((candidate) => candidate.version.id));
  });

  it('rejects old revised news, retry-only revisions, unknown dates, future dates, and missing bodies', async () => {
    const now = Date.now();
    const repo = new D1Persistence(env.DB, new FakeClock(now));
    await insertSource(now);
    await insertRun('run-first', 'hf-blog', now);
    const lease = (await repo.acquireLease('hf-blog', 'owner', now))!;
    const item = (key: string, body: string, date: number | null = now - 1000): RawItem => ({
      ...article(body, date), externalKey: key, canonicalUrl: `https://example.com/${key}`,
    });
    await repo.commitPage({ runId: 'run-first', pageNo: 0, lease, expectedCursorVersion: 0,
      requestCursor: null, nextCursor: null, complete: true,
      items: [item('old', 'A', now - 14 * 86_400_000), item('retry', 'same'), item('real', 'before')] });
    await env.DB.prepare('UPDATE item_versions SET ingested_at=?1').bind(now - 1000).run();
    await env.DB.prepare('UPDATE collection_pages SET committed_at=?1').bind(now - 1000).run();
    await insertRun('run-second', 'hf-blog', now);
    await repo.commitPage({ runId: 'run-second', pageNo: 0, lease, expectedCursorVersion: 1,
      requestCursor: null, nextCursor: null, complete: true, items: [
        item('old', 'B', now - 14 * 86_400_000),
        { ...item('retry', 'same'), metadata: { extractionAttempts: 2 } },
        item('real', 'after'), item('undated', 'unknown', null), item('future', 'future', now + 86_400_000),
        { ...item('empty', ''), quality: 'metadata_only' },
      ] });
    await insertDigest({ id: 'fresh-only', now, windowStartAt: now - 500, cutoffAt: now + 10_000 });
    const frozen = await repo.freezeCandidates('fresh-only', 0);
    expect(frozen.map(x => x.version.bodyText)).toEqual(['after']);
  });

  it('enforces frozen late-hour and candidate-count limits', async () => {
    const now = Date.now();
    const repo = new D1Persistence(env.DB, new FakeClock(now));
    await insertSource(now);
    await insertRun('run-a', 'hf-blog', now);
    const lease = await repo.acquireLease('hf-blog', 'owner', now);
    await repo.commitPage({ runId: 'run-a', pageNo: 0, lease: lease!, items: [
      article('recent', now - 60 * 3_600_000),
      { ...article('second', now - 60 * 3_600_000), externalKey: 'article-2', canonicalUrl: 'https://example.com/article-2' },
      { ...article('too old', now - 7 * 86_400_000), externalKey: 'article-old', canonicalUrl: 'https://example.com/article-old' },
    ], requestCursor: null, expectedCursorVersion: 0, nextCursor: null, complete: true });
    await insertDigest({ id: 'digest-limited', now, windowStartAt: now - 48 * 3_600_000, cutoffAt: now + 10_000 });
    const app = JSON.parse(env.APP_CONFIG as string);
    app.limits.maxCandidates = 1;
    app.editorial.lateHours = 72;
    await env.DB.prepare('UPDATE digests SET config_snapshot_json=json(?1) WHERE id=?2')
      .bind(JSON.stringify({ app, sources: [snapshotSource()] }), 'digest-limited').run();

    const frozen = await repo.freezeCandidates('digest-limited', 0);

    expect(frozen).toHaveLength(1);
    expect(frozen[0]?.version.bodyText).not.toBe('too old');
  });

  it('preserves source diversity before applying the candidate limit', async () => {
    const now = Date.now();
    const repo = new D1Persistence(env.DB, new FakeClock(now));
    for (const id of ['quiet', 'busy']) {
      await insertSource(now, id);
      await insertRun(`run-${id}`, id, now);
      const lease = (await repo.acquireLease(id, 'owner', now))!;
      await repo.commitPage({ runId: `run-${id}`, pageNo: 0, lease, expectedCursorVersion: 0,
        requestCursor: null, nextCursor: null, complete: true,
        items: Array.from({ length: id === 'busy' ? 6 : 1 }, (_, n) => ({
          ...article(`${id}-${n}`, now - (id === 'busy' ? 1000 : 2000)),
          externalKey: `${id}-${n}`, canonicalUrl: `https://example.com/${id}-${n}`,
        })) });
    }
    const snapshot = configSnapshot([snapshotSource('quiet'), snapshotSource('busy')]) as { app: { limits: { maxCandidates: number } } };
    snapshot.app.limits.maxCandidates = 2;
    await insertDigest({ id: 'balanced', now, windowStartAt: now - 48 * 3_600_000, cutoffAt: now + 10_000,
      configSnapshot: snapshot as unknown as Json });
    const frozen = await repo.freezeCandidates('balanced', 0);
    expect(new Set(frozen.map(x => x.version.sourceId))).toEqual(new Set(['quiet', 'busy']));
  });

  it('excludes a version committed after the digest cutoff', async () => {
    const now = Date.now();
    const repo = new D1Persistence(env.DB, new FakeClock(now));
    await insertSource(now);
    await insertRun('run-a', 'hf-blog', now);
    const lease = await repo.acquireLease('hf-blog', 'owner', now);
    await repo.commitPage({ runId: 'run-a', pageNo: 0, lease: lease!, items: [article('A')], requestCursor: null, expectedCursorVersion: 0, nextCursor: null, complete: true });
    await insertDigest({ id: 'digest-a', now, windowStartAt: now - 172_800_000, cutoffAt: now - 1 });
    expect(await repo.freezeCandidates('digest-a', 0)).toEqual([]);
  });

  it('excludes content from a source disabled before the digest freezes', async () => {
    const now = Date.now();
    const repo = new D1Persistence(env.DB, new FakeClock(now));
    await insertSource(now);
    await insertRun('run-a', 'hf-blog', now);
    const lease = await repo.acquireLease('hf-blog', 'owner', now);
    await repo.commitPage({ runId: 'run-a', pageNo: 0, lease: lease!, items: [article('A')],
      requestCursor: null, expectedCursorVersion: 0, nextCursor: null, complete: true });
    await env.DB.prepare('UPDATE sources SET enabled=0 WHERE id=?1').bind('hf-blog').run();
    await insertDigest({ id: 'digest-a', now, windowStartAt: now - 172_800_000, cutoffAt: now + 10_000 });

    expect(await repo.freezeCandidates('digest-a', 0)).toEqual([]);
  });

  it('does not let a newly enabled live source enter an older digest snapshot', async () => {
    const now = Date.now();
    const repo = new D1Persistence(env.DB, new FakeClock(now));
    await insertSource(now);
    await insertRun('run-a', 'hf-blog', now);
    const lease = await repo.acquireLease('hf-blog', 'owner', now);
    await repo.commitPage({ runId: 'run-a', pageNo: 0, lease: lease!, items: [article('A')],
      requestCursor: null, expectedCursorVersion: 0, nextCursor: null, complete: true });
    await insertDigest({ id: 'digest-before-enable', now, windowStartAt: now - 172_800_000,
      cutoffAt: now + 10_000, configSnapshot: configSnapshot([]) });

    expect(await repo.freezeCandidates('digest-before-enable', 0)).toEqual([]);
    expect(JSON.parse((await env.DB.prepare("SELECT coverage_json FROM digests WHERE id='digest-before-enable'")
      .first<{ coverage_json: string }>())!.coverage_json)).toEqual({ coreTotal: 0, coreFailed: 0 });
  });

  it('includes on the next day a version whose page became visible just after the prior cutoff', async () => {
    const cutoff = Date.now();
    await insertSource(cutoff - 10_000);
    await insertRun('run-late-page', 'hf-blog', cutoff - 10_000);
    await env.DB.prepare(`INSERT INTO collection_pages(run_id,page_no,request_cursor_json,status,committed_at)
      VALUES ('run-late-page',0,'null','committed',?1)`).bind(cutoff + 1).run();
    await env.DB.prepare(`INSERT INTO items(id,source_id,external_key,canonical_url,first_seen_at,last_seen_at,current_revision)
      VALUES ('item-late-page','hf-blog','late-page','https://example.com/late',?1,?1,1)`).bind(cutoff - 1).run();
    await env.DB.prepare(`INSERT INTO item_versions(id,item_id,revision,ingest_key,collection_run_id,collection_page_no,
      content_hash,title,canonical_url,ingested_at,body_text,quality,metadata_json,published_at)
      VALUES ('version-late-page','item-late-page',1,'late-ingest','run-late-page',0,'hash-late','Late page',
        'https://example.com/late',?1,'Late but visible after cutoff','full','{}',?1)`).bind(cutoff - 1).run();
    await insertDigest({ id: 'digest-prior', now: cutoff + 2, windowStartAt: cutoff - 86_400_000, cutoffAt: cutoff });
    const repo = new D1Persistence(env.DB, new FakeClock(cutoff + 2));
    expect(await repo.freezeCandidates('digest-prior', 0)).toEqual([]);
    await insertDigest({ id: 'digest-next', now: cutoff + 3, windowStartAt: cutoff,
      cutoffAt: cutoff + 86_400_000, localDate: '2026-09-22' });
    expect((await repo.freezeCandidates('digest-next', 0)).map((candidate) => candidate.version.id))
      .toEqual(['version-late-page']);
  });

  it('deduplicates matching request keys, rejects changed bodies, and rate limits the sixth new request', async () => {
    const now = Date.parse('2026-09-21T00:00:01Z');
    const repo = new D1Persistence(env.DB);
    await insertSource(now);
    const first = await repo.registerRequest({ scope: 'collect', key: 'abcdefghijklmnop', requestHash: 'hash-a', params: { sourceId: 'hf-blog' }, now });
    const replay = await repo.registerRequest({ scope: 'collect', key: 'abcdefghijklmnop', requestHash: 'hash-a', params: { sourceId: 'hf-blog' }, now });
    expect(replay).toEqual(first);
    await expect(repo.registerRequest({ scope: 'collect', key: 'abcdefghijklmnop', requestHash: 'hash-b', params: { sourceId: 'other' }, now }))
      .rejects.toThrow('IDEMPOTENCY_CONFLICT');
    for (let index = 1; index < 5; index += 1) {
      await repo.registerRequest({ scope: 'collect', key: `abcdefghijklmnop-${index}`, requestHash: `hash-${index}`, params: {}, now });
    }
    await expect(repo.registerRequest({ scope: 'collect', key: 'abcdefghijklmnop-5', requestHash: 'hash-5', params: {}, now }))
      .rejects.toThrow('RATE_LIMITED');
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM runs').first<{ count: number }>();
    expect(count?.count).toBe(5);
  });

  it('bounds opportunistic idempotency-key cleanup on an API request', async () => {
    const now = Date.parse('2026-09-21T00:00:01Z');
    await insertSource(now);
    for (let index = 0; index < 101; index += 1) {
      await env.DB.prepare(`INSERT INTO runs(id,job_key,workflow_id,kind,state,scheduled_at,deadline_at,params_json,created_at,updated_at)
        VALUES (?1,?2,?3,'collect','completed',?4,?4,'{}',?4,?4)`).bind(`expired-run-${index}`, `expired-job-${index}`, `expired-workflow-${index}`, now - 1).run();
      await env.DB.prepare(`INSERT INTO request_keys(scope,idempotency_key,request_hash,run_id,created_at,expires_at,minute_slot,slot_number)
        VALUES ('collect',?1,?2,?3,?4,?4,?5,0)`).bind(`expired-key-${index}`, `expired-hash-${index}`, `expired-run-${index}`, now - 1, index).run();
    }

    await new RequestRepository(env.DB).registerRequest({
      scope: 'collect', key: 'fresh-request-key', requestHash: 'fresh-hash', params: { sourceId: 'hf-blog' }, now,
    });

    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM request_keys WHERE expires_at<=?1').bind(now)
      .first<{ count: number }>())?.count).toBe(1);
  });

  it('atomically admits preview digest, run, key, and rate slot without orphaning the rejected sixth digest', async () => {
    const now = Date.parse('2026-09-21T02:00:00Z');
    const requests = new RequestRepository(env.DB);
    const times = { localDate: '2026-09-21', morningAt: now, cutoffAt: now, buildDeadlineAt: now + 180_000,
      sendAt: now + 240_000, sendDeadlineAt: now + 300_000 };
    for (let index = 0; index < 5; index += 1) {
      const digestId = `preview-digest-${index}`;
      await requests.registerRequest({ scope: 'preview', key: `preview-key-000${index}`, requestHash: `hash-${index}`,
        params: { digestId, mode: 'preview', generation: 0, scheduledAt: now, deadlineAt: times.sendDeadlineAt }, now,
        previewDigest: { id: digestId, profileId: 'personal', times, configSnapshot: {}, windowStartAt: now - 86_400_000 } });
    }
    await expect(requests.registerRequest({ scope: 'preview', key: 'preview-key-0005', requestHash: 'hash-5',
      params: { digestId: 'preview-digest-5', mode: 'preview', generation: 0, scheduledAt: now, deadlineAt: times.sendDeadlineAt }, now,
      previewDigest: { id: 'preview-digest-5', profileId: 'personal', times, configSnapshot: {}, windowStartAt: now - 86_400_000 } }))
      .rejects.toThrow('RATE_LIMITED');
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM digests WHERE mode='preview'").first<{ count: number }>())?.count).toBe(5);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM runs WHERE kind='preview' AND digest_id IS NOT NULL").first<{ count: number }>())?.count).toBe(5);
  });
});
