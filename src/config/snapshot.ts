import type { AppConfig, SourceConfig } from '../domain/contracts';
import { validateConfig } from './load';
import { validateSourcesConfig } from './schema';

export interface DigestConfigSnapshot {
  app: AppConfig;
  sources: SourceConfig[];
  deliveryDestinationKey: string | null;
}

export function parseDigestConfigSnapshot(raw: string): DigestConfigSnapshot {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    || !('app' in parsed) || !('sources' in parsed) || !Array.isArray(parsed.sources)) {
    throw new Error('CONFIG_INVALID:DIGEST_SNAPSHOT');
  }
  return {
    app: validateConfig(parsed.app),
    sources: validateSourcesConfig({ schemaVersion: 1, sources: parsed.sources }).sources,
    deliveryDestinationKey: 'deliveryDestinationKey' in parsed
      && typeof parsed.deliveryDestinationKey === 'string'
      && /^[a-f0-9]{64}$/.test(parsed.deliveryDestinationKey)
      ? parsed.deliveryDestinationKey
      : null,
  };
}
