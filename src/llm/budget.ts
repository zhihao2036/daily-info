import type { BudgetReservation, Json, Stage } from '../domain/contracts';
import { sha256 } from '../db/repositories/shared';

function nonNegativeSafe(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('COST_INVALID');
  return BigInt(value);
}

export function estimateCostMicrousd(
  inputUpper: number,
  outputCap: number,
  inputRate: number,
  outputRate: number,
): number {
  const numerator = nonNegativeSafe(inputUpper) * nonNegativeSafe(inputRate)
    + nonNegativeSafe(outputCap) * nonNegativeSafe(outputRate);
  const rounded = (numerator + 999_999n) / 1_000_000n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('COST_OVERFLOW');
  return Number(rounded);
}

export interface ReserveInput {
  invocationId: string;
  attemptNo: number;
  cacheKey: string;
  generation: number;
  deadlineAt: number;
  digestId: string | null;
  stage: Stage;
  model: string;
  promptVersion: string;
  reservationMicrousd: number;
  dayLimitMicrousd: number;
  monthLimitMicrousd: number;
  now: number;
}

interface CallRow {
  id: string;
  cache_key: string;
  invocation_id: string;
  attempt_no: number;
  reserved_microusd: number;
  day_bucket: string;
  month_bucket: string;
}

export interface BucketState { key: string; limitMicrousd: number; reservedMicrousd: number; spentMicrousd: number }

function utcBuckets(now: number): { day: string; month: string } {
  const iso = new Date(now).toISOString();
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
}

export class BudgetRepository {
  constructor(private readonly db: D1Database) {}

  private async readCall(callId: string): Promise<CallRow | null> {
    return this.db.prepare(`
      SELECT id,cache_key,invocation_id,attempt_no,reserved_microusd,day_bucket,month_bucket
      FROM llm_calls WHERE id=?1
    `).bind(callId).first<CallRow>();
  }

  async reserve(input: ReserveInput): Promise<BudgetReservation> {
    if (!Number.isInteger(input.attemptNo) || input.attemptNo < 1 || input.attemptNo > 3) throw new Error('ATTEMPT_INVALID');
    for (const value of [input.reservationMicrousd, input.dayLimitMicrousd, input.monthLimitMicrousd]) nonNegativeSafe(value);
    const reservation = Math.max(1, input.reservationMicrousd);
    const callId = await sha256(`${input.invocationId}${input.attemptNo}`);
    const buckets = utcBuckets(input.now);
    const replay = await this.readCall(callId);
    if (replay !== null) {
      const same = replay.cache_key === input.cacheKey && replay.invocation_id === input.invocationId
        && replay.attempt_no === input.attemptNo && replay.reserved_microusd === reservation;
      if (!same) throw new Error('CALL_CONFLICT');
      return { callId, dayBucket: replay.day_bucket, monthBucket: replay.month_bucket,
        reservedMicrousd: replay.reserved_microusd };
    }
    await this.db.prepare(`
      INSERT INTO budget_buckets(bucket_key,limit_microusd,reserved_microusd,spent_microusd,updated_at)
      VALUES (?1,?2,0,0,?3), (?4,?5,0,0,?3)
      ON CONFLICT(bucket_key) DO UPDATE SET
        limit_microusd=MIN(budget_buckets.limit_microusd,excluded.limit_microusd),updated_at=excluded.updated_at
    `).bind(buckets.day, input.dayLimitMicrousd, input.now, buckets.month, input.monthLimitMicrousd).run();
    try {
      await this.db.batch([
        this.db.prepare(`
          INSERT INTO llm_calls(
            id,cache_key,invocation_id,generation,deadline_at,attempt_no,digest_id,stage,model,prompt_version,
            state,day_bucket,month_bucket,reserved_microusd,created_at,updated_at
          )
          SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'reserved',?11,?12,
            CASE WHEN
              (SELECT spent_microusd+reserved_microusd+?13<=limit_microusd FROM budget_buckets WHERE bucket_key=?11)
              AND (SELECT spent_microusd+reserved_microusd+?13<=limit_microusd FROM budget_buckets WHERE bucket_key=?12)
            THEN ?13 ELSE 0 END,?14,?14
        `).bind(callId, input.cacheKey, input.invocationId, input.generation, input.deadlineAt, input.attemptNo,
          input.digestId, input.stage, input.model, input.promptVersion, buckets.day, buckets.month, reservation, input.now),
        this.db.prepare(`
          UPDATE budget_buckets SET reserved_microusd=reserved_microusd+?1,updated_at=?2
          WHERE bucket_key IN (?3,?4)
        `).bind(reservation, input.now, buckets.day, buckets.month),
      ]);
    } catch {
      const existing = await this.readCall(callId);
      if (existing !== null) {
        const same = existing.cache_key === input.cacheKey && existing.invocation_id === input.invocationId
          && existing.attempt_no === input.attemptNo && existing.reserved_microusd === reservation;
        if (!same) throw new Error('CALL_CONFLICT');
        return { callId, dayBucket: existing.day_bucket, monthBucket: existing.month_bucket, reservedMicrousd: existing.reserved_microusd };
      }
      throw new Error('BUDGET_EXCEEDED');
    }
    return { callId, dayBucket: buckets.day, monthBucket: buckets.month, reservedMicrousd: reservation };
  }

