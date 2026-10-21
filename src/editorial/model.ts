import { z } from 'zod';
import type { BudgetedCall, EventCard, Fact, ItemVersion, LlmResponse } from '../domain/contracts';
import { PROMPTS } from '../prompts';
import { validateEvidence } from './validate';
import { scoreEvent } from './filter';
import { articleText, evidenceSnippets, sharesTopic } from './evidence';

export type EditorialComplete = (call: BudgetedCall) => Promise<LlmResponse>;

const scores = z.strictObject({
  relevance: z.number().int().min(0).max(100),
  impact: z.number().int().min(0).max(100),
  evidence: z.number().int().min(0).max(100),
  novelty: z.number().int().min(0).max(100),
  actionability: z.number().int().min(0).max(100),
});
const filterOutput = z.strictObject({ results: z.array(z.strictObject({
  itemVersionId: z.string().min(1),
  decision: z.enum(['keep', 'drop', 'needs_body']),
  scores,
})).max(200) });
const groupOutput = z.strictObject({ groups: z.array(z.strictObject({
  eventKey: z.string().min(1),
  memberIds: z.array(z.string().min(1)).min(1).max(20),
  confidence: z.number().min(0).max(1),
})).max(200) });
const editOutput = z.strictObject({ cards: z.array(z.strictObject({
  eventKey: z.string().min(1),
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(600),
  whyItMatters: z.string().trim().min(1).max(400),
  suggestedAction: z.string().trim().max(300).nullable(),
  facts: z.array(z.strictObject({
    text: z.string().trim().min(1).max(600),
    evidence: z.array(z.strictObject({ itemVersionId: z.string().min(1), quote: z.string().min(1).max(240) })).min(1).max(3),
  })).min(1).max(5),
})).max(10) });
const stageSchemas = {
  filter: z.toJSONSchema(filterOutput),
  group: z.toJSONSchema(groupOutput),
  edit: z.toJSONSchema(editOutput),
} as const;

export function validateEditorialResponse(stage: 'filter' | 'group' | 'edit', value: LlmResponse['value']): LlmResponse['value'] {
  if (stage === 'filter') return filterOutput.parse(value) as LlmResponse['value'];
  if (stage === 'group') return groupOutput.parse(value) as LlmResponse['value'];
  return editOutput.parse(value) as LlmResponse['value'];
}

export interface ModelGroupInput {
  eventKey: string;
  organization: string;
  product: string;
  productVersion: string;
  changeKind: string;
  versionIds: string[];
}

export interface EditorialModelResult {
  filterDecisions: z.infer<typeof filterOutput>['results'];
  keptIds: Set<string>;
  scoresById: Map<string, EventCard['scores']>;
  groups: ModelGroupInput[];
  edits: Map<string, { title: string; summary: string; whyItMatters: string; suggestedAction: string | null; facts: Fact[] }>;
}

function assertExactIds(actual: string[], expected: string[], code: string): void {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length
    || [...actual].sort().join('\n') !== [...expected].sort().join('\n')) throw new Error(code);
}

function safeEditorialText(value: string): boolean {
  return !/(?:https?:\/\/|<[^>]*>|\[[^\]]*\]\([^)]*\))/i.test(value);
}

function supportedNumbers(value: string, source: string): boolean {
  return [...value.matchAll(/\b\d+(?:\.\d+)*(?:%|x)?\b/gi)].every((match) => source.includes(match[0]));
}

function citationKey(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|\d+);/gi, (raw, code: string) => {
    const point = code[0]!.toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number(code);
    return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : raw;
  }).replace(/&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/&amp;/gi, '&')
    .normalize('NFKC').replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

async function callStage(
  complete: EditorialComplete,
  ownerStage: 'filter' | 'group' | 'edit',
  digestId: string,
  generation: number,
  deadlineAt: number,
  maxOutputTokens: number,
  promptVersion: string,
  payload: unknown,
  batchIndex: number,
  attemptNo = 1,
  repair = false,
): Promise<LlmResponse> {
  const requestStage = repair ? 'repair' : ownerStage;
  return complete({
    request: { stage: requestStage, digestId, input: {
      system: PROMPTS[requestStage].system,
      outputSchema: stageSchemas[ownerStage],
      payload: repair ? { task: payload, instruction: 'Return a corrected response matching outputSchema exactly.' } : payload,
    } as never, maxOutputTokens },
    invocationId: `${digestId}:${generation}:${ownerStage}:${batchIndex}:${promptVersion}`,
    ownerStage,
    attemptNo,
    generation,
    deadlineAt,
  });
}

