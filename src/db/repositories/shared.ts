import type { Clock, Json } from '../../domain/contracts';

export const systemClock: Clock = { now: () => Date.now() };

export function json(value: Json): string {
  return JSON.stringify(value);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /constraint|unique/i.test(message);
}
