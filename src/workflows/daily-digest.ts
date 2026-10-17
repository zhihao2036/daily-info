import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { DigestRepository } from '../db/repositories/digests';
import { sha256 } from '../db/repositories/shared';
import { createDummySender } from '../delivery/dummy';
import { createRuntimeSender, deliveryDestinationValue } from '../delivery/runtime';
import { deliverDigest } from '../delivery/service';
import { buildDigest } from '../editorial';
import { loadRuntimeConfig, type RuntimeEnv } from '../app';
import { RunRepository } from '../db/repositories/runs';
import type { DigestContent, DigestParams } from '../domain/contracts';
import { completeBudgeted } from '../llm/cache';
import { createLlmProvider } from '../llm/provider';
import { validateEditorialResponse } from '../editorial/model';
import { parseDigestConfigSnapshot } from '../config/snapshot';

export interface DailyWorkflowEnv extends RuntimeEnv {}

export class DailyDigestWorkflow extends WorkflowEntrypoint<DailyWorkflowEnv, DigestParams> {
  async run(event: Readonly<WorkflowEvent<DigestParams>>, step: WorkflowStep): Promise<unknown> {
    const params = event.payload;
    const runtime = loadRuntimeConfig(this.env);
    const runs = new RunRepository(this.env.DB);
    const digests = new DigestRepository(this.env.DB, { now: () => Date.now() });
    await step.do('run-observed', async () => {
      await runs.markObserved(params.runId, Date.now());
      return { runId: params.runId };
    });

    const timeline = await step.do('read-timeline', async () => this.env.DB.prepare(
      'SELECT local_date,window_start_at,cutoff_at,build_deadline_at,send_at,send_deadline_at,config_snapshot_json FROM digests WHERE id=?1',
    ).bind(params.digestId).first<{ local_date: string; window_start_at: number; cutoff_at: number; build_deadline_at: number;
      send_at: number; send_deadline_at: number; config_snapshot_json: string }>());
    if (timeline === null) throw new Error('DIGEST_NOT_FOUND');
    let digestSnapshot: ReturnType<typeof parseDigestConfigSnapshot> | null = null;
    try {
      digestSnapshot = parseDigestConfigSnapshot(timeline.config_snapshot_json);
    } catch { /* Invalid legacy snapshots fail closed for model use and delivery. */ }
    if (params.mode === 'scheduled') {
      await step.sleepUntil('wait-for-cutoff', timeline.cutoff_at);
    }

    await step.do('freeze-candidates', async () => {
      await digests.freezeCandidates(params.digestId, params.generation);
      await digests.claimBuild(params.digestId, params.generation, Date.now());
      return { generation: params.generation };
    });

    const buildResult = await step.do<string>('build-digest', async () => {
      try {
        const editorialConfig = digestSnapshot?.app ?? null;
        const canUseModel = editorialConfig !== null && this.env.LLM_API_KEY !== undefined
          && editorialConfig.llm.inputMicrousdPerMillionTokens !== null
          && editorialConfig.llm.outputMicrousdPerMillionTokens !== null
          && editorialConfig.llm.pricingIncludesAllBillableTokens
          && (params.mode === 'preview' || Date.now() < timeline.build_deadline_at);
        const model = canUseModel && editorialConfig !== null
          ? { config: editorialConfig, provider: createLlmProvider(editorialConfig, this.env.LLM_API_KEY!) }
          : null;
        const content = await buildDigest(params.digestId, params.generation, {
          db: this.env.DB,
          now: () => Date.now(),
          ...(model === null ? {} : { complete: (call: import('../domain/contracts').BudgetedCall) => completeBudgeted(call, {
            db: this.env.DB, config: model.config, provider: model.provider, now: () => Date.now(), validate: validateEditorialResponse,
          }) }),
        });
        return JSON.stringify({ ok: true, cards: content.cards.length });
      } catch (error) {
        return JSON.stringify({ ok: false, code: error instanceof Error ? error.message : 'BUILD_FAILED' });
      }
    });
    const built = (JSON.parse(buildResult) as { ok: boolean }).ok;
    const fallbackContent: DigestContent = {
      digestId: params.digestId,
      localDate: timeline.local_date,
      cutoffAt: timeline.cutoff_at,
      windowStartAt: timeline.window_start_at,
      cards: [],
      coverageNote: '编辑未能在截止前完成，仅保留已冻结且可核验的来源。',
      degradedReason: 'deterministic_fallback',
      noImportantUpdates: false,
    };
    let activeGeneration = params.generation;
    if (params.mode === 'preview') {
      if (!built) {
        await step.do('commit-preview-snapshot', async () => ({
          committed: await digests.commitSnapshot(
            params.digestId,
            params.generation,
            fallbackContent as unknown as import('../domain/contracts').Json,
            '编辑未能完成，未发布未经核验的内容。',
            '<p>编辑未能完成，未发布未经核验的内容。</p>',
            Date.now(),
          ),
        }));
      }
    } else {
      await step.sleepUntil('wait-for-build-deadline', timeline.build_deadline_at);
      const fallbackGeneration = await step.do('claim-fallback-generation', async () => (
        digests.claimFallback(params.digestId, params.generation, Date.now())
      ));
      if (fallbackGeneration !== null) {
        activeGeneration = fallbackGeneration;
        await step.do('commit-deterministic-fallback', async () => ({
          committed: await digests.commitSnapshot(
            params.digestId,
            fallbackGeneration,
            fallbackContent as unknown as import('../domain/contracts').Json,
            '编辑未能在截止前完成，未发布未经核验的内容。',
            '<p>编辑未能在截止前完成，未发布未经核验的内容。</p>',
            Date.now(),
          ),
        }));
      }
      await step.sleepUntil('wait-for-send-window', timeline.send_at);
      await step.do('deliver-digest', { retries: { limit: 0, delay: 0 } }, async () => {
        const deliveryConfig = digestSnapshot?.app.delivery ?? { channel: 'dummy' as const, destinationConfigRef: 'invalid-snapshot' };
        const currentDestinationKey = await sha256(deliveryDestinationValue(runtime.app, this.env));
        const destinationKey = digestSnapshot?.deliveryDestinationKey ?? 'invalid-snapshot';
        const snapshotApp = digestSnapshot?.app;
        const configurationMatches = digestSnapshot !== null
          && deliveryConfig.channel === runtime.app.delivery.channel
          && deliveryConfig.destinationConfigRef === runtime.app.delivery.destinationConfigRef
          && destinationKey === currentDestinationKey;
        const sender = configurationMatches && snapshotApp !== undefined
          ? createRuntimeSender(snapshotApp, this.env) : createDummySender();
        return deliverDigest(params.digestId, activeGeneration, {
          db: this.env.DB, clock: { now: () => Date.now() }, sender,
          sendEnabled: runtime.sendEnabled && this.env.APP_ENV === 'production',
          configurationMatches,
          channel: deliveryConfig.channel,
          destinationConfigRef: deliveryConfig.destinationConfigRef,
          destinationKey,
        });
      });
      await step.sleepUntil('wait-for-window-close', timeline.send_deadline_at);
    }

    await step.do('run-completed', async () => {
      await runs.markCompleted(params.runId, Date.now());
      return { runId: params.runId };
    });
    return { digestId: params.digestId, mode: params.mode, generation: params.generation };
  }
}
