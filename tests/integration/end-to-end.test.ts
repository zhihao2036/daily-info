import { env } from 'cloudflare:workers';
import { introspectWorkflowInstance } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import feedXml from '../../fixtures/synthetic-feed.xml?raw';
import { createCollector } from '../../src/collectors';
import { D1Persistence } from '../../src/db/repositories';
import { DigestRepository } from '../../src/db/repositories/digests';
import { RunRepository } from '../../src/db/repositories/runs';
import type { Json, SourceConfig } from '../../src/domain/contracts';
import { digestTimes } from '../../src/scheduler/time';
import { requestHash } from '../../src/api/idempotency';
import { sha256 } from '../../src/db/repositories/shared';
import worker, { type Env } from '../../src/index';

const tables = [
  'delivery_attempts', 'deliveries', 'digest_events', 'digest_candidates', 'event_versions', 'events',
  'llm_calls', 'budget_buckets', 'request_keys', 'item_versions', 'collection_pages', 'items',
  'source_leases', 'runs', 'digests', 'sources',
] as const;

async function reset(): Promise<void> { await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`))); }

describe('end-to-end composition', () => {
  beforeEach(reset);

  it('runs fixture collection through a real daily Workflow to ready and suppressed without a provider call', async () => {
    const now = Date.now();
    const times = digestTimes(now + 86_400_000);
    const source: SourceConfig = {
      id: 'e2e-feed', name: 'E2E fixture', kind: 'rss', url: 'https://example.com/feed', enabled: true,
      core: true, priority: 100, authority: 'official', allowedHosts: ['example.com'], intervalHours: 1,
      verification: 'worker_verified', browserFallbackEnabled: false,
    };
    await env.DB.prepare(`INSERT INTO sources(id,kind,name,url,config_json,enabled,is_core,config_hash,cursor_json,created_at,updated_at)
      VALUES (?1,'rss',?2,?3,?4,1,1,'hash','{}',?5,?5)`)
      .bind(source.id, source.name, source.url, JSON.stringify(source), now).run();
    await env.DB.prepare(`INSERT INTO runs(id,job_key,workflow_id,kind,state,source_id,scheduled_at,deadline_at,params_json,created_at,updated_at)
      VALUES ('collect-e2e','collect-e2e-job','collect-e2e-wf','collect','running',?1,?2,?3,'{}',?2,?2)`)
      .bind(source.id, now, times.cutoffAt).run();
    const collector = createCollector('rss', { fetcher: async () => new Response(feedXml, { headers: { 'content-type': 'application/rss+xml' } }) });
    const page = await collector.fetchPage({ source, cursor: null, deadlineAt: times.cutoffAt, signal: new AbortController().signal });
    expect(page.items).toHaveLength(3);
    page.items = page.items.map((item) => item.publishedAt === null
      ? item
      : { ...item, publishedAt: times.cutoffAt - 60 * 60_000 });
    page.items[1] = { ...page.items[1]!, title: page.items[0]!.title };
    const persistence = new D1Persistence(env.DB, { now: () => times.cutoffAt - 1 });
    const lease = await persistence.acquireLease(source.id, 'collect-e2e', times.cutoffAt - 2);
    await persistence.commitPage({ runId: 'collect-e2e', pageNo: 0, lease: lease!, items: page.items,
      requestCursor: null, expectedCursorVersion: 0, nextCursor: page.nextCursor, complete: true });

    const digests = new DigestRepository(env.DB, { now: () => now });
    const app = JSON.parse(env.APP_CONFIG as string);
    app.delivery.destinationConfigRef = 'frozen-destination';
    const deliveryDestinationKey = await sha256(app.delivery.destinationConfigRef);
    const configSnapshot = { app, sources: [source], deliveryDestinationKey } as unknown as Json;
    const first = await digests.ensure({ profileId: 'personal', mode: 'scheduled', times,
      configSnapshot, now });
    const replay = await digests.ensure({ profileId: 'personal', mode: 'scheduled', times,
      configSnapshot, now: now + 1 });
    expect(replay.id).toBe(first.id);
    const runs = new RunRepository(env.DB);
    const run = await runs.register({ jobKey: `digest:personal:${times.localDate}:0`, kind: 'digest', sourceId: null,
      digestId: first.id, generation: 0, scheduledAt: times.morningAt, deadlineAt: times.sendDeadlineAt, params: {}, now });
    await using instance = await introspectWorkflowInstance(env.DAILY_WORKFLOW, run.workflowId);
    await instance.modify(async (modifier) => { await modifier.disableSleeps(); });
    await env.DAILY_WORKFLOW.create({ id: run.workflowId, params: { runId: run.runId, digestId: first.id, mode: 'scheduled', generation: 0, scheduledAt: times.morningAt, deadlineAt: times.sendDeadlineAt } });
    await instance.waitForStatus('complete');

    const digest = await env.DB.prepare('SELECT status,content_json FROM digests WHERE id=?1').bind(first.id)
      .first<{ status: string; content_json: string }>();
    const content = JSON.parse(digest!.content_json) as { cards: unknown[] };
    expect(digest?.status).toBe('ready');
    expect(content.cards).toHaveLength(1);
    const response = await worker.fetch(new Request(`https://worker.test/api/digests/${first.id}`, {
      headers: { authorization: 'Bearer integration-admin-token-32-bytes!!' },
    }), env as unknown as Env);
    expect(response.status).toBe(200);
    const published = await response.json() as { renderedText: string; renderedHtml: string };
    expect(published.renderedText).toContain('https://example.com/');
    expect(published.renderedHtml).toContain('<a href="https://example.com/');
    expect(await env.DB.prepare(`SELECT status,destination_config_ref,destination_key,last_error_code FROM deliveries WHERE digest_id=?1`)
      .bind(first.id).first()).toMatchObject({ status: 'suppressed', destination_config_ref: 'frozen-destination',
        destination_key: deliveryDestinationKey, last_error_code: 'CONFIG_CHANGED' });
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM llm_calls').first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM digests WHERE mode='scheduled'").first<{ count: number }>())?.count).toBe(1);
  });

  it('dispatches a protected preview through HTTP and replays the same idempotency key', async () => {
    const key = 'e2e-preview-key-0001';
    const minuteSlot = Math.floor(Date.now() / 60_000);
    const identity = await sha256(`preview\n${key}\n${minuteSlot}\n${await requestHash({})}`);
    const expectedWorkflowId = `preview-${identity.slice(0, 64)}`;
    await using introspector = await introspectWorkflowInstance(env.DAILY_WORKFLOW, expectedWorkflowId);
    const request = () => worker.fetch(new Request('https://worker.test/api/preview', {
      method: 'POST',
      headers: { authorization: 'Bearer integration-admin-token-32-bytes!!', 'idempotency-key': key, 'content-type': 'application/json' },
      body: '{}',
    }), env as unknown as Env);
    const first = await request();
    expect(first.status).toBe(202);
    const accepted = await first.json() as { runId: string; workflowId: string; statusUrl: string };
    expect(accepted.workflowId).toBe(expectedWorkflowId);
    expect(accepted.statusUrl).toBe(`/api/runs/${accepted.runId}`);
    await introspector.waitForStatus('complete');
    const replay = await request();
    expect(await replay.json()).toEqual(accepted);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM digests WHERE mode='preview'").first<{ count: number }>())?.count).toBe(1);
  });
});
