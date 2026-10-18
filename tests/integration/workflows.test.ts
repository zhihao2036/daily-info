import { env } from 'cloudflare:workers';
import { introspectWorkflowInstance } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DigestRepository } from '../../src/db/repositories/digests';
import { RunRepository } from '../../src/db/repositories/runs';
import { sha256 } from '../../src/db/repositories/shared';
import { dispatchRun } from '../../src/scheduler/dispatch';
import { reconcile } from '../../src/scheduler/reconcile';
import { digestTimes, previewTimes } from '../../src/scheduler/time';
import { createApplication, type RuntimeEnv } from '../../src/app';
import type { DigestParams } from '../../src/domain/contracts';
import { CollectSourceWorkflow } from '../../src/workflows/collect-source';
import { DailyDigestWorkflow } from '../../src/workflows/daily-digest';

const tables = [
  'delivery_attempts', 'deliveries', 'digest_events', 'digest_candidates', 'event_versions', 'events',
  'llm_calls', 'budget_buckets', 'request_keys', 'item_versions', 'collection_pages', 'items',
  'source_leases', 'runs', 'digests', 'sources',
  'browser_fallback_attempts', 'browser_usage_days',
] as const;

async function resetDatabase(): Promise<void> {
  await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}

describe('durable workflow dispatch and recovery', () => {
  beforeEach(resetDatabase);

  it('records an access-denied source as failed and prevents Workflow step retries', async () => {
    const now = Date.now();
    const source = { id: 'blocked-official', kind: 'html_list', name: 'Official', url: 'https://example.com/news',
      allowedHosts: ['example.com'], html: { listLinkSelector: 'main a', articleSelector: 'article' },
      enabled: true, core: true, priority: 90, authority: 'official', intervalHours: 6,
      verification: 'worker_verified', browserFallbackEnabled: false };
    await env.DB.prepare(`INSERT INTO sources(id,kind,name,url,config_json,enabled,is_core,config_hash,created_at,updated_at)
      VALUES (?1,'html_list','Official',?2,?3,1,1,'hash',?4,?4)`)
      .bind(source.id, source.url, JSON.stringify(source), now).run();
    await env.DB.prepare(`INSERT INTO runs(id,job_key,workflow_id,kind,state,source_id,scheduled_at,deadline_at,params_json,created_at,updated_at)
      VALUES ('blocked-run','blocked-job','blocked-workflow','collect','running',?1,?2,?3,'{}',?2,?2)`)
      .bind(source.id, now, now + 60_000).run();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('denied', { status: 403 }));
    const step = { do: async (...args: unknown[]) => await (args.at(-1) as () => Promise<unknown>)() };
    const event = { payload: { runId: 'blocked-run', sourceId: source.id, slotKey: 'test', scheduledAt: now,
      deadlineAt: now + 60_000 } };
    await expect(CollectSourceWorkflow.prototype.run.call({ env: { DB: env.DB } } as unknown as CollectSourceWorkflow,
      event as Parameters<CollectSourceWorkflow['run']>[0], step as Parameters<CollectSourceWorkflow['run']>[1]))
      .rejects.toMatchObject({ name: 'NonRetryableError', message: 'HTTP_STATUS:403' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT state,error_code FROM runs WHERE id='blocked-run'").first())
      .toMatchObject({ state: 'failed', error_code: 'HTTP_STATUS:403' });
    fetcher.mockRestore();
  });

  it('disables a previously known source when it is removed from runtime configuration', async () => {
    const now = Date.parse('2026-09-21T00:00:00Z');
    await env.DB.prepare(`INSERT INTO sources(
      id,kind,name,url,config_json,enabled,is_core,config_hash,cursor_json,created_at,updated_at
    ) VALUES ('removed-source','rss','Removed','https://example.com/feed','{}',1,1,'hash','{}',?1,?1)`)
      .bind(now).run();
    const app = createApplication(env as unknown as RuntimeEnv, () => now + 1);

    await app.prepare();

    expect(await env.DB.prepare("SELECT enabled FROM sources WHERE id='removed-source'").first())
      .toMatchObject({ enabled: 0 });
  });

  it('returns only aggregate Browser Run status', async () => {
    const now = Date.parse('2026-09-21T00:00:00Z');
    await env.DB.prepare(`INSERT INTO sources(id,kind,name,url,config_json,enabled,is_core,config_hash,created_at,updated_at,
      browser_cooldown_until,last_browser_error_code) VALUES ('browser-source','rss','Browser','https://example.com/private?token=secret',
      '{}',1,0,'hash',?1,?1,?2,'BROWSER_BLOCKED_403')`).bind(now, now + 60_000).run();
    await env.DB.prepare(`INSERT INTO browser_usage_days(date_utc,browser_ms_used,pages_used,reserved_browser_ms,reserved_pages,updated_at)
      VALUES ('2026-09-21',1234,1,0,0,?1)`).bind(now).run();
    const app = createApplication(env as unknown as RuntimeEnv, () => now);

    const status = await app.read('/api/status');
    expect(status).toMatchObject({ browser: { dateUtc: '2026-09-21', remainingPages: 49,
      remainingMs: 598766, coolingSources: 1, lastErrorCode: 'BROWSER_BLOCKED_403' } });
    expect(JSON.stringify(status)).not.toContain('token=secret');
  });

  it('persists the run before create and deduplicates a repeated schedule slot', async () => {
    const now = Date.parse('2026-09-21T00:00:00Z');
    await env.DB.prepare(`INSERT INTO sources(
      id,kind,name,url,config_json,enabled,is_core,config_hash,created_at,updated_at
    ) VALUES ('source-a','rss','Source A','https://example.com/feed','{}',1,1,'hash',?1,?1)`).bind(now).run();
    const runs = new RunRepository(env.DB);
    let creates = 0;
    const binding = {
      async create(input: { id: string }): Promise<void> {
        const row = await runs.getByWorkflowId(input.id);
        expect(row?.state).toBe('pending_create');
        creates += 1;
      },
      async get(): Promise<{ status(): Promise<{ status: string }> }> {
        throw new Error('not used');
      },
    };
    const input = {
      jobKey: 'collect:source-a:2026-09-21T00', kind: 'collect' as const, sourceId: 'source-a',
      digestId: null, generation: 0, scheduledAt: now, deadlineAt: now + 3_600_000,
      params: { runId: '', sourceId: 'source-a', slotKey: '2026-09-21T00', scheduledAt: now, deadlineAt: now + 3_600_000 },
    };
    const first = await dispatchRun(runs, binding, input, now);
    const second = await dispatchRun(runs, binding, input, now);
    expect(second.runId).toBe(first.runId);
    expect(creates).toBe(1);
  });

  it('repairs create success followed by a lost D1 observation without restarting', async () => {
    const now = Date.parse('2026-09-21T00:00:00Z');
    const runs = new RunRepository(env.DB);
    const row = await runs.register({
      jobKey: 'collect:lost-observation', kind: 'collect', sourceId: null, digestId: null,
      generation: 0, scheduledAt: now, deadlineAt: now + 3_600_000, params: {}, now,
    });
    let creates = 0;
    let statusReads = 0;
    const binding = {
      async create(): Promise<void> { creates += 1; },
      async get(id: string): Promise<{ status(): Promise<{ status: string }> }> {
        expect(id).toBe(row.workflowId);
        return { async status() { statusReads += 1; return { status: 'running' }; } };
      },
    };
    const result = await reconcile(now + 1, { runs, bindings: { collect: binding }, limit: 20 });
    expect(result).toEqual({ scanned: 1, repaired: 1, created: 0, expired: 0 });
    expect(creates).toBe(0);
    expect(statusReads).toBe(1);
    expect((await runs.get(row.runId))?.state).toBe('running');
  });

  it('reconciles a completed workflow to a terminal run instead of leaving it running forever', async () => {
    const now = Date.parse('2026-09-21T00:00:00Z');
    const runs = new RunRepository(env.DB);
    const row = await runs.register({
      jobKey: 'collect:already-complete', kind: 'collect', sourceId: null, digestId: null,
      generation: 0, scheduledAt: now, deadlineAt: now + 3_600_000, params: {}, now,
    });
    const binding = {
      async create(): Promise<void> { throw new Error('must not recreate'); },
      async get(): Promise<{ status(): Promise<{ status: string }> }> {
        return { async status() { return { status: 'complete' }; } };
      },
    };

    await reconcile(now + 1, { runs, bindings: { collect: binding }, limit: 20 });

    expect((await runs.get(row.runId))?.state).toBe('completed');
  });

  it('reconciles a stale running workflow failure without recreating it', async () => {
    const now = Date.parse('2026-09-21T00:00:00Z');
    const runs = new RunRepository(env.DB);
    const row = await runs.register({
      jobKey: 'collect:running-error', kind: 'collect', sourceId: null, digestId: null,
      generation: 0, scheduledAt: now, deadlineAt: now + 3_600_000, params: {}, now,
    });
    await runs.markObserved(row.runId, now);
    const create = vi.fn();
    const binding = {
      create,
      async get(): Promise<{ status(): Promise<{ status: string }> }> {
        return { async status() { return { status: 'errored' }; } };
      },
    };

    await reconcile(now + 11 * 60_000, { runs, bindings: { collect: binding }, limit: 20 });

    expect(create).not.toHaveBeenCalled();
    expect(await runs.get(row.runId)).toMatchObject({ state: 'failed', errorCode: 'WORKFLOW_ERRORED' });
  });

  it('fences a stale generator and never rewrites a ready snapshot', async () => {
    const now = Date.parse('2026-09-21T00:25:00Z');
    const digests = new DigestRepository(env.DB, { now: () => now });
    const times = {
      localDate: '2026-09-21', morningAt: now - 2_400_000, cutoffAt: now - 1_500_000,
      buildDeadlineAt: now, sendAt: now + 300_000, sendDeadlineAt: now + 2_100_000,
    };
    const digest = await digests.ensure({ profileId: 'personal', mode: 'scheduled', times, configSnapshot: {}, now });
    const generation = await digests.claimFallback(digest.id, 0, now);
    expect(generation).toBe(1);
    expect(await digests.commitSnapshot(digest.id, 0, { marker: 'stale' }, 'stale', 'stale', now)).toBe(false);
    expect(await digests.commitSnapshot(digest.id, 1, { marker: 'fallback' }, 'fallback', '<p>fallback</p>', now)).toBe(true);
    expect(await digests.commitSnapshot(digest.id, 1, { marker: 'rewrite' }, 'rewrite', '<p>rewrite</p>', now)).toBe(false);
  });

  it('lets the independent 08:25 heartbeat fence a stuck editor and commit a fallback', async () => {
    const now = Date.parse('2026-09-21T00:25:00Z');
    await env.DB.prepare(`INSERT INTO sources(
      id,kind,name,url,config_json,enabled,is_core,config_hash,cursor_json,failure_count,created_at,updated_at
    ) VALUES ('stale-core','rss','Stale Core','https://example.com/feed','{}',1,1,'hash','{}',0,?1,?1)`)
      .bind(now - 86_400_000).run();
    const app = createApplication(env as unknown as RuntimeEnv, () => now);
    await app.scheduled({ cron: '*/5 * * * *', scheduledTime: now,
      noRetry() {} } as unknown as ScheduledController);
    const digest = await env.DB.prepare("SELECT status,build_generation,content_json FROM digests WHERE mode='scheduled'")
      .first<{ status: string; build_generation: number; content_json: string | null }>();
    expect(digest).toMatchObject({ status: 'ready', build_generation: 1 });
    expect(JSON.parse(digest!.content_json!)).toMatchObject({ degradedReason: 'core_sources_failed', noImportantUpdates: false });
  });

  it('dispatches exactly one current-generation delivery path at 08:30 after heartbeat fallback', async () => {
    let current = Date.parse('2026-09-21T00:25:00Z');
    const creates = vi.fn(async (_input: { id: string; params: DigestParams }) => undefined);
    const dailyWorkflow = {
      create: creates,
      async get(): Promise<{ status(): Promise<{ status: string }> }> {
        return { async status() { return { status: 'running' }; } };
      },
    };
    const app = createApplication({ ...env, DAILY_WORKFLOW: dailyWorkflow } as unknown as RuntimeEnv, () => current);
    await app.scheduled({ cron: '*/5 * * * *', scheduledTime: current, noRetry() {} } as unknown as ScheduledController);
    const digest = await env.DB.prepare("SELECT id,build_generation FROM digests WHERE mode='scheduled'")
      .first<{ id: string; build_generation: number }>();
    expect(digest?.build_generation).toBe(1);

    current = Date.parse('2026-09-21T00:30:00Z');
    await app.scheduled({ cron: '*/5 * * * *', scheduledTime: current, noRetry() {} } as unknown as ScheduledController);
    await app.scheduled({ cron: '*/5 * * * *', scheduledTime: current, noRetry() {} } as unknown as ScheduledController);

    expect(creates).toHaveBeenCalledTimes(1);
    expect(creates.mock.calls[0]?.[0]).toMatchObject({ params: { digestId: digest?.id, generation: 1 } });
    expect(await env.DB.prepare("SELECT kind,generation FROM runs WHERE kind='recovery'").first())
      .toMatchObject({ kind: 'recovery', generation: 1 });
  });

  it('executes a real Workflow instance for a historical preview', async () => {
    const now = Date.now();
    const digests = new DigestRepository(env.DB, { now: () => now });
    const times = previewTimes('2026-08-31', now);
    const digest = await digests.ensure({ profileId: 'personal', mode: 'preview', times, configSnapshot: {}, now });
    const runs = new RunRepository(env.DB);
    const run = await runs.register({
      jobKey: `preview:${digest.id}`, kind: 'preview', sourceId: null, digestId: digest.id,
      generation: 0, scheduledAt: now, deadlineAt: times.buildDeadlineAt, params: {}, now,
    });
    await using instance = await introspectWorkflowInstance(env.DAILY_WORKFLOW, run.workflowId);
    await instance.modify(async (modifier) => { await modifier.disableSleeps(); });
    await env.DAILY_WORKFLOW.create({
      id: run.workflowId,
      params: { runId: run.runId, digestId: digest.id, mode: 'preview', generation: 0, scheduledAt: now, deadlineAt: times.buildDeadlineAt },
    });
    await instance.waitForStatus('complete');
    expect(await instance.getOutput()).toMatchObject({ digestId: digest.id, mode: 'preview' });
    expect((await runs.get(run.runId))?.state).toBe('completed');
  });

  it('runs a delayed scheduled recovery without sleeping until past timestamps or sending after close', async () => {
    const now = Date.now();
    const digests = new DigestRepository(env.DB, { now: () => now });
    const times = { localDate: '2026-09-21', morningAt: now - 600_000, cutoffAt: now - 300_000,
      buildDeadlineAt: now - 180_000, sendAt: now - 120_000, sendDeadlineAt: now - 60_000 };
    const digest = await digests.ensure({ profileId: 'personal', mode: 'scheduled', times, configSnapshot: {}, now });
    const runs = new RunRepository(env.DB);
    const run = await runs.register({ jobKey: 'delayed-recovery', kind: 'recovery', sourceId: null,
      digestId: digest.id, generation: 0, scheduledAt: times.morningAt, deadlineAt: times.sendDeadlineAt, params: {}, now });
    const sleepUntil = vi.fn(async (_name: string, target: number) => {
      if (target <= Date.now()) throw new Error('Cannot sleep in the past');
    });
    const step = { do: async (...args: unknown[]) => await (args.at(-1) as () => Promise<unknown>)(), sleepUntil };
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      await DailyDigestWorkflow.prototype.run.call({ env } as unknown as DailyDigestWorkflow,
        { payload: { runId: run.runId, digestId: digest.id, mode: 'scheduled', generation: 0,
          scheduledAt: times.morningAt, deadlineAt: times.sendDeadlineAt } } as Parameters<DailyDigestWorkflow['run']>[0],
        step as unknown as Parameters<DailyDigestWorkflow['run']>[1]);
      expect(sleepUntil).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
      expect((await runs.get(run.runId))?.state).toBe('completed');
    } finally {
      fetcher.mockRestore();
    }
  });

  it('delivers a next-day digest at 08:30 and does not send it again during recovery', async () => {
    const times = digestTimes(Date.parse('2026-10-19T07:45:00+08:00'));
    let current = times.morningAt;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => current);
    const appConfig = JSON.parse(env.APP_CONFIG as string);
    appConfig.delivery = { channel: 'telegram', destinationConfigRef: 'next-day-private-chat' };
    const chatId = '987654321';
    const destinationKey = await sha256(chatId);
    const runtime = { ...env, APP_ENV: 'production', SEND_ENABLED: 'true', APP_CONFIG: JSON.stringify(appConfig),
      TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz', TELEGRAM_CHAT_ID: chatId };
    const digests = new DigestRepository(env.DB, { now: () => current });
    const digest = await digests.ensure({ profileId: 'personal', mode: 'scheduled', times,
      configSnapshot: { app: appConfig, sources: [], deliveryDestinationKey: destinationKey }, now: current });
    const text = `${'日报正文'.repeat(200)}\nhttps://example.com/source`;
    await digests.commitSnapshot(digest.id, 0, { cards: [] }, text, '<p>report</p>', current);
    const runs = new RunRepository(env.DB);
    const run = await runs.register({ jobKey: 'next-day-0830', kind: 'digest', sourceId: null,
      digestId: digest.id, generation: 0, scheduledAt: times.morningAt, deadlineAt: times.sendDeadlineAt, params: {}, now: current });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(current).toBe(times.sendAt + 1);
      expect(String(input)).toMatch(/\/sendMessage$/);
      expect(JSON.parse(String(init?.body)).text).toContain(text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 44 } }));
    });
    const sleepUntil = vi.fn(async (_name: string, target: number) => {
      expect(target).toBeGreaterThan(current);
      current = target + 1;
    });
    const step = { do: async (...args: unknown[]) => await (args.at(-1) as () => Promise<unknown>)(), sleepUntil };
    try {
      await DailyDigestWorkflow.prototype.run.call({ env: runtime } as unknown as DailyDigestWorkflow,
        { payload: { runId: run.runId, digestId: digest.id, mode: 'scheduled', generation: 0,
          scheduledAt: times.morningAt, deadlineAt: times.sendDeadlineAt } } as Parameters<DailyDigestWorkflow['run']>[0],
        step as unknown as Parameters<DailyDigestWorkflow['run']>[1]);
      current = times.sendAt + 5 * 60_000;
      const app = createApplication(runtime as unknown as RuntimeEnv, () => current);
      await app.scheduled({ cron: '*/5 * * * *', scheduledTime: current, noRetry() {} } as unknown as ScheduledController);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(await env.DB.prepare('SELECT status,provider_message_id FROM deliveries WHERE digest_id=?1').bind(digest.id).first())
        .toMatchObject({ status: 'sent', provider_message_id: '44' });
      expect(await env.DB.prepare('SELECT status,accepted_at FROM digests WHERE id=?1').bind(digest.id).first())
        .toMatchObject({ status: 'sent', accepted_at: times.sendAt + 1 });
    } finally {
      clock.mockRestore();
      fetcher.mockRestore();
    }
  });
});
