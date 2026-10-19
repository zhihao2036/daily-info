import { assertDeliveryConfiguration, validateAdminToken, validateConfig, parseSendEnabled } from './config/load';
import { validateSourcesConfig } from './config/schema';
import { DigestRepository, digestIdentityId } from './db/repositories/digests';
import { RequestRepository } from './db/repositories/requests';
import { RunRepository } from './db/repositories/runs';
import { canonicalJson, sha256 } from './db/repositories/shared';
import type { AppConfig, CollectParams, DigestParams, Json, RunAccepted, SourceConfig } from './domain/contracts';
import { requestHash } from './api/idempotency';
import { createRuntimeSender, deliveryDestinationValue } from './delivery/runtime';
import { deliverDigest, recoverDeliveries } from './delivery/service';
import { dispatchRun, type WorkflowBindingLike } from './scheduler/dispatch';
import { reconcile } from './scheduler/reconcile';
import { digestTimes, isRecoveryMinute, previewTimes } from './scheduler/time';
import { buildDigest } from './editorial';
import { ensureWeeklyReport, weeklyTimes } from './editorial/weekly';
import { runRetention } from './maintenance/retention';
import type { BrowserBinding } from './collectors/browser-fallback';

export interface RuntimeEnv {
  DB: D1Database;
  ADMIN_TOKEN: string;
  APP_CONFIG: string | object;
  SOURCES_CONFIG: string | object;
  APP_ENV: string;
  SEND_ENABLED: string;
  COLLECT_WORKFLOW: Workflow<CollectParams>;
  DAILY_WORKFLOW: Workflow<DigestParams>;
  LLM_API_KEY?: string;
  GITHUB_TOKEN?: string;
  BROWSER?: BrowserBinding;
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  EMAIL_TO?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export interface RuntimeConfig { app: AppConfig; sources: SourceConfig[]; sendEnabled: boolean }

function collectionLimits(app: AppConfig): CollectParams['limits'] {
  return {
    maxPages: app.limits.maxPages,
    pageSize: app.limits.pageSize,
    maxNewBodiesPerRun: app.limits.maxNewBodiesPerRun,
    fetchTimeoutMs: app.limits.fetchTimeoutMs,
    maxResponseBytes: app.limits.maxResponseBytes,
    maxBodyBytes: app.limits.maxBodyBytes,
  };
}

export function loadRuntimeConfig(env: RuntimeEnv): RuntimeConfig {
  try {
    validateAdminToken(env.ADMIN_TOKEN);
    const appInput = typeof env.APP_CONFIG === 'string' ? JSON.parse(env.APP_CONFIG) : env.APP_CONFIG;
    const sourcesInput = typeof env.SOURCES_CONFIG === 'string' ? JSON.parse(env.SOURCES_CONFIG) : env.SOURCES_CONFIG;
    const app = validateConfig(appInput);
    const sources = validateSourcesConfig(sourcesInput).sources;
    if (sources.filter((source) => source.enabled).length > app.limits.maxSources) {
      throw new Error('CONFIG_INVALID:MAX_SOURCES');
    }
    const sendEnabled = parseSendEnabled(env.SEND_ENABLED);
    assertDeliveryConfiguration({ config: app, appEnv: env.APP_ENV, sendEnabled, emailBinding: env.EMAIL,
      ...(env.EMAIL_FROM === undefined ? {} : { emailFrom: env.EMAIL_FROM }),
      ...(env.EMAIL_TO === undefined ? {} : { emailTo: env.EMAIL_TO }),
      ...(env.TELEGRAM_BOT_TOKEN === undefined ? {} : { telegramBotToken: env.TELEGRAM_BOT_TOKEN }),
      ...(env.TELEGRAM_CHAT_ID === undefined ? {} : { telegramChatId: env.TELEGRAM_CHAT_ID }) });
    return { app, sources, sendEnabled };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('CONFIG_INVALID')) throw error;
    throw new Error('CONFIG_INVALID:RUNTIME');
  }
}

