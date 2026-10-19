import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApplication, syncSources, type RuntimeEnv } from '../../src/app';

const tables = ['delivery_attempts','deliveries','digest_events','digest_candidates','event_versions','events',
  'llm_calls','budget_buckets','request_keys','item_versions','collection_pages','items','source_leases','runs','digests','sources'];
beforeEach(async () => { await env.DB.batch(tables.map(table => env.DB.prepare(`DELETE FROM ${table}`))); });

describe('D1 background query budget', () => {
  it('uses one read and zero writes for unchanged configuration across application instances', async () => {
    const now = Date.parse('2026-10-20T02:00:00Z');
    const app = createApplication(env as unknown as RuntimeEnv, () => now);
    await app.prepare();
    const id = app.config.sources[0]!.id;
    await env.DB.prepare(`UPDATE sources SET cursor_version=7,last_success_at=?1,
      failure_count=2,last_error_code='HTTP_TIMEOUT' WHERE id=?2`).bind(now - 1000, id).run();
    let prepared = 0;
    let batches = 0;
    const countedDb = { prepare(sql: string) { prepared++; return env.DB.prepare(sql); },
      batch(statements: D1PreparedStatement[]) { batches++; return env.DB.batch(statements); } } as D1Database;
    await createApplication({ ...env, DB: countedDb } as unknown as RuntimeEnv, () => now + 1000).prepare();
    expect(prepared).toBe(1);
    expect(batches).toBe(0);
    expect(await env.DB.prepare('SELECT updated_at,cursor_version,last_success_at,failure_count,last_error_code FROM sources WHERE id=?1')
      .bind(id).first()).toEqual({ updated_at: now, cursor_version: 7, last_success_at: now - 1000,
        failure_count: 2, last_error_code: 'HTTP_TIMEOUT' });
  });

  it('writes only a changed source and reconciles a manually changed enabled flag', async () => {
    const now = Date.parse('2026-10-20T02:00:00Z');
    const app = createApplication(env as unknown as RuntimeEnv, () => now);
    await app.prepare();
    const changed = structuredClone(app.config.sources);
    changed[0]!.priority = changed[0]!.priority === 100 ? 99 : changed[0]!.priority + 1;
    await syncSources(env.DB, changed, now + 1000);
    expect((await env.DB.prepare('SELECT id FROM sources WHERE updated_at=?1').bind(now + 1000).all()).results)
      .toEqual([{ id: changed[0]!.id }]);
    await env.DB.prepare('UPDATE sources SET enabled=1-enabled WHERE id=?1').bind(changed[0]!.id).run();
    await syncSources(env.DB, changed, now + 2000);
    expect(await env.DB.prepare('SELECT enabled FROM sources WHERE id=?1').bind(changed[0]!.id).first())
      .toEqual({ enabled: Number(changed[0]!.enabled) });
  });

  it('runs retention on the hourly maintenance cron and keeps five-minute recovery independent', async () => {
    const now = Date.parse('2026-10-20T02:05:00Z');
    const old = now - 40 * 86_400_000;
    await env.DB.prepare(`INSERT INTO runs(id,job_key,workflow_id,kind,state,scheduled_at,deadline_at,
      params_json,created_at,updated_at) VALUES ('old-run','old-job','old-workflow','collect','completed',?1,?1,'{}',?1,?1)`)
      .bind(old).run();
    const app = createApplication(env as unknown as RuntimeEnv, () => now);
    await app.scheduled({ cron: '*/5 * * * *', scheduledTime: now } as ScheduledController);
    expect(await env.DB.prepare("SELECT id FROM runs WHERE id='old-run'").first()).toEqual({ id: 'old-run' });
    await app.scheduled({ cron: '15 * * * *', scheduledTime: now + 600_000 } as ScheduledController);
    expect(await env.DB.prepare("SELECT id FROM runs WHERE id='old-run'").first()).toBeNull();
  });
});
