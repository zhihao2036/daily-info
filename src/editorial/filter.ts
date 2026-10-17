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
  const ranked = [...cards]
    .filter((card) => card.score >= threshold)
    .sort((left, right) => right.score - left.score
      || right.scores.evidence - left.scores.evidence
      || right.scores.novelty - left.scores.novelty
      || left.eventId.localeCompare(right.eventId));
  const selected: EventCard[] = [];
  const organizations = new Map<string, number>();
  const sources = new Map<string, number>();
  for (const card of ranked) {
    const organization = card.organization.normalize('NFKC').toLowerCase();
    if ((organizations.get(organization) ?? 0) >= 2) continue;
    const cardSources = new Set(card.sourceVersionIds.map((id) => sourceByVersion?.get(id)).filter((id): id is string => id !== undefined));
    if ([...cardSources].some((source) => (sources.get(source) ?? 0) >= 2)) continue;
    selected.push(card);
    organizations.set(organization, (organizations.get(organization) ?? 0) + 1);
    for (const source of cardSources) sources.set(source, (sources.get(source) ?? 0) + 1);
    if (selected.length >= Math.max(0, Math.min(10, limit))) break;
  }
  return selected;
}