export async function syncSources(db: D1Database, sources: SourceConfig[], now: number): Promise<void> {
  const existing = await db.prepare('SELECT id,config_hash,enabled,is_core FROM sources')
    .all<{ id: string; config_hash: string; enabled: number; is_core: number }>();
  const byId = new Map(existing.results.map(source => [source.id, source]));
  const configuredIds = new Set(sources.map(source => source.id));
  const removedIds = existing.results.filter(source => source.enabled !== 0 && !configuredIds.has(source.id)).map(source => source.id);
  const statements: D1PreparedStatement[] = [];
  if (removedIds.length > 0) {
    statements.push(db.prepare('UPDATE sources SET enabled=0,updated_at=?1 WHERE enabled<>0 AND id IN (SELECT value FROM json_each(?2))')
      .bind(now, JSON.stringify(removedIds)));
  }
  for (const source of sources) {
    const configJson = canonicalJson(source);
    const configHash = await sha256(configJson);
    const current = byId.get(source.id);
    if (current?.config_hash === configHash && current.enabled === Number(source.enabled)
      && current.is_core === Number(source.core)) continue;
    statements.push(db.prepare(`INSERT INTO sources(
      id,kind,name,url,config_json,enabled,is_core,config_hash,cursor_json,created_at,updated_at
    ) VALUES (?1,?2,?3,?4,json(?5),?6,?7,?8,json(?9),?10,?10)
    ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,url=excluded.url,
      config_json=excluded.config_json,enabled=excluded.enabled,is_core=excluded.is_core,
      config_hash=excluded.config_hash,updated_at=excluded.updated_at
    WHERE sources.config_hash<>excluded.config_hash OR sources.enabled<>excluded.enabled OR sources.is_core<>excluded.is_core`)
      .bind(source.id, source.kind, source.name, source.url, configJson, source.enabled ? 1 : 0,
        source.core ? 1 : 0, configHash, JSON.stringify({ highWater: null, resume: null, scanStartedAt: null }), now));
  }
  if (statements.length > 0) await db.batch(statements);
}

async function observeOrCreate<P>(binding: Workflow<P>, workflowId: string, params: P, runs: RunRepository, runId: string, now: number): Promise<void> {
  try {
    await binding.create({ id: workflowId, params });
    await runs.markObserved(runId, now);
  } catch {
    try {
      const status = await (await binding.get(workflowId)).status();
      if (status.status !== 'unknown') await runs.markObserved(runId, now);
    } catch {
      // pending_create remains authoritative and heartbeat will retry the stable ID.
    }
  }
}

