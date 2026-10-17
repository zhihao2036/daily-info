import type { BrowserFallbackRepository, BrowserFallbackState, BrowserReservation } from '../db/repositories/browser-fallback';
import type { Lease, SourceConfig } from '../domain/contracts';
import { assertAllowedUrl } from './normalize';

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const ACCESS_MARKERS = /verify you are human|checking your browser|(?:sign|log) in to (?:continue|access|read)|<(?:title|h1)[^>]*>\s*(?:sign in|log in|login|just a moment|captcha)\b|class=["'][^"']*(?:g-recaptcha|cf-turnstile)/i;

export interface BrowserBinding {
  quickAction(action: 'content', input: { url: string;
    gotoOptions?: { timeout: number; waitUntil: 'networkidle2' };
    rejectResourceTypes?: Array<'image' | 'media' | 'font'> }): Promise<Response>;
}

export type BrowserFallbackResult =
  | { kind: 'rendered'; html: string; browserMs: number }
  | { kind: 'skipped'; reason: 'disabled' | 'cooldown' | 'quota' | 'blocked' | 'deadline' | 'lease_lost' | 'render_failed' };

export interface BrowserFallback {
  render(input: { source: SourceConfig; runId: string; lease: Lease; url: string; deadlineAt: number }): Promise<BrowserFallbackResult>;
  block?(input: { source: SourceConfig; lease: Lease; status: 401 | 403 | 429 }): Promise<void>;
}

type BrowserFallbackAccounting = Pick<BrowserFallbackRepository, 'reserve' | 'settle' | 'state' | 'cooldown'>;

async function hashUrl(url: string): Promise<string> {
  const bytes = new TextEncoder().encode(url);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readBoundedText(response: Response): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_HTML_BYTES) {
        await reader.cancel('BROWSER_RESPONSE_TOO_LARGE');
        throw new Error('BROWSER_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(output);
}

function browserMs(response: Response): number | null {
  const value = response.headers.get('X-Browser-Ms-Used');
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const parsed = Math.ceil(Number(value));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function activeCooldown(state: BrowserFallbackState, now: number): boolean {
  return state.cooldownUntil !== null && state.cooldownUntil > now;
}

export function createBrowserFallback(input: { binding?: BrowserBinding; repository: BrowserFallbackAccounting; now(): number }): BrowserFallback {
  return {
    async render(request): Promise<BrowserFallbackResult> {
      const now = input.now();
      if (!request.source.browserFallbackEnabled || request.source.kind === 'github_releases' || input.binding === undefined) {
        return { kind: 'skipped', reason: 'disabled' };
      }
      if (now >= request.deadlineAt) return { kind: 'skipped', reason: 'deadline' };
      try { assertAllowedUrl(request.url, request.source.allowedHosts); } catch { return { kind: 'skipped', reason: 'render_failed' }; }
      if (activeCooldown(await input.repository.state(request.source.id, now), now)) return { kind: 'skipped', reason: 'cooldown' };
      const reservation = await input.repository.reserve({
        sourceId: request.source.id, runId: request.runId, lease: request.lease, urlHash: await hashUrl(request.url), now,
      });
      if (reservation === null) return { kind: 'skipped', reason: 'quota' };
      return await callBinding(input.binding, input.repository, reservation, request, input.now);
    },
    async block(request): Promise<void> {
      if (!request.source.browserFallbackEnabled || request.source.kind === 'github_releases') return;
      await input.repository.cooldown(request.lease, `ORDINARY_HTTP_${request.status}`, input.now());
    },
  };
}

async function callBinding(binding: BrowserBinding, repository: BrowserFallbackAccounting, reservation: BrowserReservation,
  request: { source: SourceConfig; lease: Lease; url: string; deadlineAt: number }, now: () => number): Promise<BrowserFallbackResult> {
  try {
    if (now() >= request.deadlineAt) {
      await repository.settle({ reservation, lease: request.lease, outcome: 'failed', errorCode: 'BROWSER_DEADLINE', now: now() });
      return { kind: 'skipped', reason: 'deadline' };
    }
    const response = await binding.quickAction('content', { url: request.url,
      gotoOptions: { timeout: Math.max(1, Math.min(30_000, request.deadlineAt - now())), waitUntil: 'networkidle2' },
      rejectResourceTypes: ['image', 'media', 'font'],
    });
    const responseNow = now();
    const ms = browserMs(response);
    if ([401, 403, 429].includes(response.status)) {
      await repository.settle({ reservation, lease: request.lease, outcome: 'blocked', actualMs: ms, errorCode: 'BROWSER_BLOCKED', now: responseNow });
      return { kind: 'skipped', reason: 'blocked' };
    }
    const raw = await readBoundedText(response);
    // Quick Actions returns a JSON envelope; HTML is its result, not the envelope itself.
    let body = raw;
    if (response.headers.get('content-type')?.includes('application/json')) {
      const envelope: unknown = JSON.parse(raw);
      if (envelope === null || typeof envelope !== 'object' || !('success' in envelope)
        || envelope.success !== true || !('result' in envelope) || typeof envelope.result !== 'string') {
        throw new Error('BROWSER_RESPONSE_INVALID');
      }
      body = envelope.result;
      const meta = 'meta' in envelope ? envelope.meta : undefined;
      const status = meta !== null && typeof meta === 'object' && 'status' in meta ? meta.status : undefined;
      if (typeof status === 'number' && status >= 400) {
        const blocked = [401, 403, 429].includes(status);
        await repository.settle({ reservation, lease: request.lease, outcome: blocked ? 'blocked' : 'failed',
          actualMs: ms, errorCode: blocked ? 'BROWSER_BLOCKED' : 'BROWSER_RENDER_FAILED', now: now() });
        return { kind: 'skipped', reason: blocked ? 'blocked' : 'render_failed' };
      }
    }
    const settledNow = now();
    if (ACCESS_MARKERS.test(body)) {
      await repository.settle({ reservation, lease: request.lease, outcome: 'blocked', actualMs: ms, errorCode: 'BROWSER_BLOCKED', now: settledNow });
      return { kind: 'skipped', reason: 'blocked' };
    }
    if (!response.ok || ms === null || settledNow >= request.deadlineAt) {
      await repository.settle({ reservation, lease: request.lease, outcome: 'failed', actualMs: ms, errorCode: 'BROWSER_RENDER_FAILED', now: settledNow });
      return { kind: 'skipped', reason: settledNow >= request.deadlineAt ? 'deadline' : 'render_failed' };
    }
    await repository.settle({ reservation, lease: request.lease, outcome: 'succeeded', actualMs: ms, now: settledNow });
    return { kind: 'rendered', html: body, browserMs: ms };
  } catch {
    try { await repository.settle({ reservation, lease: request.lease, outcome: 'uncertain', errorCode: 'BROWSER_UNCERTAIN', now: now() }); } catch { /* A lost lease is fail-closed. */ }
    return { kind: 'skipped', reason: 'render_failed' };
  }
}
