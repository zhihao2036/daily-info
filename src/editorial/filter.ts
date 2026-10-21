import type { EventCard } from '../domain/contracts';

export function isPromotionalTitle(title: string): boolean {
  return /\b(?:hiring|recruitment|job opening|webinar registration|early booking|early[- ]bird tickets?|last chance to save)\b|招聘|报名|早鸟票/i.test(title);
}

export function scoreEvent(scores: EventCard['scores']): number {
  const values = Object.values(scores);
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 100)) throw new Error('SCORE_INVALID');
  return scores.relevance * 0.35
    + scores.impact * 0.25
    + scores.evidence * 0.20
    + scores.novelty * 0.15
    + scores.actionability * 0.05;
}

export function selectEvents(cards: EventCard[], threshold = 60, limit = 10, sourceByVersion?: ReadonlyMap<string, string>): EventCard[] {
  const boundedLimit = Math.max(0, Math.min(10, Math.trunc(limit)));
  if (boundedLimit === 0) return [];
  const ranked = [...cards]
    .filter((card) => card.score >= threshold)
    .sort((left, right) => right.score - left.score
      || right.scores.evidence - left.scores.evidence
      || right.scores.novelty - left.scores.novelty
      || left.eventId.localeCompare(right.eventId));
  const selected: EventCard[] = [];
  const organizations = new Map<string, number>();
  const sources = new Map<string, number>();
  while (ranked.length > 0 && selected.length < boundedLimit) {
    // Prefer varied reporting when scores are close, without dropping a third
    // important event just because the same outlet reported it.
    const sourceIds = (card: EventCard) => new Set(card.sourceVersionIds
      .map(id => sourceByVersion?.get(id)).filter((id): id is string => id !== undefined));
    const adjustedScore = (card: EventCard) => card.score
      - ([...sourceIds(card)].some(source => (sources.get(source) ?? 0) >= 2) ? 5 : 0);
    ranked.sort((left, right) => adjustedScore(right) - adjustedScore(left)
      || right.score - left.score || left.eventId.localeCompare(right.eventId));
    const card = ranked.shift()!;
    const organization = card.organization.normalize('NFKC').toLowerCase();
    if ((organizations.get(organization) ?? 0) >= 2) continue;
    const cardSources = new Set(card.sourceVersionIds.map((id) => sourceByVersion?.get(id)).filter((id): id is string => id !== undefined));
    selected.push(card);
    organizations.set(organization, (organizations.get(organization) ?? 0) + 1);
    for (const source of cardSources) sources.set(source, (sources.get(source) ?? 0) + 1);
  }
  return selected.sort((left, right) => right.score - left.score || left.eventId.localeCompare(right.eventId));
}
