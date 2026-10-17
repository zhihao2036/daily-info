import { describe, expect, it, vi } from 'vitest';
import { createBrowserFallback, type BrowserBinding } from '../../src/collectors/browser-fallback';
import type { BrowserFallbackState, BrowserReservation } from '../../src/db/repositories/browser-fallback';
import type { Lease, SourceConfig } from '../../src/domain/contracts';

const now = Date.parse('2026-09-21T00:00:00Z');
const source: SourceConfig = {
  id: 'html-fixture', name: 'Fixture', kind: 'html_list', url: 'https://example.com/blog', enabled: true,
  core: false, priority: 80, authority: 'official', allowedHosts: ['example.com'], intervalHours: 1,
  verification: 'worker_verified', browserFallbackEnabled: true,
  html: { listLinkSelector: 'main a', articleSelector: 'main article' },
};
const lease: Lease = { sourceId: source.id, ownerId: 'owner', fencingToken: 1, expiresAt: now + 60_000 };

function reservation(): BrowserReservation {
  return { id: 'reservation', dateUtc: '2026-09-21', sourceId: source.id, runId: 'run-a', reservedMs: 60_000, reservedPages: 1 };
}

function repository(overrides: Partial<{
  reserve: () => Promise<BrowserReservation | null>;
  settle: (input: { actualMs?: number | null; outcome: string; errorCode?: string | null }) => Promise<void>;
  state: () => Promise<BrowserFallbackState>;
  cooldown: () => Promise<void>;
}> = {}) {
  return {
    reserve: vi.fn(overrides.reserve ?? (async () => reservation())),
    settle: vi.fn(overrides.settle ?? (async () => undefined)),
    state: vi.fn(overrides.state ?? (async () => ({ cooldownUntil: null, usage: null, lastErrorCode: null, fallbackCount: 0 }))),
    cooldown: vi.fn(overrides.cooldown ?? (async () => undefined)),
  };
}

