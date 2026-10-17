import type { DigestTimes, Json, RunAccepted } from '../../domain/contracts';
import { canonicalJson, isConstraintError, sha256 } from './shared';

interface ExistingRequest {
  request_hash: string;
  run_id: string;
  workflow_id: string;
}

export class RequestRepository {
  constructor(private readonly db: D1Database) {}

  private async existing(scope: string, key: string, now: number): Promise<ExistingRequest | null> {
    return this.db.prepare(`
      SELECT k.request_hash,k.run_id,r.workflow_id
      FROM request_keys k JOIN runs r ON r.id=k.run_id
      WHERE k.scope=?1 AND k.idempotency_key=?2 AND k.expires_at>?3
    `).bind(scope, key, now).first<ExistingRequest>();
  }

  private accepted(row: ExistingRequest): RunAccepted {
    return { runId: row.run_id, workflowId: row.workflow_id, statusUrl: `/api/runs/${row.run_id}` };
  }

  async registerRequest(input: { scope: string; key: string; requestHash: string; params: Json; now: number; previewDigest?: {
    id: string; profileId: string; times: DigestTimes; configSnapshot: Json; windowStartAt: number;
  } }): Promise<RunAccepted> {
    await this.db.prepare(`DELETE FROM request_keys WHERE rowid IN (
      SELECT rowid FROM request_keys WHERE expires_at<=?1 ORDER BY expires_at,rowid LIMIT 100
    )`).bind(input.now).run();
    const found = await this.existing(input.scope, input.key, input.now);
    if (found !== null) {
      if (found.request_hash !== input.requestHash) throw new Error('IDEMPOTENCY_CONFLICT');
      return this.accepted(found);
    }

    const minuteSlot = Math.floor(input.now / 60_000);
    const identity = await sha256(`${input.scope}\n${input.key}\n${minuteSlot}\n${input.requestHash}`);
    const runId = `run-${identity.slice(0, 48)}`;
    const workflowId = `${input.scope}-${identity.slice(0, 64)}`;
    const jobKey = `api:${identity}`;
    const kind = input.scope === 'preview' ? 'preview' : 'collect';
    const paramsJson = canonicalJson(input.params !== null && typeof input.params === 'object' && !Array.isArray(input.params)
      ? { ...input.params, runId }
      : input.params);
    const sourceId = typeof input.params === 'object' && input.params !== null && !Array.isArray(input.params)
      && typeof input.params.sourceId === 'string' ? input.params.sourceId : null;
    const digestId = input.previewDigest?.id ?? (kind !== 'preview' && typeof input.params === 'object'
      && input.params !== null && !Array.isArray(input.params) && typeof input.params.digestId === 'string'
      ? input.params.digestId : null);
    const generation = typeof input.params === 'object' && input.params !== null && !Array.isArray(input.params)
      && typeof input.params.generation === 'number' ? input.params.generation : 0;
    const scheduledAt = typeof input.params === 'object' && input.params !== null && !Array.isArray(input.params)
      && typeof input.params.scheduledAt === 'number' ? input.params.scheduledAt : input.now;
    const deadlineAt = typeof input.params === 'object' && input.params !== null && !Array.isArray(input.params)
      && typeof input.params.deadlineAt === 'number' ? input.params.deadlineAt : input.now + (kind === 'preview' ? 300_000 : 900_000);

    for (let slot = 0; slot < 5; slot += 1) {
      try {
        await this.db.batch([
          ...(input.previewDigest === undefined ? [] : [this.db.prepare(`
            INSERT INTO digests(
              id,profile_id,local_date,timezone,mode,status,window_start_at,cutoff_at,build_deadline_at,
              send_at,send_deadline_at,build_generation,config_snapshot_json,created_at,updated_at
            ) VALUES (?1,?2,?3,'Asia/Shanghai','preview','collecting',?4,?5,?6,?7,?8,0,json(?9),?10,?10)
            ON CONFLICT(id) DO NOTHING
          `).bind(input.previewDigest.id, input.previewDigest.profileId, input.previewDigest.times.localDate,
            input.previewDigest.windowStartAt, input.previewDigest.times.cutoffAt, input.previewDigest.times.buildDeadlineAt,
            input.previewDigest.times.sendAt, input.previewDigest.times.sendDeadlineAt,
            JSON.stringify(input.previewDigest.configSnapshot), input.now)]),
          this.db.prepare(`
            INSERT INTO runs(id,job_key,workflow_id,kind,state,source_id,digest_id,generation,scheduled_at,deadline_at,
              params_json,checkpoint_json,created_at,updated_at)
            VALUES (?1,?2,?3,?4,'pending_create',?5,?6,?7,?8,?9,json(?10),'{}',?11,?11)
          `).bind(runId, jobKey, workflowId, kind, sourceId, digestId, generation, scheduledAt,
            deadlineAt, paramsJson, input.now),
          this.db.prepare(`
            INSERT INTO request_keys(scope,idempotency_key,request_hash,run_id,created_at,expires_at,minute_slot,slot_number)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
          `).bind(input.scope, input.key, input.requestHash, runId, input.now, input.now + 86_400_000, minuteSlot, slot),
        ]);
        return { runId, workflowId, statusUrl: `/api/runs/${runId}` };
      } catch (error) {
        const replay = await this.existing(input.scope, input.key, input.now);
        if (replay !== null) {
          if (replay.request_hash !== input.requestHash) throw new Error('IDEMPOTENCY_CONFLICT');
          return this.accepted(replay);
        }
        if (!isConstraintError(error)) throw error;
      }
    }
    throw new Error('RATE_LIMITED');
  }
}
