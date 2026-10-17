import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDigest } from '../../src/editorial';
import { runEditorialModel } from '../../src/editorial/model';
import type { ItemVersion } from '../../src/domain/contracts';

const tables = ['delivery_attempts', 'deliveries', 'digest_events', 'digest_candidates', 'event_versions', 'events', 'item_versions', 'collection_pages', 'items', 'runs', 'digests', 'sources'] as const;
async function reset(): Promise<void> { await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`))); }

async function seed(now: number): Promise<void> {
  for (const [sourceId, authority] of [['official-a', 'official'], ['official-b', 'official']] as const) {
    await env.DB.prepare(`INSERT INTO sources(id,kind,name,url,config_json,enabled,is_core,config_hash,cursor_json,created_at,updated_at)
      VALUES (?1,'rss',?1,?2,?3,1,1,'hash','{}',?4,?4)`).bind(sourceId, `https://${sourceId}.example.com/feed`, JSON.stringify({ authority }), now).run();
    await env.DB.prepare(`INSERT INTO runs(id,job_key,workflow_id,kind,state,source_id,scheduled_at,deadline_at,params_json,created_at,updated_at)
      VALUES (?1,?2,?3,'collect','completed',?4,?5,?6,'{}',?5,?5)`).bind(`run-${sourceId}`, `job-${sourceId}`, `wf-${sourceId}`, sourceId, now, now + 1000).run();
    await env.DB.prepare(`INSERT INTO collection_pages(run_id,page_no,request_cursor_json,status,committed_at) VALUES (?1,0,'null','committed',?2)`)
      .bind(`run-${sourceId}`, now).run();
    await env.DB.prepare(`INSERT INTO items(id,source_id,external_key,canonical_url,first_seen_at,last_seen_at,current_revision)
      VALUES (?1,?2,?3,?4,?5,?5,1)`).bind(`item-${sourceId}`, sourceId, `external-${sourceId}`, `https://${sourceId}.example.com/widget`, now).run();
    await env.DB.prepare(`INSERT INTO item_versions(id,item_id,revision,ingest_key,collection_run_id,collection_page_no,content_hash,title,canonical_url,ingested_at,body_text,quality,metadata_json)
      VALUES (?1,?2,1,?3,?4,0,?5,'Acme Widget 2.0 released',?6,?7,'Acme confirms Widget 2.0 is now generally available.','full','{}')`)
      .bind(`version-${sourceId}`, `item-${sourceId}`, `ingest-${sourceId}`, `run-${sourceId}`, `content-${sourceId}`, `https://${sourceId}.example.com/widget`, now).run();
  }
  await env.DB.prepare(`INSERT INTO digests(id,profile_id,local_date,timezone,mode,status,window_start_at,cutoff_at,build_deadline_at,send_at,send_deadline_at,frozen_at,build_generation,config_snapshot_json,coverage_json,created_at,updated_at)
    VALUES ('digest-today','personal','2026-09-21','Asia/Shanghai','scheduled','building',?1,?2,?3,?4,?5,?2,0,'{}','{"coreTotal":2,"coreFailed":0}',?6,?6)`)
    .bind(now - 172_800_000, now + 1000, now + 60_000, now + 120_000, now + 180_000, now).run();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO digest_candidates VALUES ('digest-today','item-official-a','version-official-a',1,'new')"),
    env.DB.prepare("INSERT INTO digest_candidates VALUES ('digest-today','item-official-b','version-official-b',2,'new')"),
  ]);
}

function frozenSource(id: string) {
  return { id, name: id, kind: 'rss' as const, url: `https://${id}.example.com/feed`, enabled: true,
    core: true, priority: 100, authority: 'official' as const, allowedHosts: [`${id}.example.com`],
    intervalHours: 1, verification: 'worker_verified' as const, browserFallbackEnabled: false };
}

