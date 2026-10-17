/** Normative business contracts, not a runnable Worker. Runtime validation is required. */
export type Id = string;
export type EpochMs = number;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type SourceKind = 'rss' | 'github_releases' | 'html_list';
export type ContentQuality = 'full' | 'partial' | 'metadata_only';
export type DigestMode = 'scheduled' | 'preview';
export type DigestStatus = 'collecting' | 'building' | 'ready' | 'sending' | 'sent' | 'delivery_failed' | 'uncertain' | 'expired';
export type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'suppressed';
export type AttemptState = 'reserved' | 'calling' | 'succeeded' | 'failed' | 'uncertain';
export type Stage = 'filter' | 'group' | 'edit' | 'repair';
export type EvidenceLabel = 'official' | 'independent_test' | 'opinion' | 'unverified';
export type BrowserFallbackFailure = 'disabled' | 'cooldown' | 'quota' | 'blocked' | 'deadline' | 'lease_lost' | 'render_failed';
export interface SourceConfig {
  id: Id; name: string; kind: SourceKind; url: string;
  enabled: boolean; core: boolean; priority: number;
  authority: 'official' | 'community' | 'individual';
  allowedHosts: string[]; intervalHours: number;
  verification: 'discovered' | 'worker_verified';
  browserFallbackEnabled: boolean;
  upgradeHttpLinks?: boolean;
  github?: { owner: string; repo: string; includePrerelease: boolean };
  html?: { listLinkSelector: string; articleSelector: string; dateSelector?: string };
}
export interface AppConfig {
  profileId: 'personal'; timezone: 'Asia/Shanghai';
  schedule: { morning: '07:45'; cutoff: '08:00'; buildDeadline: '08:25'; send: '08:30'; close: '09:00' };
  limits: {
    maxSources: number; maxPages: number; pageSize: number; maxNewBodiesPerRun: number;
    fetchTimeoutMs: number; llmTimeoutMs: number; maxResponseBytes: number;
    maxBodyBytes: number; maxModelCharsPerArticle: number; maxCandidates: number;
    maxDeepRead: number; maxEvents: number; perInstanceConcurrency: number;
    maxAttemptsPerStage: number; maxRepairAttempts: number;
  };
  editorial: { targetMinChars: number; targetMaxChars: number; historyDays: number; lateHours: number; initialHours: number; threshold: number };
  llm: {
    baseUrl: string; model: string; promptVersion: string;
    jsonMode: 'json_schema' | 'json_object' | 'none';
    thinking?: 'enabled' | 'disabled';
    maxOutputTokens: number; tokenizer: 'provider_exact' | 'conservative_utf8';
    inputMicrousdPerMillionTokens: number | null;
    outputMicrousdPerMillionTokens: number | null;
    pricingIncludesAllBillableTokens: boolean;
  };
  budget: { dayMicrousd: number; monthMicrousd: number };
  delivery: { channel: 'dummy' | 'cloudflare_email' | 'telegram'; destinationConfigRef: string };
}
export interface RawItem {
  externalKey: string; canonicalUrl: string; title: string;
  publishedAt: EpochMs | null; sourceUpdatedAt: EpochMs | null;
  body: string; quality: ContentQuality; metadata: { [key: string]: Json };
}
export interface CollectionPage { items: RawItem[]; nextCursor: Json; complete: boolean; etag?: string; lastModified?: string }
export interface SourceCursor { value: Json; version: number }
export interface Lease { sourceId: Id; ownerId: Id; fencingToken: number; expiresAt: EpochMs }
export interface Collector {
  fetchPage(input: { source: SourceConfig; cursor: Json; deadlineAt: EpochMs; signal: AbortSignal }): Promise<CollectionPage>;
}
export interface ItemVersion {
  id: Id; itemId: Id; sourceId: Id; revision: number; title: string;
  canonicalUrl: string; publishedAt: EpochMs | null; ingestedAt: EpochMs;
  bodyText: string; quality: ContentQuality; contentHash: string;
}
export interface FrozenCandidate { ordinal: number; reason: 'new' | 'late' | 'updated' | 'initial'; version: ItemVersion }
export interface EvidenceRef { itemVersionId: Id; quote: string }
export interface Fact { text: string; evidence: EvidenceRef[] }
export interface EventCard {
  eventId: Id; eventVersionId: Id; organization: string; product: string;
  productVersion: string; changeKind: string; title: string;
  summary: string; whyItMatters: string; suggestedAction: string | null;
  evidenceLabel: EvidenceLabel; facts: Fact[];
  scores: { relevance: number; impact: number; evidence: number; novelty: number; actionability: number };
  score: number; sourceVersionIds: Id[]; newInformation: string | null;
}
export interface DigestContent {
  digestId: Id; localDate: string; cutoffAt: EpochMs; windowStartAt: EpochMs;
  cards: EventCard[]; coverageNote: string | null;
  degradedReason: string | null; noImportantUpdates: boolean;
  sourceCoverage?: Array<{ sourceId: string; name: string; candidates: number; selected: number }>;
}
export interface DigestTimes { localDate: string; morningAt: EpochMs; cutoffAt: EpochMs; buildDeadlineAt: EpochMs; sendAt: EpochMs; sendDeadlineAt: EpochMs }
export interface CollectParams { runId: Id; sourceId: Id; slotKey: string; scheduledAt: EpochMs; deadlineAt: EpochMs }
export interface DigestParams { runId: Id; digestId: Id; mode: DigestMode; generation: number; scheduledAt: EpochMs; deadlineAt: EpochMs }
export interface RunAccepted { runId: Id; workflowId: Id; statusUrl: string }
export interface RunStatus {
  runId: Id; kind: 'collect' | 'digest' | 'recovery' | 'preview';
  state: 'pending_create' | 'running' | 'completed' | 'failed' | 'expired' | 'cancelled';
  phase: string | null; digestId: Id | null; resultUrl: string | null;
  errorCode: string | null; scheduledAt: EpochMs; startedAt: EpochMs | null; finishedAt: EpochMs | null;
}
export interface ApiError { error: { code: string; message: string; requestId: string; retryable: boolean } }
export interface DeliveryPayload { subject: string; text: string; html: string; destinationConfigRef: string; payloadHash: string }
export type SendResult =
  | { kind: 'accepted'; providerMessageId: string | null; acceptedAt: EpochMs }
  | { kind: 'rejected'; retryable: boolean; code: string; retryAfterMs?: number }
  | { kind: 'uncertain'; code: string }
  | { kind: 'suppressed'; reason: 'preview' | 'send_disabled' | 'dummy' | 'deadline' };
export interface Sender {
  send(payload: DeliveryPayload, attemptId: Id, signal: AbortSignal): Promise<SendResult>;
}
export interface LlmRequest { stage: Stage; digestId: Id; input: Json; maxOutputTokens: number }
export interface LlmResponse { value: Json; usage: { inputTokens: number; outputTokens: number } | null; providerRequestId: string | null }
export interface LlmProvider { complete(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> }
export interface BudgetReservation { callId: Id; dayBucket: string; monthBucket: string; reservedMicrousd: number }
export interface Clock { now(): EpochMs }

export interface BudgetedCall {
  request: LlmRequest;
  invocationId: Id; // digestId + generation + ownerStage + stable batch ordinal + prompt version
  ownerStage: Exclude<Stage, 'repair'>;
  attemptNo: number; // 1..maxAttemptsPerStage, repair uses the same owner-stage counter
  generation: number;
  deadlineAt: EpochMs;
}