  async readBucket(key: string): Promise<BucketState | null> {
    const row = await this.db.prepare(`
      SELECT bucket_key,limit_microusd,reserved_microusd,spent_microusd FROM budget_buckets WHERE bucket_key=?1
    `).bind(key).first<{ bucket_key: string; limit_microusd: number; reserved_microusd: number; spent_microusd: number }>();
    return row === null ? null : { key: row.bucket_key, limitMicrousd: row.limit_microusd, reservedMicrousd: row.reserved_microusd, spentMicrousd: row.spent_microusd };
  }

  async markCalling(callId: string, now: number): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE llm_calls SET state='calling',updated_at=?2
      WHERE id=?1 AND state='reserved' AND deadline_at>?2 AND (
        digest_id IS NULL OR EXISTS (
          SELECT 1 FROM digests d WHERE d.id=llm_calls.digest_id AND d.build_generation=llm_calls.generation
            AND d.status IN ('collecting','building')
        )
      )
    `).bind(callId, now).run();
    return result.meta.changes === 1;
  }

  private recomputeStatements(day: string, month: string, now: number): D1PreparedStatement[] {
    return [this.db.prepare(`
      UPDATE budget_buckets SET
        spent_microusd=(SELECT COALESCE(SUM(actual_microusd),0) FROM llm_calls
          WHERE (day_bucket=budget_buckets.bucket_key OR month_bucket=budget_buckets.bucket_key)
            AND state IN ('succeeded','failed') AND actual_microusd IS NOT NULL),
        reserved_microusd=(SELECT COALESCE(SUM(reserved_microusd),0) FROM llm_calls
          WHERE (day_bucket=budget_buckets.bucket_key OR month_bucket=budget_buckets.bucket_key)
            AND state IN ('reserved','calling','uncertain')),
        updated_at=?3 WHERE bucket_key IN (?1,?2)
    `).bind(day, month, now)];
  }

  async settleSuccess(callId: string, output: Json, usage: { inputTokens: number; outputTokens: number } | null, actualMicrousd: number | null, now: number): Promise<void> {
    const call = await this.readCall(callId);
    if (call === null) throw new Error('CALL_NOT_FOUND');
    const actual = actualMicrousd ?? call.reserved_microusd;
    nonNegativeSafe(actual);
    await this.db.batch([
      this.db.prepare(`
        UPDATE llm_calls SET state='succeeded',actual_microusd=?2,usage_json=json(?3),output_json=json(?4),updated_at=?5
        WHERE id=?1 AND state IN ('reserved','calling')
      `).bind(callId, actual, JSON.stringify(usage ?? { unknown: true }), JSON.stringify(output), now),
      ...this.recomputeStatements(call.day_bucket, call.month_bucket, now),
    ]);
  }

  async settleUncertain(callId: string, errorCode: string, now: number): Promise<void> {
    const call = await this.readCall(callId);
    if (call === null) throw new Error('CALL_NOT_FOUND');
    await this.db.batch([
      this.db.prepare(`UPDATE llm_calls SET state='uncertain',error_code=?2,updated_at=?3 WHERE id=?1 AND state='calling'`)
        .bind(callId, errorCode, now),
      ...this.recomputeStatements(call.day_bucket, call.month_bucket, now),
    ]);
  }

  async releaseUncalled(callId: string, errorCode: string, now: number, expectedState: 'reserved' | 'calling'): Promise<boolean> {
    const call = await this.readCall(callId);
    if (call === null) throw new Error('CALL_NOT_FOUND');
    const results = await this.db.batch([
      this.db.prepare(`
        UPDATE llm_calls SET state='failed',actual_microusd=0,error_code=?2,updated_at=?3
        WHERE id=?1 AND state=?4
      `).bind(callId, errorCode, now, expectedState),
      ...this.recomputeStatements(call.day_bucket, call.month_bucket, now),
    ]);
    return results[0]?.meta.changes === 1;
  }

  async findCached(cacheKey: string): Promise<{ value: Json; usage: { inputTokens: number; outputTokens: number } | null } | null> {
    const row = await this.db.prepare(`
      SELECT output_json,usage_json FROM llm_calls WHERE cache_key=?1 AND state='succeeded' AND output_json IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1
    `).bind(cacheKey).first<{ output_json: string; usage_json: string | null }>();
    if (row === null) return null;
    const usageValue = row.usage_json === null ? null : JSON.parse(row.usage_json) as { inputTokens?: unknown; outputTokens?: unknown };
    const usage = typeof usageValue?.inputTokens === 'number' && typeof usageValue.outputTokens === 'number'
      ? { inputTokens: usageValue.inputTokens, outputTokens: usageValue.outputTokens }
      : null;
    return { value: JSON.parse(row.output_json) as Json, usage };
  }
}