describe('editorial pipeline', () => {
  beforeEach(reset);

  it('collapses two official sources for one event and commits an immutable cited snapshot', async () => {
    const now = Date.parse('2026-09-21T00:00:00Z');
    await seed(now);
    const content = await buildDigest('digest-today', 0, { db: env.DB, now: () => now + 2000 });
    expect(content.cards).toHaveLength(1);
    expect(content.cards[0]?.sourceVersionIds).toEqual(['version-official-a', 'version-official-b']);
    const persisted = await env.DB.prepare('SELECT status,content_json,rendered_html FROM digests WHERE id=?1').bind('digest-today').first<{ status: string; content_json: string; rendered_html: string }>();
    expect(persisted?.status).toBe('ready');
    expect(persisted?.rendered_html).toContain('official-a.example.com/widget');
    expect(JSON.parse(persisted!.content_json)).toEqual(content);
  });

  it('uses bounded filter, group, and Chinese edit model stages when a completion adapter is available', async () => {
    const now = Date.parse('2026-09-21T00:00:00Z');
    await seed(now);
    const app = JSON.parse(env.APP_CONFIG as string);
    await env.DB.prepare('UPDATE digests SET config_snapshot_json=json(?1) WHERE id=?2')
      .bind(JSON.stringify({ app, sources: [] }), 'digest-today').run();
    const stages: string[] = [];
    const content = await buildDigest('digest-today', 0, {
      db: env.DB,
      now: () => now + 2000,
      complete: async (call) => {
        stages.push(call.ownerStage);
        if (call.ownerStage === 'filter') return { value: { results: [
          { itemVersionId: 'version-official-a', decision: 'keep', scores: { relevance: 95, impact: 80, evidence: 90, novelty: 85, actionability: 70 } },
          { itemVersionId: 'version-official-b', decision: 'keep', scores: { relevance: 95, impact: 80, evidence: 90, novelty: 85, actionability: 70 } },
        ] }, usage: null, providerRequestId: null };
        if (call.ownerStage === 'group') return { value: { groups: [
          { eventKey: 'acme-widget-2-0-release', memberIds: ['version-official-a', 'version-official-b'], confidence: 0.99 },
        ] }, usage: null, providerRequestId: null };
        return { value: { cards: [{ eventKey: 'acme-widget-2-0-release', title: 'Acme Widget 2.0 正式发布',
          summary: 'Acme 已确认 Widget 2.0 正式可用。', whyItMatters: '这会影响升级与兼容性评估。', suggestedAction: '先在测试环境验证。',
          facts: [{ text: 'Acme confirms Widget 2.0 is now generally available.', evidence: [{
            itemVersionId: 'version-official-a', quote: 'Acme confirms Widget 2.0 is now generally available.',
          }] }] }] },
          usage: null, providerRequestId: null };
      },
    });
    expect(stages).toEqual(['filter', 'group', 'edit']);
    expect(content.cards[0]?.title).toBe('Acme Widget 2.0 正式发布');
    expect(content.cards[0]?.summary).toBe('模型摘要：Acme 已确认 Widget 2.0 正式可用。');
    expect(content.cards[0]?.whyItMatters).toContain('模型判断：');
    expect(content.cards[0]?.facts[0]?.evidence[0]?.quote).toContain('generally available');
  });

  it('caps filter calls at the persisted per-stage attempt limit', async () => {
    const versions: ItemVersion[] = Array.from({ length: 200 }, (_, index) => ({
      id: `version-${String(index).padStart(3, '0')}`,
      itemId: `item-${index}`,
      sourceId: 'source',
      revision: 1,
      title: `Release ${index}`,
      canonicalUrl: `https://example.com/${index}`,
      publishedAt: null,
      ingestedAt: index,
      bodyText: `Body ${index}`,
      quality: 'full',
      contentHash: `hash-${index}`,
    }));
    const complete = vi.fn(async (call) => {
      const envelope = call.request.input as { payload: { candidates: Array<{ itemVersionId: string }> } };
      return { value: { results: envelope.payload.candidates.map((candidate) => ({
        itemVersionId: candidate.itemVersionId,
        decision: 'drop' as const,
        scores: { relevance: 0, impact: 0, evidence: 0, novelty: 0, actionability: 0 },
      })) }, usage: null, providerRequestId: null };
    });

    await runEditorialModel({
      digestId: 'digest-bounded', generation: 0, deadlineAt: Date.now() + 60_000,
      maxOutputTokens: 500, promptVersion: 'v1', maxCharsPerArticle: 12_000,
      maxDeepRead: 20, maxEvents: 8, maxRepairAttempts: 1, maxAttemptsPerStage: 3,
      versions, deterministicGroups: [], complete,
    });

    expect(complete).toHaveBeenCalledTimes(3);
  });

  it('does not invoke a model for a legacy root-level config snapshot', async () => {
    const now = Date.parse('2026-09-21T00:00:00Z');
    await seed(now);
    const app = JSON.parse(env.APP_CONFIG as string);
    await env.DB.prepare('UPDATE digests SET config_snapshot_json=json(?1) WHERE id=?2')
      .bind(JSON.stringify(app), 'digest-today').run();
    const complete = vi.fn().mockRejectedValue(new Error('model must not run'));

    await buildDigest('digest-today', 0, { db: env.DB, now: () => now + 2000, complete });

    expect(complete).not.toHaveBeenCalled();
  });

  it('reports failed core coverage even when community candidates are available', async () => {
    const now = Date.parse('2026-09-21T00:00:00Z');
    await seed(now);
    await env.DB.prepare(`UPDATE digests SET coverage_json=json('{"coreTotal":2,"coreFailed":2}') WHERE id='digest-today'`).run();

    const content = await buildDigest('digest-today', 0, { db: env.DB, now: () => now + 2000 });

    expect(content.cards.length).toBeGreaterThan(0);
    expect(content.coverageNote).toContain('采集异常');
    expect(content.noImportantUpdates).toBe(false);
  });

  it('reports a coverage gap when no core source is configured', async () => {
    const now = Date.parse('2026-09-21T00:00:00Z');
    await seed(now);
    await env.DB.prepare(`UPDATE digests SET coverage_json=json('{"coreTotal":0,"coreFailed":0}') WHERE id='digest-today'`).run();

    const content = await buildDigest('digest-today', 0, { db: env.DB, now: () => now + 2000 });

    expect(content.coverageNote).toContain('采集异常');
    expect(content.noImportantUpdates).toBe(false);
  });

  it('does not repeat an event already exposed by an uncertain delivery without new information', async () => {
    const now = Date.parse('2026-09-21T00:00:00Z');
    await seed(now);
    await env.DB.prepare(`INSERT INTO digests(id,profile_id,local_date,timezone,mode,status,window_start_at,cutoff_at,build_deadline_at,send_at,send_deadline_at,build_generation,config_snapshot_json,content_json,created_at,updated_at)
      VALUES ('digest-yesterday','personal','2026-09-20','Asia/Shanghai','scheduled','uncertain',?1,?2,?3,?4,?5,0,'{}','{}',?6,?6)`)
      .bind(now - 259_200_000, now - 86_400_000, now - 86_300_000, now - 86_200_000, now - 86_100_000, now - 86_400_000).run();
    await env.DB.prepare(`INSERT INTO events VALUES ('old-event','acme-widget-2-0-release','Acme','Widget','2.0','release',?1)`).bind(now).run();
    await env.DB.prepare(`INSERT INTO event_versions VALUES ('old-version','old-event',1,'facts','{}',?1)`).bind(now).run();
    await env.DB.prepare(`INSERT INTO digest_events VALUES ('digest-yesterday','old-version',1,?1)`)
      .bind(JSON.stringify({ eventKey: 'acme-widget-2-0-release' })).run();
    await env.DB.prepare(`INSERT INTO deliveries(id,digest_id,channel,destination_key,destination_config_ref,payload_json,payload_hash,status,created_at,updated_at)
      VALUES ('delivery-old','digest-yesterday','cloudflare_email','dest','ref','{}','hash','uncertain',?1,?1)`).bind(now).run();
    const content = await buildDigest('digest-today', 0, { db: env.DB, now: () => now + 2000 });
    expect(content.cards).toEqual([]);
    expect(content.noImportantUpdates).toBe(true);
  });

  it('uses the frozen history window instead of a hard-coded thirty-day lookup', async () => {
    const now = Date.parse('2026-09-21T00:00:00Z');
    await seed(now);
    const app = JSON.parse(env.APP_CONFIG as string);
    app.editorial.historyDays = 10;
    await env.DB.prepare("UPDATE digests SET config_snapshot_json=json(?1) WHERE id='digest-today'")
      .bind(JSON.stringify({ app, sources: [frozenSource('official-a'), frozenSource('official-b')] })).run();
    const old = now - 20 * 86_400_000;
    await env.DB.prepare(`INSERT INTO digests(id,profile_id,local_date,timezone,mode,status,window_start_at,cutoff_at,
      build_deadline_at,send_at,send_deadline_at,build_generation,config_snapshot_json,content_json,created_at,updated_at)
      VALUES ('digest-old','personal','2026-09-01','Asia/Shanghai','scheduled','uncertain',?1,?2,?3,?4,?5,0,'{}','{}',?2,?2)`)
      .bind(old - 86_400_000, old, old + 1000, old + 2000, old + 3000).run();
    await env.DB.prepare(`INSERT INTO events VALUES ('history-event','acme-widget-2-0-release','Acme','Widget','2.0','release',?1)`).bind(old).run();
    await env.DB.prepare(`INSERT INTO event_versions VALUES ('history-version','history-event',1,'facts','{}',?1)`).bind(old).run();
    await env.DB.prepare(`INSERT INTO digest_events VALUES ('digest-old','history-version',1,?1)`)
      .bind(JSON.stringify({ eventKey: 'acme-widget-2-0-release' })).run();
    await env.DB.prepare(`INSERT INTO deliveries(id,digest_id,channel,destination_key,destination_config_ref,payload_json,payload_hash,status,created_at,updated_at)
      VALUES ('history-delivery','digest-old','dummy','dest','ref','{}','hash','uncertain',?1,?1)`).bind(old).run();

    const content = await buildDigest('digest-today', 0, { db: env.DB, now: () => now + 2000 });

    expect(content.cards).toHaveLength(1);
  });

  it('reports a collection incident instead of claiming no news when every core source failed', async () => {
    const now = Date.parse('2026-09-21T00:00:00Z');
    await env.DB.prepare(`INSERT INTO sources(id,kind,name,url,config_json,enabled,is_core,config_hash,cursor_json,failure_count,created_at,updated_at)
      VALUES ('core','rss','Core','https://core.example.com/feed','{}',1,1,'hash','{}',3,?1,?1)`).bind(now).run();
    await env.DB.prepare(`INSERT INTO digests(id,profile_id,local_date,timezone,mode,status,window_start_at,cutoff_at,build_deadline_at,send_at,send_deadline_at,frozen_at,build_generation,config_snapshot_json,coverage_json,created_at,updated_at)
      VALUES ('digest-incident','personal','2026-09-21','Asia/Shanghai','scheduled','building',?1,?2,?3,?4,?5,?2,0,'{}','{"coreTotal":1,"coreFailed":1}',?6,?6)`)
      .bind(now - 172_800_000, now + 1000, now + 60_000, now + 120_000, now + 180_000, now).run();
    const content = await buildDigest('digest-incident', 0, { db: env.DB, now: () => now + 2000 });
    expect(content.coverageNote).toContain('采集异常');
    expect(content.noImportantUpdates).toBe(false);
  });
});
