import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserFallbackRepository } from '../../src/db/repositories/browser-fallback';
import type { Lease } from '../../src/domain/contracts';

const now = Date.parse('2026-09-21T00:00:00Z');
const tables = ['browser_fallback_attempts', 'browser_usage_days', 'source_leases', 'runs', 'sources'] as const;

async function reset(): Promise<void> {
  for (const table of tables) await env.DB.prepare(`DELETE FROM ${table}`).run();
}

async function seedSourceAndRuns(count: number): Promise<Lease> {
  await env.DB.prepare(`INSERT INTO sources(
    id,kind,name,url,config_json,enabled,is_core,config_hash,cursor_json,created_at,updated_at
  ) VALUES ('browser-source','html_list','Browser source','https://example.com/blog','{}',1,0,'hash','{}',?1,?1)`)
    .bind(now).run();
  await env.DB.batch(Array.from({ length: count }, (_, index) => env.DB.prepare(`INSERT INTO runs(
    id,job_key,workflow_id,kind,state,source_id,generation,scheduled_at,deadline_at,params_json,created_at,updated_at
  ) VALUES (?1,?2,?3,'collect','running','browser-source',0,?4,?5,'{}',?4,?4)`)
    .bind(`run-${index}`, `browser-job-${index}`, `browser-workflow-${index}`, now, now + 60_000)));
  await env.DB.prepare(`INSERT INTO source_leases(source_id,owner_id,fencing_token,expires_at)
    VALUES ('browser-source','owner',1,?1)`).bind(now + 120_000).run();
  return { sourceId: 'browser-source', ownerId: 'owner', fencingToken: 1, expiresAt: now + 120_000 };
}

describe('Browser Run D1 accounting', () => {
  beforeEach(reset);

  it('atomically caps concurrent reservations at ten minutes before reaching fifty pages', async () => {
    const lease = await seedSourceAndRuns(51);
    const repo = new BrowserFallbackRepository(env.DB, { now: () => now });
    const reservations = await Promise.all(Array.from({ length: 51 }, (_, index) => repo.reserve({
      sourceId: 'browser-source', runId: `run-${index}`, lease, urlHash: `url-${index}`, now,
    })));

    expect(reservations.filter((reservation) => reservation !== null)).toHaveLength(10);
    await expect(repo.state('browser-source', now)).resolves.toMatchObject({
      usage: { dateUtc: '2026-09-21', reservedPages: 10, reservedBrowserMs: 600_000 },
    });
  });

  it('charges a blocked request conservatively and puts that source on a 24-hour cooldown', async () => {
    const lease = await seedSourceAndRuns(2);
    const repo = new BrowserFallbackRepository(env.DB, { now: () => now });
    const reservation = await repo.reserve({
      sourceId: 'browser-source', runId: 'run-0', lease, urlHash: 'blocked-url', now,
    });
    expect(reservation).not.toBeNull();
    await repo.settle({
      reservation: reservation!, lease, outcome: 'blocked', errorCode: 'BROWSER_RUN_BLOCKED', now,
    });

    await expect(repo.state('browser-source', now)).resolves.toMatchObject({
      cooldownUntil: now + 24 * 60 * 60_000,
      lastErrorCode: 'BROWSER_RUN_BLOCKED',
      fallbackCount: 1,
      usage: { browserMsUsed: 60_000, pagesUsed: 1, reservedBrowserMs: 0, reservedPages: 0 },
    });
    await expect(repo.reserve({
      sourceId: 'browser-source', runId: 'run-1', lease, urlHash: 'after-block', now,
    })).resolves.toBeNull();
  });

  it('retains the reservation when the Browser Run outcome is uncertain', async () => {
    const lease = await seedSourceAndRuns(1);
    const repo = new BrowserFallbackRepository(env.DB, { now: () => now });
    const reservation = await repo.reserve({
      sourceId: 'browser-source', runId: 'run-0', lease, urlHash: 'uncertain-url', now,
    });
    expect(reservation).not.toBeNull();
    await repo.settle({
      reservation: reservation!, lease, outcome: 'uncertain', errorCode: 'BROWSER_RUN_UNCERTAIN', now,
    });

    await expect(repo.state('browser-source', now)).resolves.toMatchObject({
      usage: { browserMsUsed: 0, pagesUsed: 0, reservedBrowserMs: 60_000, reservedPages: 1 },
    });
  });

  it('clamps reported browser duration to the original 60-second reservation', async () => {
    const lease = await seedSourceAndRuns(1);
    const repo = new BrowserFallbackRepository(env.DB, { now: () => now });
    const reservation = await repo.reserve({
      sourceId: 'browser-source', runId: 'run-0', lease, urlHash: 'slow-url', now,
    });
    expect(reservation).not.toBeNull();
    await repo.settle({ reservation: reservation!, lease, outcome: 'succeeded', actualMs: 90_000, now });

    await expect(repo.state('browser-source', now)).resolves.toMatchObject({
      usage: { browserMsUsed: 60_000, pagesUsed: 1, reservedBrowserMs: 0, reservedPages: 0 },
    });
  });

  it('rejects a reservation from an expired lease', async () => {
    const lease = await seedSourceAndRuns(1);
    const repo = new BrowserFallbackRepository(env.DB, { now: () => now });
    await env.DB.prepare(`UPDATE source_leases SET expires_at=?1 WHERE source_id='browser-source'`).bind(now - 1).run();

    await expect(repo.reserve({
      sourceId: 'browser-source', runId: 'run-0', lease, urlHash: 'stale-lease', now,
    })).resolves.toBeNull();
  });
});
