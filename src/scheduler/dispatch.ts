import type { CollectParams, DigestParams, EpochMs, Json, RunAccepted } from '../domain/contracts';
import type { RegisterRunInput, RegisteredRun, RunRepository } from '../db/repositories/runs';
import { sha256 } from '../db/repositories/shared';

export interface WorkflowInstanceLike {
  status(): Promise<{ status: string }>;
}

export interface WorkflowBindingLike<P = unknown> {
  create(input: { id: string; params: P }): Promise<unknown>;
  get(id: string): Promise<WorkflowInstanceLike>;
}

export type DispatchInput = Omit<RegisterRunInput, 'now' | 'params'> & {
  params: Json & Record<string, unknown>;
};

export async function stableJobId(jobKey: string, prefix = 'job'): Promise<string> {
  const safePrefix = prefix.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 30) || 'job';
  return `${safePrefix}-${await sha256(jobKey)}`;
}

function workflowParams(run: RegisteredRun, params: DispatchInput['params']): CollectParams | DigestParams {
  return { ...(params as Record<string, unknown>), runId: run.runId } as CollectParams | DigestParams;
}

export async function dispatchRun(
  runs: RunRepository,
  binding: WorkflowBindingLike<CollectParams | DigestParams>,
  input: DispatchInput,
  now: EpochMs,
): Promise<RunAccepted> {
  const existing = await runs.findByJobKey(input.jobKey);
  const run = existing ?? await runs.register({ ...input, now });
  if (run.state === 'pending_create' && existing === null) {
    try {
      await binding.create({ id: run.workflowId, params: workflowParams(run, input.params) });
      await runs.markObserved(run.runId, now);
    } catch {
      // The create outcome can be ambiguous. Heartbeat reconciles by the same stable ID.
    }
  }
  return { runId: run.runId, workflowId: run.workflowId, statusUrl: `/api/runs/${run.runId}` };
}
