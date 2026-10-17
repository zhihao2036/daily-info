import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, BudgetedCall, LlmProvider } from '../../src/domain/contracts';
import { canonicalJson, sha256 } from '../../src/db/repositories/shared';
import { BudgetRepository } from '../../src/llm/budget';
import { completeBudgeted } from '../../src/llm/cache';

const tables = ['llm_calls', 'budget_buckets', 'digests'] as const;
async function reset(): Promise<void> { await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`))); }

function reservation(call: string, now: number, amount = 600_000) {
  return {
    invocationId: `invocation-${call}`, attemptNo: 1, cacheKey: `cache-${call}`, generation: 0,
    deadlineAt: now + 60_000, digestId: null, stage: 'filter' as const, model: 'model-a',
    promptVersion: 'v1', reservationMicrousd: amount, dayLimitMicrousd: 750_000,
    monthLimitMicrousd: 15_000_000, now,
  };
}

const appConfig = {
  profileId: 'personal', timezone: 'Asia/Shanghai',
  schedule: { morning: '07:45', cutoff: '08:00', buildDeadline: '08:25', send: '08:30', close: '09:00' },
  limits: { maxSources: 20, maxPages: 3, pageSize: 30, maxNewBodiesPerRun: 20, fetchTimeoutMs: 10_000, llmTimeoutMs: 30_000, maxResponseBytes: 2_000_000, maxBodyBytes: 128_000, maxModelCharsPerArticle: 12_000, maxCandidates: 200, maxDeepRead: 20, maxEvents: 8, perInstanceConcurrency: 2, maxAttemptsPerStage: 3, maxRepairAttempts: 1 },
  editorial: { targetMinChars: 600, targetMaxChars: 1200, historyDays: 30, lateHours: 48, initialHours: 48, threshold: 60 },
  llm: { baseUrl: 'https://llm.example.com/v1', model: 'model-a', promptVersion: 'v1', jsonMode: 'json_object', maxOutputTokens: 500, tokenizer: 'conservative_utf8', inputMicrousdPerMillionTokens: 1000, outputMicrousdPerMillionTokens: 2000, pricingIncludesAllBillableTokens: true },
  budget: { dayMicrousd: 750_000, monthMicrousd: 15_000_000 },
  delivery: { channel: 'dummy', destinationConfigRef: 'dummy' },
} satisfies AppConfig;

describe('budget ledger', () => {
  beforeEach(reset);

  it('allows at most one concurrent 600000 reservation under a 750000 daily limit', async () => {
    const repo = new BudgetRepository(env.DB);
    const now = Date.parse('2026-09-21T01:00:00Z');
    const results = await Promise.allSettled([repo.reserve(reservation('a', now)), repo.reserve(reservation('b', now))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await repo.readBucket('2026-09-21'))?.reservedMicrousd).toBe(600_000);
  });

  it('does not reserve either bucket when the monthly limit is insufficient', async () => {
    const repo = new BudgetRepository(env.DB);
    const now = Date.parse('2026-09-21T01:00:00Z');
    await expect(repo.reserve({ ...reservation('a', now), monthLimitMicrousd: 500_000 })).rejects.toThrow('BUDGET_EXCEEDED');
    expect(await repo.readBucket('2026-09-21')).toMatchObject({ reservedMicrousd: 0, spentMicrousd: 0 });
    expect(await repo.readBucket('2026-09')).toMatchObject({ reservedMicrousd: 0, spentMicrousd: 0 });
  });

  it('replays a call id without double reservation and rejects changed identity', async () => {
    const repo = new BudgetRepository(env.DB);
    const now = Date.parse('2026-09-21T01:00:00Z');
    const first = await repo.reserve(reservation('a', now, 1));
    const replay = await repo.reserve(reservation('a', now, 1));
    expect(replay).toEqual(first);
    await expect(repo.reserve({ ...reservation('a', now, 2), cacheKey: 'changed' })).rejects.toThrow('CALL_CONFLICT');
    expect((await repo.readBucket('2026-09-21'))?.reservedMicrousd).toBe(1);
  });

  it('applies a reduced limit to an existing UTC bucket before admitting another call', async () => {
    const repo = new BudgetRepository(env.DB);
    const now = Date.parse('2026-09-21T01:00:00Z');
    await repo.reserve(reservation('a', now, 100));

    await expect(repo.reserve({ ...reservation('b', now, 1), dayLimitMicrousd: 50 }))
      .rejects.toThrow('BUDGET_EXCEEDED');
    expect(await repo.readBucket('2026-09-21')).toMatchObject({ limitMicrousd: 50, reservedMicrousd: 100 });
  });

  it('does not let an older higher limit raise an already tightened UTC bucket', async () => {
    const repo = new BudgetRepository(env.DB);
    const now = Date.parse('2026-09-21T01:00:00Z');
    await repo.reserve({ ...reservation('tight', now, 1), dayLimitMicrousd: 50 });

    await expect(repo.reserve({ ...reservation('stale-high', now, 50), dayLimitMicrousd: 750_000 }))
      .rejects.toThrow('BUDGET_EXCEEDED');
    expect(await repo.readBucket('2026-09-21')).toMatchObject({ limitMicrousd: 50, reservedMicrousd: 1 });
  });

  it('keeps calling and uncertain attempts reserved', async () => {
    const repo = new BudgetRepository(env.DB);
    const now = Date.parse('2026-09-21T01:00:00Z');
    const call = await repo.reserve(reservation('a', now, 100));
    expect(await repo.markCalling(call.callId, now + 1)).toBe(true);
    await repo.settleUncertain(call.callId, 'RESPONSE_LOST', now + 2);
    expect(await repo.readBucket('2026-09-21')).toMatchObject({ reservedMicrousd: 100, spentMicrousd: 0 });
  });

  it('settles unknown usage at the reservation and repeated settlement is idempotent', async () => {
    const repo = new BudgetRepository(env.DB);
    const now = Date.parse('2026-09-21T01:00:00Z');
    const call = await repo.reserve(reservation('a', now, 100));
    await repo.markCalling(call.callId, now + 1);
    await repo.settleSuccess(call.callId, { ok: true }, null, null, now + 2);
    await repo.settleSuccess(call.callId, { ok: true }, null, null, now + 3);
    expect(await repo.readBucket('2026-09-21')).toMatchObject({ reservedMicrousd: 0, spentMicrousd: 100 });
  });

  it('uses UTC day and month buckets across a month boundary', async () => {
    const repo = new BudgetRepository(env.DB);
    const august = Date.parse('2026-08-31T23:59:59Z');
    const september = Date.parse('2026-09-01T00:00:00Z');
    await repo.reserve(reservation('aug', august, 10));
    await repo.reserve(reservation('sep', september, 20));
    expect((await repo.readBucket('2026-08'))?.reservedMicrousd).toBe(10);
    expect((await repo.readBucket('2026-09'))?.reservedMicrousd).toBe(20);
  });

  it('reuses a validated successful cache entry without a second provider call', async () => {
    const now = Date.parse('2026-09-21T00:10:00Z');
    await env.DB.prepare(`INSERT INTO digests(
      id,profile_id,local_date,timezone,mode,status,window_start_at,cutoff_at,build_deadline_at,send_at,
      send_deadline_at,build_generation,config_snapshot_json,created_at,updated_at
    ) VALUES ('digest-cache','personal','2026-09-21','Asia/Shanghai','scheduled','building',?1,?2,?3,?4,?5,0,'{}',?6,?6)`)
      .bind(now - 1000, now, now + 60_000, now + 120_000, now + 180_000, now).run();
    let calls = 0;
    const provider: LlmProvider = {
      async complete() { calls += 1; return { value: { ok: true }, usage: null, providerRequestId: 'provider-1' }; },
    };
    const base: BudgetedCall = {
      request: { stage: 'filter', digestId: 'digest-cache', input: { prompt: 'same' }, maxOutputTokens: 10 },
      invocationId: 'digest-cache:0:filter:0:v1', ownerStage: 'filter', attemptNo: 1,
      generation: 0, deadlineAt: now + 60_000,
    };
    const dependencies = { db: env.DB, config: appConfig, provider, now: () => now + 1 };
    expect((await completeBudgeted(base, dependencies)).value).toEqual({ ok: true });
    expect((await completeBudgeted({ ...base, invocationId: 'another-owner' }, dependencies)).value).toEqual({ ok: true });
    expect(calls).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM llm_calls').first<{ count: number }>())?.count).toBe(1);
  });

  it('releases a reservation when generation fencing proves the provider was not called', async () => {
    const now = Date.parse('2026-09-21T00:10:00Z');
    await env.DB.prepare(`INSERT INTO digests(
      id,profile_id,local_date,timezone,mode,status,window_start_at,cutoff_at,build_deadline_at,send_at,
      send_deadline_at,build_generation,config_snapshot_json,created_at,updated_at
    ) VALUES ('digest-fenced','personal','2026-09-21','Asia/Shanghai','scheduled','building',?1,?2,?3,?4,?5,1,'{}',?6,?6)`)
      .bind(now - 1000, now, now + 60_000, now + 120_000, now + 180_000, now).run();
    const provider = { complete: vi.fn() } as unknown as LlmProvider;
    const call: BudgetedCall = {
      request: { stage: 'filter', digestId: 'digest-fenced', input: { prompt: 'fenced' }, maxOutputTokens: 10 },
      invocationId: 'digest-fenced:0:filter:0:v1', ownerStage: 'filter', attemptNo: 1,
      generation: 0, deadlineAt: now + 60_000,
    };

    await expect(completeBudgeted(call, { db: env.DB, config: appConfig, provider, now: () => now + 1 }))
      .rejects.toThrow('CALL_FENCED');
    expect(provider.complete).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT state,actual_microusd,error_code FROM llm_calls').first())
      .toMatchObject({ state: 'failed', actual_microusd: 0, error_code: 'CALL_FENCED' });
    expect((await new BudgetRepository(env.DB).readBucket('2026-09-21'))?.reservedMicrousd).toBe(0);
  });

  it('releases a calling reservation when the deadline crosses before provider invocation', async () => {
    const now = Date.parse('2026-09-21T00:10:00Z');
    await env.DB.prepare(`INSERT INTO digests(
      id,profile_id,local_date,timezone,mode,status,window_start_at,cutoff_at,build_deadline_at,send_at,
      send_deadline_at,build_generation,config_snapshot_json,created_at,updated_at
    ) VALUES ('digest-deadline','personal','2026-09-21','Asia/Shanghai','scheduled','building',?1,?2,?3,?4,?5,0,'{}',?6,?6)`)
      .bind(now - 1000, now, now + 60_000, now + 120_000, now + 180_000, now).run();
    const provider = { complete: vi.fn() } as unknown as LlmProvider;
    const moments = [now, now + 50, now + 101, now + 102];
    const call: BudgetedCall = {
      request: { stage: 'filter', digestId: 'digest-deadline', input: { prompt: 'deadline' }, maxOutputTokens: 10 },
      invocationId: 'deadline:filter:0:v1', ownerStage: 'filter', attemptNo: 1,
      generation: 0, deadlineAt: now + 100,
    };

    await expect(completeBudgeted(call, {
      db: env.DB, config: appConfig, provider,
      now: () => moments.shift() ?? now + 102,
    })).rejects.toThrow('CALL_DEADLINE');
    expect(provider.complete).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT state,actual_microusd,error_code FROM llm_calls').first())
      .toMatchObject({ state: 'failed', actual_microusd: 0, error_code: 'CALL_DEADLINE' });
    expect((await new BudgetRepository(env.DB).readBucket('2026-09-21'))?.reservedMicrousd).toBe(0);
  });

  it('keeps a replayed calling reservation because the provider may already have been invoked', async () => {
    const now = Date.parse('2026-09-21T00:10:00Z');
    const repo = new BudgetRepository(env.DB);
    const call: BudgetedCall = {
      request: { stage: 'filter', digestId: 'digest-replay', input: { prompt: 'replay' }, maxOutputTokens: 10 },
      invocationId: 'replay:filter:0:v1', ownerStage: 'filter', attemptNo: 1,
      generation: 0, deadlineAt: now + 60_000,
    };
    const provider = { complete: vi.fn() } as unknown as LlmProvider;
    const first = await repo.reserve({
      invocationId: call.invocationId, attemptNo: 1,
      cacheKey: await sha256(canonicalJson({ input: call.request.input, stage: call.request.stage,
        model: appConfig.llm.model, baseUrl: appConfig.llm.baseUrl,
        promptVersion: appConfig.llm.promptVersion, jsonMode: appConfig.llm.jsonMode })),
      generation: 0, deadlineAt: call.deadlineAt, digestId: null, stage: 'filter', model: appConfig.llm.model,
      promptVersion: appConfig.llm.promptVersion, reservationMicrousd: 1,
      dayLimitMicrousd: appConfig.budget.dayMicrousd, monthLimitMicrousd: appConfig.budget.monthMicrousd, now,
    });
    expect(await repo.markCalling(first.callId, now + 1)).toBe(true);

    await expect(completeBudgeted(call, { db: env.DB, config: appConfig, provider, now: () => now + 2 }))
      .rejects.toThrow('CALL_FENCED');
    expect(provider.complete).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT state,actual_microusd FROM llm_calls WHERE id=?1').bind(first.callId).first())
      .toMatchObject({ state: 'calling', actual_microusd: null });
    expect((await repo.readBucket('2026-09-21'))?.reservedMicrousd).toBe(1);
  });
});
