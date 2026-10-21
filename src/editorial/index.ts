import { DigestRepository } from '../db/repositories/digests';
import { canonicalJson, sha256 } from '../db/repositories/shared';
import type { AppConfig, DigestContent, EventCard, ItemVersion, Json, SourceConfig } from '../domain/contracts';
import { isPromotionalTitle, scoreEvent, selectEvents } from './filter';
import { groupByEventIdentity, inferEventIdentity } from './group';
import { runEditorialModel, type EditorialComplete } from './model';
import { renderDigest } from './render';
import { validateEvidence } from './validate';
import { parseDigestConfigSnapshot } from '../config/snapshot';
import { articleText } from './evidence';

interface CandidateRow {
  ordinal: number;
  id: string;
  item_id: string;
  source_id: string;
  revision: number;
  title: string;
  canonical_url: string;
  published_at: number | null;
  ingested_at: number;
  body_text: string;
  quality: ItemVersion['quality'];
  content_hash: string;
  config_json: string;
}

export interface BuildDigestDependencies { db: D1Database; now(): number; complete?: EditorialComplete }

function asVersion(row: CandidateRow): ItemVersion {
  return { id: row.id, itemId: row.item_id, sourceId: row.source_id, revision: row.revision, title: row.title, canonicalUrl: row.canonical_url, publishedAt: row.published_at, ingestedAt: row.ingested_at, bodyText: row.body_text, quality: row.quality, contentHash: row.content_hash };
}

function quote(body: string): string {
  const normalized = body.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return [...normalized].slice(0, 240).join('');
}

