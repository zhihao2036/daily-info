import type { RunStatus } from '../../domain/contracts';
import type { Json } from '../../domain/contracts';
import { sha256 } from './shared';

interface RunRow {
  id: string;
  kind: RunStatus['kind'];
  state: RunStatus['state'];
  checkpoint_json: string;
  digest_id: string | null;
  error_code: string | null;
  scheduled_at: number;
  started_at: number | null;
  finished_at: number | null;
}

interface RegisteredRunRow extends RunRow {
  job_key: string;
  workflow_id: string;
  source_id: string | null;
  generation: number;
  deadline_at: number;
  params_json: string;
}

export interface RegisterRunInput {
  jobKey: string;
  kind: RunStatus['kind'];
  sourceId: string | null;
  digestId: string | null;
  generation: number;
  scheduledAt: number;
  deadlineAt: number;
  params: Json;
  now: number;
}

export interface RegisteredRun {
  runId: string;
  jobKey: string;
  workflowId: string;
  kind: RunStatus['kind'];
  state: RunStatus['state'];
  sourceId: string | null;
  digestId: string | null;
  generation: number;
  scheduledAt: number;
  deadlineAt: number;
  params: Json;
}

function mapRegistered(row: RegisteredRunRow): RegisteredRun {
  return {
    runId: row.id,
    jobKey: row.job_key,
    workflowId: row.workflow_id,
    kind: row.kind,
    state: row.state,
    sourceId: row.source_id,
    digestId: row.digest_id,
    generation: row.generation,
    scheduledAt: row.scheduled_at,
    deadlineAt: row.deadline_at,
    params: JSON.parse(row.params_json) as Json,
  };
}

export class RunRepository {
  constructor(private readonly db: D1Database) {}

  async get(runId: string): Promise<RunStatus | null> {
    const row = await this.db.prepare(`
      SELECT id,kind,state,checkpoint_json,digest_id,error_code,scheduled_at,started_at,finished_at
      FROM runs WHERE id=?1
    `).bind(runId).first<RunRow>();
    if (row === null) return null;
    const checkpoint = JSON.parse(row.checkpoint_json) as { phase?: unknown };
    return {
      runId: row.id,
      kind: row.kind,
      state: row.state,
      phase: typeof checkpoint.phase === 'string' ? checkpoint.phase : null,
      digestId: row.digest_id,
      resultUrl: row.digest_id === null ? null : `/api/digests/${row.digest_id}`,
      errorCode: row.error_code,
      scheduledAt: row.scheduled_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  private async readWhere(column: 'id' | 'job_key' | 'workflow_id', value: string): Promise<RegisteredRun | null> {
    const row = await this.db.prepare(`
      SELECT id,job_key,workflow_id,kind,state,source_id,digest_id,generation,scheduled_at,deadline_at,
        params_json,checkpoint_json,error_code,started_at,finished_at
      FROM runs WHERE ${column}=?1
    `).bind(value).first<RegisteredRunRow>();
    return row === null ? null : mapRegistered(row);
  }

  findByJobKey(jobKey: string): Promise<RegisteredRun | null> { return this.readWhere('job_key', jobKey); }
  getByWorkflowId(workflowId: string): Promise<RegisteredRun | null> { return this.readWhere('workflow_id', workflowId); }

  async register(input: RegisterRunInput): Promise<RegisteredRun> {
    const digest = await sha256(input.jobKey);
    const runId = `run-${digest}`;
    const workflowId = `${input.kind}-${digest}`;
    const persistedParams = input.params !== null && typeof input.params === 'object' && !Array.isArray(input.params)
      ? { ...input.params, runId }
      : input.params;
    await this.db.prepare(`
      INSERT INTO runs(id,job_key,workflow_id,kind,state,source_id,digest_id,generation,scheduled_at,
        deadline_at,params_json,created_at,updated_at)
      VALUES (?1,?2,?3,?4,'pending_create',?5,?6,?7,?8,?9,json(?10),?11,?11)
      ON CONFLICT(job_key) DO NOTHING
    `).bind(runId, input.jobKey, workflowId, input.kind, input.sourceId, input.digestId, input.generation,
      input.scheduledAt, input.deadlineAt, JSON.stringify(persistedParams), input.now).run();
    const row = await this.findByJobKey(input.jobKey);
    if (row === null) throw new Error('RUN_REGISTRATION_FAILED');
    return row;
  }

  async listForReconciliation(now: number, limit = 20): Promise<RegisteredRun[]> {
    const rows = await this.db.prepare(`
      SELECT id,job_key,workflow_id,kind,state,source_id,digest_id,generation,scheduled_at,deadline_at,
        params_json,checkpoint_json,error_code,started_at,finished_at
      FROM runs WHERE state='pending_create' OR (state='running' AND updated_at<=?1)
      ORDER BY CASE state WHEN 'pending_create' THEN 0 ELSE 1 END,updated_at,id LIMIT ?2
    `).bind(now - 10 * 60_000, Math.max(1, Math.min(20, Math.trunc(limit)))).all<RegisteredRunRow>();
    return rows.results.map(mapRegistered);
  }

  async markObserved(runId: string, now: number): Promise<void> {
    await this.db.prepare(`
      UPDATE runs SET state='running',started_at=COALESCE(started_at,?2),updated_at=?2
      WHERE id=?1 AND state='pending_create'
    `).bind(runId, now).run();
  }

  async markActive(runId: string, now: number): Promise<void> {
    await this.db.prepare("UPDATE runs SET updated_at=?2 WHERE id=?1 AND state='running'").bind(runId, now).run();
  }

  async markCompleted(runId: string, now: number): Promise<void> {
    await this.db.prepare(`
      UPDATE runs SET state='completed',finished_at=?2,updated_at=?2,error_code=NULL
      WHERE id=?1 AND state IN ('pending_create','running')
    `).bind(runId, now).run();
  }

  async markFailed(runId: string, errorCode: string, now: number): Promise<void> {
    await this.db.prepare(`
      UPDATE runs SET state='failed',finished_at=?3,updated_at=?3,error_code=?2
      WHERE id=?1 AND state IN ('pending_create','running')
    `).bind(runId, errorCode, now).run();
  }

  async markExpired(runId: string, now: number): Promise<void> {
    await this.db.prepare("UPDATE runs SET state='expired',finished_at=?2,updated_at=?2 WHERE id=?1 AND state IN ('pending_create','running')")
      .bind(runId, now).run();
  }
}
