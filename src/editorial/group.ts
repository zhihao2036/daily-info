export interface EventIdentityInput {
  organization: string;
  product: string;
  productVersion: string;
  changeKind: string;
  versionId: string;
}

export interface EventIdentityGroup {
  eventKey: string;
  organization: string;
  product: string;
  productVersion: string;
  changeKind: string;
  versionIds: string[];
}

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/[^a-z0-9\p{L}]+/gu, '-').replace(/^-|-$/g, '');
}

export function eventIdentity(input: Omit<EventIdentityInput, 'versionId'>): string {
  return [input.organization, input.product, input.productVersion || 'unknown', input.changeKind]
    .map(normalize).join('-');
}

export async function groupByEventIdentity(inputs: EventIdentityInput[]): Promise<EventIdentityGroup[]> {
  const groups = new Map<string, EventIdentityGroup>();
  for (const input of inputs) {
    const eventKey = eventIdentity(input);
    const current = groups.get(eventKey);
    if (current === undefined) {
      groups.set(eventKey, { eventKey, organization: input.organization, product: input.product, productVersion: input.productVersion, changeKind: input.changeKind, versionIds: [input.versionId] });
    } else {
      current.versionIds.push(input.versionId);
    }
  }
  return [...groups.values()];
}

export function inferEventIdentity(title: string): Omit<EventIdentityInput, 'versionId'> {
  const clean = title.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, ' ').trim();
  const parts = clean.split(/\s+/);
  const version = clean.match(/\bv?\d+(?:\.\d+)+\b/i)?.[0]?.replace(/^v/i, '') ?? '';
  const lower = clean.toLowerCase();
  const changeKind = /benchmark|test|评测|测试/.test(lower) ? 'benchmark'
    : /security|漏洞|安全/.test(lower) ? 'security'
      : /deprecat|弃用/.test(lower) ? 'deprecation'
        : /releas|发布|available/.test(lower) ? 'release' : 'other';
  const discriminator = version === '' && changeKind === 'other'
    ? `topic-${normalize(parts.slice(2).join(' ') || clean)}`.slice(0, 96)
    : version;
  return {
    organization: parts[0] ?? 'Unknown',
    product: parts[1] ?? parts[0] ?? 'Unknown',
    productVersion: discriminator,
    changeKind,
  };
}