export async function buildDigest(digestId: string, generation: number, dependencies: BuildDigestDependencies): Promise<DigestContent> {
  const digest = await dependencies.db.prepare(`
    SELECT local_date,window_start_at,cutoff_at,build_deadline_at,build_generation,status,config_snapshot_json,coverage_json
    FROM digests WHERE id=?1
  `).bind(digestId).first<{ local_date: string; window_start_at: number; cutoff_at: number; build_deadline_at: number;
    build_generation: number; status: string; config_snapshot_json: string; coverage_json: string }>();
  if (digest === null) throw new Error('DIGEST_NOT_FOUND');
  if (digest.build_generation !== generation || !['collecting', 'building'].includes(digest.status)) throw new Error('GENERATION_LOST');
  const rows = await dependencies.db.prepare(`
    SELECT c.ordinal,v.id,v.item_id,i.source_id,v.revision,v.title,v.canonical_url,v.published_at,
      v.ingested_at,v.body_text,v.quality,v.content_hash,s.config_json
    FROM digest_candidates c JOIN item_versions v ON v.id=c.item_version_id
    JOIN items i ON i.id=v.item_id JOIN sources s ON s.id=i.source_id
    WHERE c.digest_id=?1 ORDER BY c.ordinal
  `).bind(digestId).all<CandidateRow>();
  const versions = rows.results.map(asVersion).filter((version) => !isPromotionalTitle(version.title)
    && version.quality !== 'metadata_only' && articleText(version).length > 0);
  const identities = versions.map((version) => ({ ...inferEventIdentity(version.title), versionId: version.id }));
  const deterministicGroups = await groupByEventIdentity(identities);
  let snapshot: { app?: AppConfig; sources?: SourceConfig[] } = {};
  try {
    snapshot = parseDigestConfigSnapshot(digest.config_snapshot_json);
  } catch { snapshot = {}; }
  const appConfig = snapshot.app;
  let model: Awaited<ReturnType<typeof runEditorialModel>> | null = null;
  let editorialFailed = false;
  if (dependencies.complete !== undefined && appConfig !== undefined && versions.length > 0) {
    try {
      model = await runEditorialModel({ digestId, generation, deadlineAt: digest.build_deadline_at,
        maxOutputTokens: appConfig.llm.maxOutputTokens, promptVersion: appConfig.llm.promptVersion,
        maxCharsPerArticle: appConfig.limits.maxModelCharsPerArticle, versions,
        maxDeepRead: appConfig.limits.maxDeepRead, maxEvents: appConfig.limits.maxEvents,
        threshold: appConfig.editorial.threshold,
        targetMinChars: appConfig.editorial.targetMinChars,
        targetMaxChars: appConfig.editorial.targetMaxChars,
        maxAttemptsPerStage: appConfig.limits.maxAttemptsPerStage,
        maxRepairAttempts: appConfig.limits.maxRepairAttempts,
        sourceAuthorities: new Map((snapshot.sources ?? []).map(source => [source.id, source.authority])),
        deterministicGroups, complete: dependencies.complete });
    } catch {
      model = null;
      editorialFailed = true;
    }
  }
  const groups = model?.groups ?? deterministicGroups;
  const history = await dependencies.db.prepare(`
    SELECT de.snapshot_json FROM digest_events de JOIN digests d ON d.id=de.digest_id
    JOIN deliveries delivery ON delivery.digest_id=d.id
    WHERE d.mode='scheduled' AND d.report_kind='daily' AND delivery.status IN ('sent','uncertain') AND d.cutoff_at>=?1
  `).bind(digest.cutoff_at - (appConfig?.editorial.historyDays ?? 30) * 86_400_000).all<{ snapshot_json: string }>();
  const historyFacts = new Map<string, Set<string | null>>();
  for (const row of history.results) {
    const snapshot = JSON.parse(row.snapshot_json) as { eventKey?: unknown; factsHash?: unknown };
    if (typeof snapshot.eventKey !== 'string') continue;
    const hashes = historyFacts.get(snapshot.eventKey) ?? new Set<string | null>();
    hashes.add(typeof snapshot.factsHash === 'string' ? snapshot.factsHash : null);
    historyFacts.set(snapshot.eventKey, hashes);
  }
  const cards: EventCard[] = [];
  const draftMeta = new Map<string, { eventKey: string; factsHash: string }>();
  for (const group of groups) {
    const groupVersions = group.versionIds.map((id) => versions.find((version) => version.id === id)).filter((version): version is ItemVersion => version !== undefined);
    const primary = groupVersions[0];
    if (primary === undefined) continue;
    if (model !== null && !groupVersions.some((version) => model.keptIds.has(version.id))) continue;
    const evidenceQuote = quote(primary.bodyText);
    const fact = { text: evidenceQuote, evidence: [{ itemVersionId: primary.id, quote: evidenceQuote }] };
    const edit = model?.edits.get(group.eventKey);
    const modelFacts = edit?.facts ?? [];
    const hasVerifiedFact = model !== null && modelFacts.length > 0
      && modelFacts.every((candidate) => validateEvidence(candidate, groupVersions));
    if (model !== null && !hasVerifiedFact) continue;
    const metadataOnly = groupVersions.every((version) => version.quality === 'metadata_only');
    const modelScores = groupVersions.map((version) => model?.scoresById.get(version.id)).filter((value): value is EventCard['scores'] => value !== undefined);
    const scores = modelScores.length === 0
      ? { relevance: 100, impact: 60, evidence: metadataOnly ? 10 : 50, novelty: 80, actionability: 20 }
      : {
          relevance: Math.round(modelScores.reduce((sum, value) => sum + value.relevance, 0) / modelScores.length),
          impact: Math.round(modelScores.reduce((sum, value) => sum + value.impact, 0) / modelScores.length),
          evidence: Math.round(modelScores.reduce((sum, value) => sum + value.evidence, 0) / modelScores.length),
          novelty: Math.round(modelScores.reduce((sum, value) => sum + value.novelty, 0) / modelScores.length),
          actionability: Math.round(modelScores.reduce((sum, value) => sum + value.actionability, 0) / modelScores.length),
        };
    const eventId = `event-${await sha256(group.eventKey)}`;
    const factsHash = await sha256(canonicalJson(hasVerifiedFact
      ? modelFacts.map((candidate) => ({ text: candidate.text, quotes: candidate.evidence.map((evidence) => evidence.quote) }))
      : [{ title: primary.title.normalize('NFKC').replace(/\s+/g, ' ').trim() }]));
    const priorFacts = historyFacts.get(group.eventKey);
    if (priorFacts?.has(null) || priorFacts?.has(factsHash)) continue;
    const eventVersionId = `event-version-${await sha256(`${eventId}:${factsHash}`)}`;
    const rawScore = model === null ? (appConfig?.editorial.threshold ?? 60) : scoreEvent(scores);
    const score = model !== null && metadataOnly ? Math.min(45, rawScore) : rawScore;
    if (score < (appConfig?.editorial.threshold ?? 60)) continue;
    const frozenAuthorities = new Map((snapshot.sources ?? []).map((source) => [source.id, source.authority]));
    const authorities = groupVersions.map((version) => frozenAuthorities.get(version.sourceId) ?? null);
    const card: EventCard = {
      eventId, eventVersionId, organization: group.organization, product: group.product,
      productVersion: group.productVersion, changeKind: group.changeKind, title: hasVerifiedFact ? edit!.title : primary.title,
      summary: hasVerifiedFact ? `${groupVersions.every((version) => version.quality === 'partial') ? '来源摘要（非全文）' : '模型摘要'}：${edit!.summary}`
        : '仅根据冻结标题列出；模型编辑未启用或未通过校验。',
      whyItMatters: hasVerifiedFact ? `模型判断：${edit!.whyItMatters}` : '请打开原始来源核验详情。',
      suggestedAction: hasVerifiedFact && edit!.suggestedAction !== null ? `建议：${edit!.suggestedAction}` : null,
      evidenceLabel: hasVerifiedFact && authorities.every((authority) => authority === 'official') ? 'official' : 'unverified',
      facts: hasVerifiedFact ? modelFacts : [], scores, score,
      sourceVersionIds: groupVersions.map((version) => version.id),
      newInformation: priorFacts === undefined ? null : '来源正文包含此前快照未记录的新事实。',
    };
    cards.push(card);
    draftMeta.set(card.eventVersionId, { eventKey: group.eventKey, factsHash });
  }
  const selected = selectEvents(cards, appConfig?.editorial.threshold ?? 60, appConfig?.limits.maxEvents ?? 10,
    new Map(versions.map((version) => [version.id, version.sourceId])));
  let coreTotal = 0;
  let coreFailed = 0;
  try {
    const coverage = JSON.parse(digest.coverage_json) as { coreTotal?: unknown; coreFailed?: unknown };
    coreTotal = typeof coverage.coreTotal === 'number' ? coverage.coreTotal : 0;
    coreFailed = typeof coverage.coreFailed === 'number' ? coverage.coreFailed : 0;
  } catch { /* Invalid legacy coverage snapshots degrade to unknown coverage. */ }
  const coverageFailed = coreTotal === 0 || coreFailed > 0;
  const insufficientContent = rows.results.length > 0 && versions.length === 0;
  const awaitingBody = model?.filterDecisions.some(entry => entry.decision === 'needs_body') ?? false;
  const noImportantUpdates = selected.length === 0 && !coverageFailed && !insufficientContent && !editorialFailed && !awaitingBody;
  const content: DigestContent = {
    digestId, localDate: digest.local_date, cutoffAt: digest.cutoff_at, windowStartAt: digest.window_start_at,
    cards: selected,
    coverageNote: coverageFailed ? '采集异常，今日无法可靠判断。'
      : insufficientContent ? '已发现条目，但正文证据不足，暂不生成新闻摘要。'
        : editorialFailed ? '模型编辑未完成，本次仅保留来源标题供核验。'
          : awaitingBody ? '部分候选正文证据不足，暂未收录；本期仅发布已核验内容。' : null,
    degradedReason: coverageFailed ? 'core_sources_failed' : insufficientContent ? 'insufficient_content'
      : editorialFailed ? 'editorial_model_failed' : null,
    noImportantUpdates,
    ...(model === null ? {} : { editorialAudit: versions.map(version => {
      const result = model.filterDecisions.find(entry => entry.itemVersionId === version.id);
      const score = result === undefined ? null : scoreEvent(result.scores);
      const outcome = selected.some(card => card.sourceVersionIds.includes(version.id)) ? 'selected'
        : result === undefined ? 'filter_limit'
          : result.decision !== 'keep' ? result.decision
            : score! < (appConfig?.editorial.threshold ?? 60) ? 'below_threshold'
              : !model.keptIds.has(version.id) ? 'deep_read_limit'
                : !model.groups.some(group => group.versionIds.includes(version.id)) ? 'edit_or_evidence_rejected'
                  : !cards.some(card => card.sourceVersionIds.includes(version.id)) ? 'history_or_evidence_rejected'
                    : 'final_selection_limit';
      return { itemVersionId: version.id, title: version.title, score, outcome };
    }) }),
    sourceCoverage: (snapshot.sources ?? []).filter(source => source.enabled).map(source => ({
      sourceId: source.id, name: source.name,
      candidates: rows.results.filter(row => row.source_id === source.id).length,
      selected: selected.filter(card => card.sourceVersionIds.some(id => versions.find(version => version.id === id)?.sourceId === source.id)).length,
    })),
  };
  const urls = new Map(versions.map((version) => [version.id, version.canonicalUrl]));
  const rendered = renderDigest(content, urls, new Map(versions.map((version) => [version.id, version.publishedAt])));
  const repository = new DigestRepository(dependencies.db, { now: dependencies.now });
  const snapshotEvents = selected.flatMap((card) => {
    const meta = draftMeta.get(card.eventVersionId);
    return meta === undefined ? [] : [{ card, ...meta }];
  });
  const committed = await repository.commitSnapshot(digestId, generation, content as unknown as Json,
    rendered.text, rendered.html, dependencies.now(), snapshotEvents);
  if (!committed) throw new Error('GENERATION_LOST');
  return content;
}

export { scoreEvent } from './filter';
export { renderDigest } from './render';
export { validateEvidence } from './validate';