export function createApplication(env: RuntimeEnv, now: () => number = () => Date.now()) {
  const config = loadRuntimeConfig(env);
  const runs = new RunRepository(env.DB);
  const requests = new RequestRepository(env.DB);
  const digests = new DigestRepository(env.DB, { now });

  async function prepare(): Promise<void> { await syncSources(env.DB, config.sources, now()); }

  async function collect(input: { sourceId: string }, key: string): Promise<RunAccepted> {
    await prepare();
    const source = config.sources.find((candidate) => candidate.id === input.sourceId && candidate.enabled);
    if (source === undefined) throw new Error('CONFIG_INVALID:SOURCE_DISABLED');
    const scheduledAt = now();
    const deadlineAt = scheduledAt + 15 * 60_000;
    const params = { sourceId: source.id, slotKey: `api:${key}`, scheduledAt, deadlineAt,
      limits: collectionLimits(config.app) };
    const accepted = await requests.registerRequest({ scope: 'collect', key, requestHash: await requestHash(input), params, now: scheduledAt });
    if ((await runs.get(accepted.runId))?.state === 'pending_create') {
      await observeOrCreate(env.COLLECT_WORKFLOW, accepted.workflowId, { ...params, runId: accepted.runId }, runs, accepted.runId, scheduledAt);
    }
    return accepted;
  }

  async function preview(input: { date?: string }, key: string): Promise<RunAccepted> {
    await prepare();
    const createdAt = now();
    const today = digestTimes(createdAt).localDate;
    const date = input.date ?? today;
    const target = Date.parse(`${date}T00:00:00+08:00`);
    const current = Date.parse(`${today}T00:00:00+08:00`);
    if (!Number.isFinite(target) || target > current || target < current - 30 * 86_400_000) throw new Error('DATE_OUT_OF_RANGE');
    const times = previewTimes(date, createdAt);
    const digestId = await digestIdentityId({ profileId: config.app.profileId, mode: 'preview',
      localDate: times.localDate, identityKey: key, now: createdAt });
    const params = { digestId, mode: 'preview' as const, generation: 0, scheduledAt: createdAt, deadlineAt: times.sendDeadlineAt };
    const accepted = await requests.registerRequest({
      scope: 'preview', key, requestHash: await requestHash(input), params, now: createdAt,
      previewDigest: {
        id: digestId,
        profileId: config.app.profileId,
        times,
        configSnapshot: { app: config.app, sources: config.sources,
          deliveryDestinationKey: await sha256(deliveryDestinationValue(config.app, env)) } as unknown as Json,
        windowStartAt: times.cutoffAt - config.app.editorial.initialHours * 3_600_000,
      },
    });
    const registered = await env.DB.prepare('SELECT state,params_json FROM runs WHERE id=?1').bind(accepted.runId)
      .first<{ state: string; params_json: string }>();
    if (registered?.state === 'pending_create') {
      const persisted = JSON.parse(registered.params_json) as Omit<DigestParams, 'runId'> & { runId?: string };
      await observeOrCreate(env.DAILY_WORKFLOW, accepted.workflowId, { ...persisted, runId: accepted.runId }, runs, accepted.runId, createdAt);
    }
    return accepted;
  }

  async function read(path: string): Promise<Json | null> {
    const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch?.[1] !== undefined) return await runs.get(runMatch[1]) as unknown as Json | null;
    const digestMatch = path.match(/^\/api\/digests\/([^/]+)$/);
    if (digestMatch?.[1] !== undefined) {
      const row = await env.DB.prepare(`SELECT id,mode,status,content_json,coverage_json,rendered_text,rendered_html FROM digests WHERE id=?1`)
        .bind(digestMatch[1]).first<{ id: string; mode: string; status: string; content_json: string | null; coverage_json: string;
          rendered_text: string | null; rendered_html: string | null }>();
      if (row === null) return null;
      const delivery = await env.DB.prepare('SELECT status FROM deliveries WHERE digest_id=?1 ORDER BY created_at DESC LIMIT 1')
        .bind(row.id).first<{ status: string }>();
      return { id: row.id, mode: row.mode, status: row.status, content: row.content_json === null ? null : JSON.parse(row.content_json),
        coverage: JSON.parse(row.coverage_json), deliveryStatus: delivery?.status ?? null,
        renderedText: row.rendered_text, renderedHtml: row.rendered_html } as Json;
    }
    if (path === '/api/sources') {
      const result = await env.DB.prepare(`SELECT id,kind,name,url,enabled,is_core,last_success_at,last_error_code,failure_count
        FROM sources ORDER BY id`).all<Record<string, string | number | null>>();
      return result.results.map((row) => {
        if (typeof row.url !== 'string') return row;
        const value = new URL(row.url);
        return { ...row, url: `${value.origin}${value.pathname}` };
      }) as Json;
    }
    if (path === '/api/status') {
      const sources = await env.DB.prepare(`SELECT id,last_success_at,last_error_code,failure_count FROM sources WHERE enabled=1 ORDER BY id`)
        .all<Record<string, string | number | null>>();
      const today = digestTimes(now()).localDate;
      const digest = await env.DB.prepare(`SELECT id,status,local_date FROM digests WHERE mode='scheduled' AND report_kind='daily' AND local_date=?1 LIMIT 1`)
        .bind(today).first<Record<string, string | number | null>>();
      const accepted = await env.DB.prepare("SELECT MAX(accepted_at) AS value FROM deliveries WHERE status='sent'").first<{ value: number | null }>();
      const collected = await env.DB.prepare('SELECT MAX(last_success_at) AS value FROM sources').first<{ value: number | null }>();
      const budget = await env.DB.prepare('SELECT bucket_key,limit_microusd,reserved_microusd,spent_microusd FROM budget_buckets ORDER BY bucket_key DESC LIMIT 2')
        .all<Record<string, string | number>>();
      const browserDate = new Date(now()).toISOString().slice(0, 10);
      const browserUsage = await env.DB.prepare(`SELECT browser_ms_used,pages_used,reserved_browser_ms,reserved_pages
        FROM browser_usage_days WHERE date_utc=?1`).bind(browserDate)
        .first<{ browser_ms_used: number; pages_used: number; reserved_browser_ms: number; reserved_pages: number }>();
      const browserSources = await env.DB.prepare(`SELECT COUNT(*) AS cooling_sources,MAX(last_browser_error_code) AS last_error_code
        FROM sources WHERE browser_cooldown_until>?1`).bind(now())
        .first<{ cooling_sources: number; last_error_code: string | null }>();
      const usedMs = (browserUsage?.browser_ms_used ?? 0) + (browserUsage?.reserved_browser_ms ?? 0);
      const usedPages = (browserUsage?.pages_used ?? 0) + (browserUsage?.reserved_pages ?? 0);
      return { lastCollectAt: collected?.value ?? null, lastAcceptedAt: accepted?.value ?? null,
        sourceHealth: sources.results, todayDigest: digest, budgetSummary: budget.results,
        browser: { dateUtc: browserDate, remainingPages: Math.max(0, 50 - usedPages),
          remainingMs: Math.max(0, 600_000 - usedMs), coolingSources: browserSources?.cooling_sources ?? 0,
          lastErrorCode: browserSources?.last_error_code ?? null } } as Json;
    }
    return null;
  }

  async function scheduled(controller: ScheduledController): Promise<void> {
    await prepare();
    const scheduledAt = controller.scheduledTime;
    if (controller.cron === '15 * * * *') {
      await runRetention(env.DB, now(), 100);
      return;
    }
    const weekly = weeklyTimes(scheduledAt);
    if (config.app.weeklyReport?.enabled && config.sendEnabled && env.APP_ENV === 'production'
      && config.app.delivery.channel === 'telegram' && weekly !== null
      && scheduledAt >= weekly.sendAt && scheduledAt < weekly.sendDeadlineAt
      && now() >= weekly.sendAt && now() < weekly.sendDeadlineAt
      && (controller.cron === '0 0 * * 1' || controller.cron === '*/5 * * * *')) {
      const destinationKey = await sha256(deliveryDestinationValue(config.app, env));
      const id = await ensureWeeklyReport({ db: env.DB, app: config.app, sources: config.sources,
        times: weekly, destinationKey, now: now() });
      await deliverDigest(id, 0, { db: env.DB, clock: { now }, sender: createRuntimeSender(config.app, env),
        sendEnabled: true, channel: 'telegram', destinationConfigRef: config.app.delivery.destinationConfigRef,
        destinationKey });
    }
    if (controller.cron === '0 * * * *' || controller.cron === '45 23 * * *') {
      const slot = Math.floor(scheduledAt / 3_600_000);
      for (const source of config.sources.filter((candidate) => candidate.enabled && (controller.cron !== '0 * * * *' || slot % candidate.intervalHours === 0))) {
        const deadlineAt = scheduledAt + 15 * 60_000;
        const params = { runId: '', sourceId: source.id, slotKey: `${controller.cron}:${slot}`, scheduledAt, deadlineAt,
          limits: collectionLimits(config.app) };
        await dispatchRun(runs, env.COLLECT_WORKFLOW as unknown as WorkflowBindingLike<CollectParams | DigestParams>, {
          jobKey: `collect:${source.id}:${controller.cron}:${slot}`, kind: 'collect', sourceId: source.id, digestId: null,
          generation: 0, scheduledAt, deadlineAt, params,
        }, now());
      }
    }
    if (controller.cron === '45 23 * * *') {
      const times = digestTimes(scheduledAt);
      const digest = await digests.ensure({ profileId: config.app.profileId, mode: 'scheduled', times,
        configSnapshot: { app: config.app, sources: config.sources,
          deliveryDestinationKey: await sha256(deliveryDestinationValue(config.app, env)) } as unknown as Json, now: now() });
      const params = { runId: '', digestId: digest.id, mode: 'scheduled' as const, generation: digest.generation,
        scheduledAt, deadlineAt: times.sendDeadlineAt };
      await dispatchRun(runs, env.DAILY_WORKFLOW as unknown as WorkflowBindingLike<CollectParams | DigestParams>, {
        jobKey: `digest:${config.app.profileId}:${times.localDate}:${digest.generation}`, kind: 'digest', sourceId: null,
        digestId: digest.id, generation: digest.generation, scheduledAt, deadlineAt: times.sendDeadlineAt, params,
      }, now());
    }
    if (controller.cron === '*/5 * * * *') {
      await reconcile(now(), { runs, bindings: {
        collect: env.COLLECT_WORKFLOW as unknown as WorkflowBindingLike<never>,
        digest: env.DAILY_WORKFLOW as unknown as WorkflowBindingLike<never>,
        recovery: env.DAILY_WORKFLOW as unknown as WorkflowBindingLike<never>,
        preview: env.DAILY_WORKFLOW as unknown as WorkflowBindingLike<never>,
      } });
      const actualNow = now();
      const sender = createRuntimeSender(config.app, env);
      await recoverDeliveries(actualNow, {
        db: env.DB,
        clock: { now },
        sender,
        sendEnabled: config.sendEnabled && env.APP_ENV === 'production',
        weeklyEnabled: config.app.weeklyReport?.enabled ?? false,
        channel: config.app.delivery.channel,
        destinationConfigRef: config.app.delivery.destinationConfigRef,
        destinationKey: await sha256(deliveryDestinationValue(config.app, env)),
      });
      const priorHour = Math.floor(actualNow / 3_600_000) - 1;
      const priorScheduledAt = priorHour * 3_600_000;
      for (const source of config.sources.filter((candidate) => candidate.enabled && priorHour % candidate.intervalHours === 0)) {
        const deadlineAt = priorScheduledAt + 75 * 60_000;
        if (deadlineAt <= actualNow) continue;
        const params = { runId: '', sourceId: source.id, slotKey: `0 * * * *:${priorHour}`, scheduledAt: priorScheduledAt, deadlineAt,
          limits: collectionLimits(config.app) };
        await dispatchRun(runs, env.COLLECT_WORKFLOW as unknown as WorkflowBindingLike<CollectParams | DigestParams>, {
          jobKey: `collect:${source.id}:0 * * * *:${priorHour}`, kind: 'collect', sourceId: source.id, digestId: null,
          generation: 0, scheduledAt: priorScheduledAt, deadlineAt, params,
        }, actualNow);
      }
      const today = digestTimes(actualNow);
      if (actualNow >= today.morningAt && actualNow < today.sendDeadlineAt) {
        const daily = await digests.ensure({ profileId: config.app.profileId, mode: 'scheduled', times: today,
          configSnapshot: { app: config.app, sources: config.sources,
            deliveryDestinationKey: await sha256(deliveryDestinationValue(config.app, env)) } as unknown as Json, now: actualNow });
        const existingRun = await runs.findByJobKey(`digest:${config.app.profileId}:${today.localDate}:${daily.generation}`);
        if (existingRun === null && actualNow < today.buildDeadlineAt) {
          const params = { runId: '', digestId: daily.id, mode: 'scheduled' as const, generation: daily.generation,
            scheduledAt: today.morningAt, deadlineAt: today.sendDeadlineAt };
          await dispatchRun(runs, env.DAILY_WORKFLOW as unknown as WorkflowBindingLike<CollectParams | DigestParams>, {
            jobKey: `digest:${config.app.profileId}:${today.localDate}:${daily.generation}`, kind: 'digest', sourceId: null,
            digestId: daily.id, generation: daily.generation, scheduledAt: today.morningAt, deadlineAt: today.sendDeadlineAt, params,
          }, actualNow);
        }
        if (actualNow >= today.buildDeadlineAt) {
          const overdue = await env.DB.prepare('SELECT status,build_generation FROM digests WHERE id=?1')
            .bind(daily.id).first<{ status: string; build_generation: number }>();
          if (overdue !== null && ['collecting', 'building'].includes(overdue.status)) {
            await digests.freezeCandidates(daily.id, overdue.build_generation);
            const fallbackGeneration = await digests.claimFallback(daily.id, overdue.build_generation, actualNow);
            if (fallbackGeneration !== null) {
              await buildDigest(daily.id, fallbackGeneration, { db: env.DB, now: () => actualNow });
            }
          }
        }
        const isInitialSendWindow = actualNow >= today.sendAt && actualNow < today.sendAt + 5 * 60_000;
        if (isInitialSendWindow || isRecoveryMinute(actualNow)) {
          const state = await env.DB.prepare('SELECT status,build_generation FROM digests WHERE id=?1')
            .bind(daily.id).first<{ status: string; build_generation: number }>();
          if (state !== null && ['collecting', 'building', 'ready', 'delivery_failed'].includes(state.status)) {
            let generation = state.build_generation;
            if (state.status === 'collecting' || state.status === 'building') {
              generation = await digests.claimFallback(daily.id, state.build_generation, actualNow) ?? state.build_generation;
            }
            const params = { runId: '', digestId: daily.id, mode: 'scheduled' as const, generation,
              scheduledAt: today.morningAt, deadlineAt: today.sendDeadlineAt };
            const delivery = await env.DB.prepare('SELECT attempt_count FROM deliveries WHERE digest_id=?1 ORDER BY created_at LIMIT 1')
              .bind(daily.id).first<{ attempt_count: number }>();
            const recoveryKey = `recovery:${daily.id}:${generation}:${delivery?.attempt_count ?? 0}`;
            await dispatchRun(runs, env.DAILY_WORKFLOW as unknown as WorkflowBindingLike<CollectParams | DigestParams>, {
              jobKey: recoveryKey, kind: 'recovery', sourceId: null, digestId: daily.id,
              generation, scheduledAt: controller.scheduledTime, deadlineAt: today.sendDeadlineAt, params,
            }, actualNow);
          }
        }
      }
      await env.DB.prepare(`UPDATE digests SET status='expired',updated_at=?1 WHERE mode='scheduled'
        AND send_deadline_at<=?1 AND status IN ('collecting','building','ready','delivery_failed')`).bind(actualNow).run();
    }
  }

  return { config, collect, preview, read, scheduled, prepare };
}
