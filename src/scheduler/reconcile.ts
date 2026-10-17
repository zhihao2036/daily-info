import type { EpochMs } from '../domain/contracts';
import type { RunRepository } from '../db/repositories/runs';
import type { WorkflowBindingLike } from './dispatch';

export interface ReconcileDependencies {
  runs: RunRepository;
  bindings: Partial<Record<'collect' | 'digest' | 'recovery' | 'preview', WorkflowBindingLike<never>>>;
  limit?: number;
}

export interface ReconcileResult { scanned: number; repaired: number; created: number; expired: number }

export async function reconcile(now: EpochMs, dependencies: ReconcileDependencies): Promise<ReconcileResult> {
  const candidates = await dependencies.runs.listForReconciliation(now, Math.min(20, dependencies.limit ?? 20));
  const result: ReconcileResult = { scanned: candidates.length, repaired: 0, created: 0, expired: 0 };
  for (const run of candidates) {
    if (run.state === 'pending_create' && run.deadlineAt <= now) {
      await dependencies.runs.markExpired(run.runId, now);
      result.expired += 1;
      continue;
    }
    const binding = dependencies.bindings[run.kind];
    if (binding === undefined) continue;
    try {
      const instance = await binding.get(run.workflowId);
      const status = await instance.status();
      if (status.status !== 'unknown') {
        if (status.status === 'complete') {
          await dependencies.runs.markCompleted(run.runId, now);
        } else if (status.status === 'errored' || status.status === 'terminated') {
          await dependencies.runs.markFailed(run.runId, `WORKFLOW_${status.status.toUpperCase()}`, now);
        } else if (run.deadlineAt <= now) {
          await dependencies.runs.markExpired(run.runId, now);
          result.expired += 1;
        } else if (run.state === 'running') {
          await dependencies.runs.markActive(run.runId, now);
        } else {
          await dependencies.runs.markObserved(run.runId, now);
        }
        result.repaired += 1;
        continue;
      }
    } catch {
      // Pending creation is retried below; an observed run is never recreated.
    }
    if (run.state === 'running') {
      if (run.deadlineAt <= now) {
        await dependencies.runs.markExpired(run.runId, now);
        result.expired += 1;
      }
      continue;
    }
    try {
      await binding.create({ id: run.workflowId, params: run.params as never });
      await dependencies.runs.markObserved(run.runId, now);
      result.created += 1;
    } catch {
      // Leave pending_create for the next bounded heartbeat pass.
    }
  }
  return result;
}
