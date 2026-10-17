import type { Fact, ItemVersion } from '../domain/contracts';

function normalized(value: string): string { return value.normalize('NFKC').replace(/\s+/g, ' ').trim(); }

export function validateEvidence(fact: Fact, versions: ItemVersion[]): boolean {
  if (fact.evidence.length === 0) return false;
  const byId = new Map(versions.map((version) => [version.id, version]));
  const evidenceText: string[] = [];
  for (const evidence of fact.evidence) {
    const quote = normalized(evidence.quote);
    const version = byId.get(evidence.itemVersionId);
    if (version === undefined || [...quote].length === 0 || [...quote].length > 240) return false;
    if (!normalized(version.bodyText).includes(quote)) return false;
    evidenceText.push(quote);
  }
  const claims = normalized(fact.text).match(/\d+(?:[.,]\d+)*(?:%|[a-z]+)?/gi) ?? [];
  const joined = evidenceText.join(' ');
  return claims.every((claim) => joined.includes(claim));
}