describe('Browser Run fallback adapter', () => {
  it('uses content only after an allowed URL receives a reservation and settles the usage header', async () => {
    const binding: BrowserBinding = { quickAction: vi.fn(async () => new Response('<main>rendered</main>', {
      headers: { 'X-Browser-Ms-Used': '1234' },
    })) };
    const repo = repository();
    const fallback = createBrowserFallback({ binding, repository: repo, now: () => now });

    await expect(fallback.render({ source, runId: 'run-a', lease, url: 'https://example.com/post', deadlineAt: now + 10_000 }))
      .resolves.toEqual({ kind: 'rendered', html: '<main>rendered</main>', browserMs: 1234 });
    expect(binding.quickAction).toHaveBeenCalledWith('content', { url: 'https://example.com/post',
      gotoOptions: { timeout: 10_000, waitUntil: 'networkidle2' }, rejectResourceTypes: ['image', 'media', 'font'] });
    expect(repo.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'succeeded', actualMs: 1234 }));
  });

  it('unwraps the Cloudflare JSON response and accepts a public article with a login navigation link', async () => {
    const html = '<nav><a href="/login">Sign in</a></nav><main>Public model announcement</main>';
    const binding: BrowserBinding = { quickAction: vi.fn(async () => Response.json({ success: true, result: html }, {
      headers: { 'X-Browser-Ms-Used': '1199.548095703125' },
    })) };
    const repo = repository();
    const fallback = createBrowserFallback({ binding, repository: repo, now: () => now });
    await expect(fallback.render({ source, runId: 'run-a', lease, url: source.url, deadlineAt: now + 10_000 }))
      .resolves.toEqual({ kind: 'rendered', html, browserMs: 1200 });
  });

  it('rejects an unsuccessful JSON envelope even when the HTTP status is 200', async () => {
    const binding: BrowserBinding = { quickAction: vi.fn(async () => Response.json({ success: false, errors: [] }, {
      headers: { 'X-Browser-Ms-Used': '1200' },
    })) };
    const repo = repository();
    const fallback = createBrowserFallback({ binding, repository: repo, now: () => now });
    await expect(fallback.render({ source, runId: 'run-a', lease, url: source.url, deadlineAt: now + 10_000 }))
      .resolves.toMatchObject({ kind: 'skipped', reason: 'render_failed' });
    expect(repo.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'uncertain' }));
  });

  it('blocks target HTTP errors reported inside a successful Quick Action envelope', async () => {
    const binding: BrowserBinding = { quickAction: vi.fn(async () => Response.json({ success: true,
      result: '<main>Access denied</main>', meta: { status: 403 } }, { headers: { 'X-Browser-Ms-Used': '12.1' } })) };
    const repo = repository();
    const fallback = createBrowserFallback({ binding, repository: repo, now: () => now });
    await expect(fallback.render({ source, runId: 'run-a', lease, url: source.url, deadlineAt: now + 10_000 }))
      .resolves.toMatchObject({ kind: 'skipped', reason: 'blocked' });
    expect(repo.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'blocked', actualMs: 13 }));
  });

  it('does not call the binding when disabled, expired, cooled down, quota-limited, or off-host', async () => {
    const binding: BrowserBinding = { quickAction: vi.fn() };
    const cases = [
      { source: { ...source, browserFallbackEnabled: false }, repository: repository(), deadlineAt: now + 10_000 },
      { source, repository: repository(), deadlineAt: now },
      { source, repository: repository({ state: async () => ({ cooldownUntil: now + 1, usage: null, lastErrorCode: null, fallbackCount: 0 }) }), deadlineAt: now + 10_000 },
      { source, repository: repository({ reserve: async () => null }), deadlineAt: now + 10_000 },
      { source, repository: repository(), deadlineAt: now + 10_000, url: 'https://outside.example/post' },
    ];
    for (const item of cases) {
      const fallback = createBrowserFallback({ binding, repository: item.repository, now: () => now });
      await expect(fallback.render({ source: item.source, runId: 'run-a', lease, url: item.url ?? 'https://example.com/post', deadlineAt: item.deadlineAt }))
        .resolves.toMatchObject({ kind: 'skipped' });
    }
    expect(binding.quickAction).not.toHaveBeenCalled();
  });

  it('marks access-control HTML as blocked without retrying the browser call', async () => {
    const binding: BrowserBinding = { quickAction: vi.fn(async () => new Response('<main>Verify you are human</main>', {
      status: 200, headers: { 'X-Browser-Ms-Used': '12' },
    })) };
    const repo = repository();
    const fallback = createBrowserFallback({ binding, repository: repo, now: () => now });

    await expect(fallback.render({ source, runId: 'run-a', lease, url: 'https://example.com/post', deadlineAt: now + 10_000 }))
      .resolves.toEqual({ kind: 'skipped', reason: 'blocked' });
    expect(binding.quickAction).toHaveBeenCalledTimes(1);
    expect(repo.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'blocked' }));
  });

  it('fails closed when the Quick Action returns after the collection deadline', async () => {
    let current = now;
    const binding: BrowserBinding = { quickAction: vi.fn(async () => {
      current += 10_001;
      return new Response('<main>late</main>', { headers: { 'X-Browser-Ms-Used': '12' } });
    }) };
    const repo = repository();
    const fallback = createBrowserFallback({ binding, repository: repo, now: () => current });

    await expect(fallback.render({ source, runId: 'run-a', lease, url: 'https://example.com/post', deadlineAt: now + 10_000 }))
      .resolves.toEqual({ kind: 'skipped', reason: 'deadline' });
    expect(repo.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', now: current }));
  });

  it('starts cooldown from an access-control status before reading an oversized response body', async () => {
    const binding: BrowserBinding = { quickAction: vi.fn(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), {
      status: 403, headers: { 'X-Browser-Ms-Used': '12' },
    })) };
    const repo = repository();
    const fallback = createBrowserFallback({ binding, repository: repo, now: () => now });

    await expect(fallback.render({ source, runId: 'run-a', lease, url: 'https://example.com/post', deadlineAt: now + 10_000 }))
      .resolves.toEqual({ kind: 'skipped', reason: 'blocked' });
    expect(repo.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'blocked' }));
  });
});
