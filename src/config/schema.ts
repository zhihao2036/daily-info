import { z } from 'zod';
import type { AppConfig, SourceConfig } from '../domain/contracts';

const httpsUrl = z.string().url().superRefine((raw, context) => {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    context.addIssue({ code: 'custom', message: 'URL must be HTTPS and contain no credentials' });
  }
});

const nonNegativeSafeInteger = z.number().int().nonnegative().safe();
const positiveSafeInteger = z.number().int().positive().safe();

export function validateHttpsEndpoint(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('CONFIG_INVALID:HTTPS_ENDPOINT');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('CONFIG_INVALID:HTTPS_ENDPOINT'); }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error('CONFIG_INVALID:HTTPS_ENDPOINT');
  }
  return raw;
}

export const appConfigSchema = z.strictObject({
  profileId: z.literal('personal'),
  timezone: z.literal('Asia/Shanghai'),
  schedule: z.strictObject({
    morning: z.literal('07:45'),
    cutoff: z.literal('08:00'),
    buildDeadline: z.literal('08:25'),
    send: z.literal('08:30'),
    close: z.literal('09:00'),
  }),
  weeklyReport: z.strictObject({ enabled: z.boolean() }).optional(),
  limits: z.strictObject({
    maxSources: positiveSafeInteger.max(20),
    maxPages: positiveSafeInteger.max(3),
    pageSize: positiveSafeInteger.max(30),
    maxNewBodiesPerRun: positiveSafeInteger.max(20),
    fetchTimeoutMs: positiveSafeInteger.max(15_000),
    llmTimeoutMs: positiveSafeInteger.max(60_000),
    maxResponseBytes: positiveSafeInteger.max(2 * 1024 * 1024),
    maxBodyBytes: positiveSafeInteger.max(128 * 1024),
    maxModelCharsPerArticle: positiveSafeInteger.max(12_000),
    maxCandidates: positiveSafeInteger.max(200),
    maxDeepRead: positiveSafeInteger.max(20),
    maxEvents: positiveSafeInteger.max(10),
    perInstanceConcurrency: positiveSafeInteger.max(2),
    maxAttemptsPerStage: positiveSafeInteger.max(3),
    maxRepairAttempts: positiveSafeInteger.max(1),
  }),
  editorial: z.strictObject({
    targetMinChars: positiveSafeInteger,
    targetMaxChars: positiveSafeInteger,
    historyDays: positiveSafeInteger,
    lateHours: positiveSafeInteger,
    initialHours: positiveSafeInteger,
    threshold: z.number().min(0).max(100),
  }),
  llm: z.strictObject({
    baseUrl: httpsUrl,
    model: z.string().trim().min(1),
    promptVersion: z.string().trim().min(1),
    jsonMode: z.enum(['json_schema', 'json_object', 'none']),
    thinking: z.enum(['enabled', 'disabled']).optional(),
    maxOutputTokens: positiveSafeInteger,
    tokenizer: z.enum(['provider_exact', 'conservative_utf8']),
    inputMicrousdPerMillionTokens: nonNegativeSafeInteger.nullable(),
    outputMicrousdPerMillionTokens: nonNegativeSafeInteger.nullable(),
    pricingIncludesAllBillableTokens: z.boolean(),
  }),
  budget: z.strictObject({
    dayMicrousd: nonNegativeSafeInteger,
    monthMicrousd: nonNegativeSafeInteger,
  }),
  delivery: z.strictObject({
    channel: z.enum(['dummy', 'cloudflare_email', 'telegram']),
    destinationConfigRef: z.string().trim().min(1),
  }),
}).superRefine((config, context) => {
  if (config.editorial.targetMinChars > config.editorial.targetMaxChars) {
    context.addIssue({ code: 'custom', path: ['editorial', 'targetMinChars'], message: 'minimum exceeds maximum' });
  }
  if (config.budget.dayMicrousd > config.budget.monthMicrousd) {
    context.addIssue({ code: 'custom', path: ['budget'], message: 'daily budget exceeds monthly budget' });
  }
});

const sourceConfigSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().trim().min(1),
  kind: z.enum(['rss', 'github_releases', 'html_list']),
  url: httpsUrl,
  enabled: z.boolean(),
  core: z.boolean(),
  priority: z.number().int().min(0).max(100),
  authority: z.enum(['official', 'community', 'individual']),
  allowedHosts: z.array(z.string().trim().min(1)).min(1),
  intervalHours: z.number().int().min(1).max(24),
  verification: z.enum(['discovered', 'worker_verified']),
  browserFallbackEnabled: z.boolean().default(false),
  upgradeHttpLinks: z.boolean().optional(),
  github: z.strictObject({
    owner: z.string().trim().min(1),
    repo: z.string().trim().min(1),
    includePrerelease: z.boolean(),
  }).optional(),
  html: z.strictObject({
    listLinkSelector: z.string().trim().min(1),
    articleSelector: z.string().trim().min(1),
    dateSelector: z.string().trim().min(1).optional(),
    changelog: z.strictObject({
      entrySelector: z.string().trim().min(1), titleSelector: z.string().trim().min(1),
      dateSelector: z.string().trim().min(1), yearSelector: z.string().trim().min(1),
    }).optional(),
  }).optional(),
}).superRefine((source, context) => {
  const host = new URL(source.url).hostname.toLowerCase();
  if (!source.allowedHosts.map((entry) => entry.toLowerCase()).includes(host)) {
    context.addIssue({ code: 'custom', path: ['url'], message: 'source host is outside allowedHosts' });
  }
  if (source.kind === 'github_releases' && source.github === undefined) {
    context.addIssue({ code: 'custom', path: ['github'], message: 'GitHub configuration is required' });
  }
  if (source.kind === 'html_list' && source.html === undefined) {
    context.addIssue({ code: 'custom', path: ['html'], message: 'HTML selectors are required' });
  }
  if (source.kind === 'github_releases' && source.browserFallbackEnabled) {
    context.addIssue({ code: 'custom', path: ['browserFallbackEnabled'], message: 'Browser fallback is unavailable for GitHub releases' });
  }
  if (source.enabled && source.verification !== 'worker_verified') {
    context.addIssue({ code: 'custom', path: ['verification'], message: 'enabled sources must be worker verified' });
  }
});

const sourcesConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sources: z.array(sourceConfigSchema),
}).superRefine((registry, context) => {
  const ids = new Set<string>();
  let enabled = 0;
  for (const [index, source] of registry.sources.entries()) {
    if (ids.has(source.id)) {
      context.addIssue({ code: 'custom', path: ['sources', index, 'id'], message: 'duplicate source id' });
    }
    ids.add(source.id);
    if (source.enabled) enabled += 1;
  }
  if (enabled > 20) context.addIssue({ code: 'custom', path: ['sources'], message: 'at most 20 sources may be enabled' });
});

export function validateSourcesConfig(input: unknown): { schemaVersion: 1; sources: SourceConfig[] } {
  // A Cloudflare text/JSON binding is limited to 5 KiB. Share only operational
  // defaults; identity, URLs, host allowlists and selectors stay per-source.
  const shape = sourceConfigSchema.shape;
  const registry = z.strictObject({
    schemaVersion: z.literal(1),
    defaults: z.strictObject({
      kind: shape.kind.optional(), enabled: shape.enabled.optional(),
      core: shape.core.optional(), priority: shape.priority.optional(),
      authority: shape.authority.optional(), intervalHours: shape.intervalHours.optional(),
      verification: shape.verification.optional(), browserFallbackEnabled: z.boolean().optional(),
    }).optional(),
    sources: z.array(z.record(z.string(), z.unknown())),
  }).parse(input);
  return sourcesConfigSchema.parse({ schemaVersion: registry.schemaVersion,
    sources: registry.sources.map(source => ({ ...registry.defaults, ...source })) }) as { schemaVersion: 1; sources: SourceConfig[] };
}

export function parseAppConfig(input: unknown): AppConfig {
  return appConfigSchema.parse(input) as AppConfig;
}