async function callWithRepair(input: {
  complete: EditorialComplete;
  stage: 'filter' | 'group' | 'edit';
  digestId: string;
  generation: number;
  deadlineAt: number;
  maxOutputTokens: number;
  promptVersion: string;
  payload: unknown;
  batchIndex: number;
  maxRepairAttempts: number;
}): Promise<LlmResponse> {
  try {
    return await callStage(input.complete, input.stage, input.digestId, input.generation, input.deadlineAt,
      input.maxOutputTokens, input.promptVersion, input.payload, input.batchIndex);
  } catch (error) {
    const repairable = error instanceof z.ZodError || (error instanceof Error && error.message.includes('RESPONSE_INVALID'));
    if (!repairable || input.maxRepairAttempts < 1) throw error;
    return callStage(input.complete, input.stage, input.digestId, input.generation, input.deadlineAt,
      input.maxOutputTokens, input.promptVersion, input.payload, input.batchIndex, 2, true);
  }
}

export async function runEditorialModel(input: {
  digestId: string;
  generation: number;
  deadlineAt: number;
  maxOutputTokens: number;
  promptVersion: string;
  maxCharsPerArticle: number;
  maxDeepRead: number;
  maxEvents: number;
  threshold?: number;
  targetMinChars?: number;
  targetMaxChars?: number;
  maxAttemptsPerStage: number;
  maxRepairAttempts: number;
  versions: ItemVersion[];
  sourceAuthorities?: ReadonlyMap<string, string>;
  deterministicGroups: ModelGroupInput[];
  complete: EditorialComplete;
}): Promise<EditorialModelResult> {
  const eligibleVersions = input.versions.filter((version) => version.quality !== 'metadata_only'
    && articleText(version).trim().length > 0);
  const callsByStage = new Map<BudgetedCall['ownerStage'], number>();
  const completeWithinLimit: EditorialComplete = async (call) => {
    const used = callsByStage.get(call.ownerStage) ?? 0;
    if (used >= input.maxAttemptsPerStage) throw new Error('STAGE_CALL_LIMIT');
    callsByStage.set(call.ownerStage, used + 1);
    return input.complete(call);
  };
  const filterResults: z.infer<typeof filterOutput>['results'] = [];
  for (let offset = 0; offset < eligibleVersions.length
    && (callsByStage.get('filter') ?? 0) < input.maxAttemptsPerStage; offset += 20) {
    const batch = eligibleVersions.slice(offset, offset + 20);
    const filter = filterOutput.parse((await callWithRepair({ complete: completeWithinLimit, stage: 'filter',
      digestId: input.digestId, generation: input.generation, deadlineAt: input.deadlineAt,
      maxOutputTokens: input.maxOutputTokens, promptVersion: input.promptVersion, batchIndex: offset / 20,
      maxRepairAttempts: input.maxRepairAttempts, payload: {
      candidates: batch.map((version) => ({
        itemVersionId: version.id,
        title: version.title,
        quality: version.quality,
        sourceId: version.sourceId,
        authority: input.sourceAuthorities?.get(version.sourceId) ?? 'unverified',
        publishedAt: version.publishedAt,
        body: [...articleText(version)].slice(0, input.maxCharsPerArticle).join(''),
      })),
    } })).value);
    const allowedIds = new Set(batch.map(version => version.id));
    const counts = new Map<string, number>();
    for (const entry of filter.results) counts.set(entry.itemVersionId, (counts.get(entry.itemVersionId) ?? 0) + 1);
    // A missing or duplicated decision is unscored, not a reason to discard
    // every other batch. Foreign IDs can never enter the editorial pipeline.
    filterResults.push(...filter.results.filter(entry => allowedIds.has(entry.itemVersionId)
      && counts.get(entry.itemVersionId) === 1));
  }
  const scoresById = new Map(filterResults.map((entry) => [entry.itemVersionId, entry.scores]));
  const keptIds = new Set(filterResults.filter((entry) => entry.decision === 'keep' && scoreEvent(entry.scores) >= (input.threshold ?? 60))
    .sort((left, right) => scoreEvent(right.scores) - scoreEvent(left.scores) || left.itemVersionId.localeCompare(right.itemVersionId))
    .slice(0, input.maxDeepRead).map((entry) => entry.itemVersionId));
  const eligibleGroups = input.deterministicGroups.map((group) => ({ ...group,
    versionIds: group.versionIds.filter((id) => keptIds.has(id)) })).filter((group) => group.versionIds.length > 0);
  if (eligibleGroups.length === 0) return { filterDecisions: filterResults, keptIds, scoresById, groups: [], edits: new Map() };
  const allowedById = new Map(eligibleGroups.flatMap((group) => group.versionIds.map((id) => [id, group.eventKey])));
  const grouped = groupOutput.parse((await callWithRepair({ complete: completeWithinLimit, stage: 'group',
    digestId: input.digestId, generation: input.generation, deadlineAt: input.deadlineAt,
    maxOutputTokens: input.maxOutputTokens, promptVersion: input.promptVersion, payload: { groups: eligibleGroups.map(group => ({
      ...group, articles: group.versionIds.map(id => {
        const version = input.versions.find(version => version.id === id)!;
        return { itemVersionId: id, sourceId: version.sourceId, authority: input.sourceAuthorities?.get(version.sourceId) ?? 'unverified',
          title: version.title, evidenceSnippets: evidenceSnippets(version).slice(0, 4) };
      }),
    })) },
    batchIndex: 0, maxRepairAttempts: input.maxRepairAttempts })).value);
  const modelIds = grouped.groups.flatMap((group) => group.memberIds);
  assertExactIds(modelIds, [...keptIds], 'GROUP_IDS_INVALID');
  const groups: ModelGroupInput[] = [];
  for (const proposal of grouped.groups) {
    const bases = proposal.memberIds.map(id => eligibleGroups.find(group => group.versionIds.includes(id))!);
    const crossIdentity = new Set(bases.map(base => base.eventKey)).size > 1;
    const versions = proposal.memberIds.map(id => input.versions.find(version => version.id === id)!);
    const explicitVersions = new Set(bases.map(base => base.productVersion).filter(version => /^\d+(?:\.\d+)+$/.test(version)));
    if (proposal.confidence < 0.86 || (crossIdentity && (proposal.confidence < 0.92
      || explicitVersions.size > 1 || !sharesTopic(versions)))) {
      for (const id of proposal.memberIds) {
        const base = eligibleGroups.find((candidate) => candidate.versionIds.includes(id));
        if (base !== undefined) groups.push({ ...base, eventKey: `${base.eventKey}-${id.slice(0, 12)}`, versionIds: [id] });
      }
      continue;
    }
    const primary = versions.find(version => input.sourceAuthorities?.get(version.sourceId) === 'official') ?? versions[0]!;
    const expectedKey = allowedById.get(primary.id);
    if (expectedKey === undefined) throw new Error('GROUP_CONFLICT');
    const base = eligibleGroups.find((candidate) => candidate.eventKey === expectedKey)!;
    groups.push({ ...base, versionIds: [primary.id, ...proposal.memberIds.filter(id => id !== primary.id)] });
  }
  const selectedGroups = groups.sort((left, right) => {
    const average = (group: ModelGroupInput) => group.versionIds.reduce((sum, id) => {
      const value = scoresById.get(id);
      return sum + (value === undefined ? 0 : scoreEvent(value));
    }, 0) / group.versionIds.length;
    return average(right) - average(left) || left.eventKey.localeCompare(right.eventKey);
  }).slice(0, Math.min(20, input.maxDeepRead));
  if (selectedGroups.length === 0) return { filterDecisions: filterResults, keptIds, scoresById, groups: [], edits: new Map() };
  const drafts = selectedGroups.map((group) => {
    const versions = group.versionIds.map((id) => input.versions.find((version) => version.id === id)!).filter(Boolean);
    return { eventKey: group.eventKey, organization: group.organization, product: group.product,
      productVersion: group.productVersion, changeKind: group.changeKind,
      sources: versions.map((version) => ({ itemVersionId: version.id, title: version.title,
        quality: version.quality, evidenceSnippet: evidenceSnippets(version)[0]
          ?? [...articleText(version).normalize('NFKC').replace(/\s+/g, ' ').trim()].slice(0, 240).join(''),
        evidenceSnippets: evidenceSnippets(version) })) };
  });
  const editedCards: z.infer<typeof editOutput>['cards'] = [];
  for (let offset = 0; offset < drafts.length; offset += 10) {
    if ((callsByStage.get('edit') ?? 0) >= input.maxAttemptsPerStage) break;
    const batch = drafts.slice(offset, offset + 10);
    try {
      const edited = editOutput.parse((await callWithRepair({ complete: completeWithinLimit, stage: 'edit',
        digestId: input.digestId, generation: input.generation, deadlineAt: input.deadlineAt,
        maxOutputTokens: input.maxOutputTokens, promptVersion: input.promptVersion, payload: {
          events: batch,
          targetChineseChars: { min: input.targetMinChars ?? 600, max: input.targetMaxChars ?? 1200 },
        },
        batchIndex: offset / 10, maxRepairAttempts: input.maxRepairAttempts })).value);
      assertExactIds(edited.cards.map((card) => card.eventKey), batch.map((draft) => draft.eventKey), 'EDIT_IDS_INVALID');
      editedCards.push(...edited.cards);
    } catch (error) {
      if (editedCards.length === 0) throw error;
      break; // A failed reserve batch must not discard already produced cards.
    }
  }
  const edits = new Map<string, { title: string; summary: string; whyItMatters: string; suggestedAction: string | null; facts: Fact[] }>();
  const acceptCards = (cards: z.infer<typeof editOutput>['cards']) => { for (const card of cards) {
    if (edits.has(card.eventKey)) continue;
    const group = selectedGroups.find((candidate) => candidate.eventKey === card.eventKey)!;
    const versions = group.versionIds.map((id) => input.versions.find((version) => version.id === id)!).filter(Boolean);
    const facts = card.facts.map(fact => {
      const evidence = fact.evidence.map(reference => {
        const version = versions.find(version => version.id === reference.itemVersionId);
        const original = version === undefined ? undefined : evidenceSnippets(version)
          .find(snippet => citationKey(snippet) === citationKey(reference.quote));
        return original === undefined ? reference : { ...reference, quote: original };
      });
      const matching = evidence.find(reference => citationKey(reference.quote) === citationKey(fact.text));
      return { text: matching?.quote ?? fact.text, evidence };
    });
    const source = versions.map((version) => `${version.title}\n${version.bodyText}`).join('\n');
    const text = [card.title, card.summary, card.whyItMatters, card.suggestedAction ?? '',
      ...facts.map((fact) => fact.text)].join('\n');
    if (!safeEditorialText(text) || !supportedNumbers(text, source)
      || facts.some((fact) => !validateEvidence(fact, versions)
        || !fact.evidence.some((evidence) => evidence.quote.normalize('NFKC').replace(/\s+/g, ' ').trim()
          === fact.text.normalize('NFKC').replace(/\s+/g, ' ').trim()))) continue;
    edits.set(card.eventKey, { ...card, facts });
  } };
  acceptCards(editedCards);
  const rejected = drafts.filter(draft => !edits.has(draft.eventKey)).slice(0, 10);
  if (rejected.length > 0 && input.maxRepairAttempts > 0
    && (callsByStage.get('edit') ?? 0) < input.maxAttemptsPerStage) {
    try {
      const corrected = editOutput.parse((await callStage(completeWithinLimit, 'edit', input.digestId, input.generation,
        input.deadlineAt, input.maxOutputTokens, input.promptVersion, {
          events: rejected,
          targetChineseChars: { min: input.targetMinChars ?? 600, max: input.targetMaxChars ?? 1200 },
          validationErrors: ['Previous cards failed literal quote, supported-number, or safe-text validation.'],
          instruction: 'Rewrite only these events. Copy a complete provided evidenceSnippet verbatim into both facts.text and evidence.quote. Keep numbers, units, and month names exactly as written in evidence; do not convert billion to 亿, million to 万, or October to 10. Remove unsupported numbers and facts instead of guessing. No URLs or HTML.',
        }, 2)).value);
      const rejectedKeys = new Set(rejected.map(draft => draft.eventKey));
      acceptCards(corrected.cards.filter(card => rejectedKeys.has(card.eventKey)));
    } catch { /* Keep already validated cards; uncorrected drafts remain unpublished. */ }
  }
  if (edits.size === 0) throw new Error('EDIT_EVIDENCE_INVALID');
  return { filterDecisions: filterResults, keptIds, scoresById, groups: selectedGroups.filter((group) => edits.has(group.eventKey)), edits };
}
