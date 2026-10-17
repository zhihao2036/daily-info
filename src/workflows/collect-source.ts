import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { createCollector } from '../collectors';
import { createBrowserFallback, type BrowserBinding } from '../collectors/browser-fallback';
import { BrowserFallbackRepository } from '../db/repositories/browser-fallback';
import { resumeCursor } from '../collectors/cursor';
import { D1Persistence } from '../db/repositories';
import { RunRepository } from '../db/repositories/runs';
import type { BodyRetryCandidate, CollectParams, Json, SourceConfig } from '../domain/contracts';

export interface CollectWorkflowEnv { DB: D1Database; GITHUB_TOKEN?: string; BROWSER?: BrowserBinding }

export class CollectSourceWorkflow extends WorkflowEntrypoint<CollectWorkflowEnv, CollectParams> {
  async run(event: Readonly<WorkflowEvent<CollectParams>>, step: WorkflowStep): Promise<unknown> {
    const params = event.payload;
    const limits = params.limits ?? {
      maxPages: 3, pageSize: 30, maxNewBodiesPerRun: 20,
      fetchTimeoutMs: 15_000, maxResponseBytes: 2 * 1024 * 1024, maxBodyBytes: 128 * 1024,
    };
    const persistence = new D1Persistence(this.env.DB);
    const runs = new RunRepository(this.env.DB);
    await step.do('run-observed', async () => {
      await runs.markObserved(params.runId, Date.now());
      return { runId: params.runId };
    });
    const sourceStateJson = await step.do<string | null>('load-source', async () => {
      const row = await this.env.DB.prepare('SELECT config_json,cursor_json,cursor_version,etag,last_modified FROM sources WHERE id=?1 AND enabled=1')
        .bind(params.sourceId).first<{ config_json: string; cursor_json: string | null; cursor_version: number;
          etag: string | null; last_modified: string | null }>();
      return row === null ? null : JSON.stringify({ source: JSON.parse(row.config_json),
        cursor: row.cursor_json === null ? null : JSON.parse(row.cursor_json), cursorVersion: row.cursor_version,
        etag: row.etag, lastModified: row.last_modified });
    });
    const sourceState = sourceStateJson === null ? null : JSON.parse(sourceStateJson) as {
      source: SourceConfig; cursor: Json; cursorVersion: number; etag: string | null; lastModified: string | null;
    };
    const source = sourceState?.source ?? null;
    if (source === null) {
      await step.do('complete-disabled-source', async () => { await runs.markCompleted(params.runId, Date.now()); return {}; });
      return { sourceId: params.sourceId, pages: 0 };
    }
    let lease = await step.do('acquire-lease', async () => persistence.acquireLease(params.sourceId, params.runId, Date.now()));
    if (lease === null) {
      await step.do('complete-lease-busy', async () => { await runs.markCompleted(params.runId, Date.now()); return {}; });
      return { sourceId: params.sourceId, pages: 0, skipped: 'lease_busy' };
    }
    const refreshLease = async () => {
      const renewed = await persistence.renewLease(lease!, Date.now());
      if (renewed === null) throw new Error('LEASE_LOST');
      return renewed;
    };
    let cursor: Json = resumeCursor(sourceState?.cursor ?? null);
    let cursorVersion = sourceState?.cursorVersion ?? 0;
    const retryStateJson = await step.do<string>('load-body-retries', async () => {
      const rows = await this.env.DB.prepare(`SELECT i.external_key,v.metadata_json FROM items i
        JOIN item_versions v ON v.item_id=i.id AND v.revision=i.current_revision
        WHERE i.source_id=?1 AND v.quality IN ('metadata_only','partial') AND i.last_seen_at>=?2
        ORDER BY i.last_seen_at DESC LIMIT 100`).bind(params.sourceId, Date.now() - 7 * 86_400_000)
        .all<{ external_key: string; metadata_json: string }>();
      return JSON.stringify(Object.fromEntries(rows.results.map((row) => {
        const metadata = JSON.parse(row.metadata_json) as { extractionAttempts?: unknown; nextBodyRetryAt?: unknown };
        return [row.external_key, {
          attempts: typeof metadata.extractionAttempts === 'number' ? metadata.extractionAttempts : 0,
          nextBodyRetryAt: typeof metadata.nextBodyRetryAt === 'number' ? metadata.nextBodyRetryAt : null,
        }];
      })));
    });
    const retryState = JSON.parse(retryStateJson) as Record<string, { attempts: number; nextBodyRetryAt: number | null }>;
    const bodyRetriesJson = await step.do<string>('find-body-retries', async () => JSON.stringify(
      await persistence.findBodyRetryCandidates(params.sourceId, Date.now(), limits.maxNewBodiesPerRun),
    ));
    const bodyRetries = JSON.parse(bodyRetriesJson) as BodyRetryCandidate[];
    let remainingBodies = limits.maxNewBodiesPerRun;
    let pages = 0;
    let etag: string | undefined;
    let lastModified: string | undefined;
    try {
      for (let pageNo = 0; pageNo < limits.maxPages; pageNo += 1) {
        lease = await step.do(`source-${params.sourceId}-page-${pageNo}-renew`, refreshLease);
        const requestCursor = cursor;
        const pageJson = await step.do<string>(`source-${params.sourceId}-page-${pageNo}-fetch`, {
          retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes',
        }, async () => {
          const controller = new AbortController();
          const browserFallback = this.env.BROWSER === undefined ? undefined : createBrowserFallback({
            binding: this.env.BROWSER, repository: new BrowserFallbackRepository(this.env.DB), now: () => Date.now(),
          });
          const options = { ...(this.env.GITHUB_TOKEN === undefined ? {} : { githubToken: this.env.GITHUB_TOKEN }),
            ...(browserFallback === undefined ? {} : { browserFallback }) };
          let value;
          try { value = await createCollector(source.kind, options).fetchPage({
            source,
            cursor: requestCursor,
            deadlineAt: params.deadlineAt,
            signal: controller.signal,
            bodyBudget: remainingBodies,
            retryState,
            bodyRetryCandidates: pageNo === 0 ? bodyRetries : [],
            pageSize: limits.pageSize,
            fetchTimeoutMs: limits.fetchTimeoutMs,
            maxResponseBytes: limits.maxResponseBytes,
            maxBodyBytes: limits.maxBodyBytes,
            conditional: { etag: sourceState?.etag ?? null, lastModified: sourceState?.lastModified ?? null },
            runId: params.runId,
            lease: lease!,
            beforeRequest: async () => {
              if (Date.now() >= params.deadlineAt) throw new Error('COLLECT_DEADLINE_EXCEEDED');
              lease = await refreshLease();
            },
          }); } catch (error) {
            if (error instanceof Error && /^(?:HTTP_STATUS:(?:401|403)|XML_(?:NODE_LIMIT|DEPTH_LIMIT|DTD_FORBIDDEN)|COLLECT_DEADLINE_EXCEEDED)$/.test(error.message)) {
              throw new NonRetryableError(error.message);
            }
            throw error;
          }
          return JSON.stringify(value);
        });
        const page = JSON.parse(pageJson) as {
          items: import('../domain/contracts').RawItem[];
          nextCursor: Json;
          complete: boolean;
          bodyFetches?: number;
          etag?: string;
          lastModified?: string;
        };
        await step.do(`source-${params.sourceId}-page-${pageNo}-commit`, async () => {
          const current = await refreshLease();
          lease = current;
          await persistence.commitPage({ runId: params.runId, pageNo, lease: current, items: page.items,
            requestCursor, expectedCursorVersion: cursorVersion, nextCursor: page.nextCursor, complete: page.complete });
          return { count: page.items.length, complete: page.complete };
        });
        pages += 1;
        cursor = page.nextCursor;
        cursorVersion += 1;
        remainingBodies = Math.max(0, remainingBodies - (page.bodyFetches ?? 0));
        etag = page.etag ?? etag;
        lastModified = page.lastModified ?? lastModified;
        if (page.complete) break;
        if (source.kind !== 'github_releases' && remainingBodies === 0) break;
      }
      await step.do('source-success', async () => {
        await persistence.markSourceSuccess(lease!, Date.now(), etag, lastModified);
        return { pages };
      });
    } catch (error) {
      await step.do('source-failure', async () => {
        const code = error instanceof Error ? error.message : 'COLLECT_FAILED';
        await persistence.markSourceFailure(lease!, code, Date.now());
        await runs.markFailed(params.runId, code.slice(0, 120), Date.now());
        return {};
      });
      throw error;
    }
    await step.do('run-completed', async () => { await runs.markCompleted(params.runId, Date.now()); return { pages }; });
    return { sourceId: params.sourceId, pages };
  }
}
