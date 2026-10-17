import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { createCollector } from '../../src/collectors';
import { D1Persistence } from '../../src/db/repositories';
import { extractHtml } from '../../src/extractors/html';
import type { Lease, SourceConfig } from '../../src/domain/contracts';

const source: SourceConfig = {
  id: 'html-fixture', name: 'HTML Fixture', kind: 'html_list', url: 'https://example.com/blog',
  enabled: true, core: false, priority: 80, authority: 'official', allowedHosts: ['example.com'],
  intervalHours: 1, verification: 'worker_verified', browserFallbackEnabled: false,
  html: { listLinkSelector: 'main a[href]', articleSelector: 'main article', dateSelector: 'time' },
};

describe('HTMLRewriter extraction', () => {
  it('uses a configured RSS article container and removes page metadata and widgets', async () => {
    const rss: SourceConfig = { ...source, kind: 'rss', html: { listLinkSelector: 'a', articleSelector: '.blog-content' } };
    const fetcher = vi.fn(async (request: RequestInfo | URL) => new Response(String(request) === source.url
      ? '<rss><channel><item><title>Release</title><link>https://example.com/release</link></item></channel></rss>'
      : '<main><h1>Release</h1>Upvote 99 Alice Follow<div class="blog-content"><p>Actual model capabilities.</p><div class="not-prose">Share widget</div><iframe>Embed markup</iframe></div><p>Comments</p></main>',
      { headers: { 'content-type': String(request) === source.url ? 'application/rss+xml' : 'text/html' } }));
    const page = await createCollector('rss', { fetcher }).fetchPage({ source: rss, cursor: null,
      deadlineAt: Date.now() + 10_000, signal: new AbortController().signal });
    expect(page.items[0]).toMatchObject({ body: 'Actual model capabilities.', quality: 'full' });
  });
  it('uses article headings and publication metadata instead of generic announcement links', async () => {
    const fetcher = vi.fn(async (request: RequestInfo | URL) => new Response(String(request) === source.url
      ? '<main><a href="/release">this documentation</a></main>'
      : '<meta property="article:published_time" content="2026-10-15T09:00:00Z"><main><article><h1>Model Release</h1><p>Official details.</p></article></main>',
    { headers: { 'content-type': 'text/html' } }));
    const page = await createCollector('html_list', { fetcher }).fetchPage({ source, cursor: null,
      deadlineAt: Date.now() + 10_000, signal: new AbortController().signal });
    expect(page.items[0]).toMatchObject({ title: 'Model Release', publishedAt: Date.parse('2026-10-15T09:00:00Z'), quality: 'full' });
  });

  it('preserves archive label dates so historical announcements do not become fresh publications', async () => {
    const fetcher = vi.fn(async (request: RequestInfo | URL) => new Response(String(request) === source.url
      ? '<main><a href="/old">Release 2026/09/10</a><a href="/invalid">Release 2026/02/31</a></main>'
      : '<main><article><h1>Model release</h1><p>Details.</p></article></main>', { headers: { 'content-type': 'text/html' } }));
    const page = await createCollector('html_list', { fetcher }).fetchPage({ source, cursor: null,
      deadlineAt: Date.now() + 10_000, signal: new AbortController().signal });
    expect(page.items[0]?.publishedAt).toBe(Date.parse('2026-09-10T00:00:00Z'));
    expect(page.items[1]?.publishedAt).toBeNull();
  });
  it('consumes the transformed body, removes unsafe chrome, and preserves readable blocks', async () => {
    const response = new Response(`<!doctype html><main><nav>skip</nav><article>
      <h1>Agent release</h1><p>First paragraph.</p><script>steal()</script><ul><li>One</li><li>Two</li></ul>
    </article></main>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const result = await extractHtml(response, source);
    expect(result.quality).toBe('full');
    expect(result.text).toContain('Agent release');
    expect(result.text).toContain('First paragraph.');
    expect(result.text).not.toContain('steal');
    expect(result.text).not.toContain('skip');
  });

  it('marks oversized Unicode-safe text partial and empty selectors metadata-only', async () => {
    const huge = `内容🙂`.repeat(50_000);
    const partial = await extractHtml(new Response(`<main><article><p>${huge}</p></article></main>`, {
      headers: { 'content-type': 'text/html' },
    }), source);
    expect(partial.quality).toBe('partial');
    expect(new TextEncoder().encode(partial.text).byteLength).toBeLessThanOrEqual(128 * 1024);
    expect(partial.text.endsWith('\uFFFD')).toBe(false);
    const empty = await extractHtml(new Response('<main><p>Outside selector</p></main>', {
      headers: { 'content-type': 'text/html' },
    }), source);
    expect(empty).toEqual({ text: '', quality: 'metadata_only' });
  });

  it('discovers allowed links and degrades a failed article to metadata-only', async () => {
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === source.url) {
        return new Response('<main><a href="/blog/one">Article One</a><a href="https://attacker.test/two">Bad</a></main>', {
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url === 'https://example.com/blog/one') throw new Error('fixture network failure');
      throw new Error(`unexpected ${url}`);
    });
    const page = await createCollector('html_list', { fetcher }).fetchPage({
      source, cursor: null, deadlineAt: Date.now() + 10_000, signal: new AbortController().signal,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      externalKey: 'https://example.com/blog/one',
      canonicalUrl: 'https://example.com/blog/one',
      title: 'Article One',
      quality: 'metadata_only',
    });
  });

  it('uses one rendered fallback only after an ordinary article is a JavaScript shell', async () => {
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === source.url) return new Response('<main><a href="/blog/one">Article One</a></main>', {
        headers: { 'content-type': 'text/html' },
      });
      return new Response('<main><p>Shell</p></main>', { headers: { 'content-type': 'text/html' } });
    });
    const browserFallback = { render: vi.fn(async () => ({ kind: 'rendered' as const,
      html: '<main><article><p>Rendered article</p></article></main>', browserMs: 12 })) };
    const lease: Lease = { sourceId: source.id, ownerId: 'owner', fencingToken: 1, expiresAt: Date.now() + 60_000 };
    const page = await createCollector('html_list', { fetcher, browserFallback }).fetchPage({
      source: { ...source, browserFallbackEnabled: true }, cursor: null, deadlineAt: Date.now() + 10_000,
      signal: new AbortController().signal, runId: 'run-browser', lease,
    });
    expect(browserFallback.render).toHaveBeenCalledTimes(1);
    expect(page.items[0]).toMatchObject({ body: 'Rendered article', quality: 'full' });
  });

  it('renders an HTML list once when ordinary parsing finds no links', async () => {
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      if (String(request) === source.url) return new Response('<main></main>', { headers: { 'content-type': 'text/html' } });
      return new Response('<main><article>Ordinary article</article></main>', { headers: { 'content-type': 'text/html' } });
    });
    const browserFallback = { render: vi.fn(async () => ({ kind: 'rendered' as const,
      html: '<main><a href="/blog/rendered">Rendered link</a></main>', browserMs: 12 })) };
    const lease: Lease = { sourceId: source.id, ownerId: 'owner', fencingToken: 1, expiresAt: Date.now() + 60_000 };
    const page = await createCollector('html_list', { fetcher, browserFallback }).fetchPage({
      source: { ...source, browserFallbackEnabled: true }, cursor: null, deadlineAt: Date.now() + 10_000,
      signal: new AbortController().signal, runId: 'list-browser', lease,
    });
    expect(browserFallback.render).toHaveBeenCalledWith(expect.objectContaining({ url: source.url }));
    expect(page.items[0]).toMatchObject({ canonicalUrl: 'https://example.com/blog/rendered', quality: 'full' });
  });

  it('puts a source into browser cooldown after an ordinary 403 without calling Browser Run', async () => {
    const fetcher = vi.fn(async () => new Response('blocked', { status: 403 }));
    const browserFallback = { render: vi.fn(), block: vi.fn(async () => undefined) };
    const lease: Lease = { sourceId: source.id, ownerId: 'owner', fencingToken: 1, expiresAt: Date.now() + 60_000 };
    await expect(createCollector('html_list', { fetcher, browserFallback }).fetchPage({
      source: { ...source, browserFallbackEnabled: true }, cursor: null, deadlineAt: Date.now() + 10_000,
      signal: new AbortController().signal, runId: 'blocked-list', lease,
    })).rejects.toThrow('HTTP_STATUS:403');
    expect(browserFallback.render).not.toHaveBeenCalled();
    expect(browserFallback.block).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('uses one rendered fallback for an RSS article that remains metadata-only after normal fetch', async () => {
    const { html: _html, ...rssBase } = source;
    const rss: SourceConfig = { ...rssBase, id: 'rss-fixture', kind: 'rss', url: 'https://example.com/feed.xml',
      browserFallbackEnabled: true };
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      if (String(request) === rss.url) return new Response(`<?xml version="1.0"?><rss><channel><item>
        <guid>one</guid><title>One</title><link>https://example.com/one</link></item></channel></rss>`, {
        headers: { 'content-type': 'application/rss+xml' },
      });
      return new Response('<main></main>', { headers: { 'content-type': 'text/html' } });
    });
    const browserFallback = { render: vi.fn(async () => ({ kind: 'rendered' as const,
      html: '<main><article>Rendered RSS article</article></main>', browserMs: 12 })) };
    const lease: Lease = { sourceId: rss.id, ownerId: 'owner', fencingToken: 1, expiresAt: Date.now() + 60_000 };
    const page = await createCollector('rss', { fetcher, browserFallback }).fetchPage({
      source: rss, cursor: null, deadlineAt: Date.now() + 10_000, signal: new AbortController().signal,
      runId: 'rss-browser', lease,
    });
    expect(browserFallback.render).toHaveBeenCalledTimes(1);
    expect(page.items[0]).toMatchObject({ body: 'Rendered RSS article', quality: 'full' });
  });

  it('checkpoints remaining discoveries after the twenty-body run budget', async () => {
    const links = Array.from({ length: 21 }, (_, index) => `<a href="/blog/${index}">Article ${index}</a>`).join('');
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === source.url) return new Response(`<main>${links}</main>`, { headers: { 'content-type': 'text/html' } });
      return new Response(`<main><article><p>Body for ${url}</p></article></main>`, { headers: { 'content-type': 'text/html' } });
    });
    const page = await createCollector('html_list', { fetcher }).fetchPage({
      source, cursor: null, deadlineAt: Date.now() + 10_000, signal: new AbortController().signal,
    });
    expect(page.items).toHaveLength(20);
    expect(fetcher).toHaveBeenCalledTimes(21);
    expect(page.nextCursor).toEqual({ offset: 20 });
    expect(page.complete).toBe(false);
    const resumed = await createCollector('html_list', { fetcher }).fetchPage({
      source, cursor: page.nextCursor, deadlineAt: Date.now() + 10_000, signal: new AbortController().signal,
    });
    expect(resumed.items).toHaveLength(1);
    expect(resumed.items[0]?.quality).toBe('full');
    expect(resumed.complete).toBe(true);
  });

  it('retries recent metadata-only bodies after backoff but stops after three attempts', async () => {
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO sources (
      id,kind,name,url,config_json,enabled,is_core,config_hash,cursor_json,created_at,updated_at
    ) VALUES ('html-fixture','html_list','Fixture','https://example.com/blog','{}',1,0,'hash','{}',?1,?1)`).bind(now).run();
    await env.DB.prepare(`INSERT INTO runs (
      id,job_key,workflow_id,kind,state,source_id,generation,scheduled_at,deadline_at,params_json,created_at,updated_at
    ) VALUES ('run-retry','job-retry','wf-retry','collect','running','html-fixture',0,?1,?2,'{}',?1,?1)`).bind(now, now + 600_000).run();
    const repo = new D1Persistence(env.DB, { now: () => now });
    const lease = await repo.acquireLease('html-fixture', 'owner', now);
    const items = [
      { key: 'eligible', attempts: 1, retryAt: now - 1 },
      { key: 'exhausted', attempts: 3, retryAt: now - 1 },
      { key: 'backoff', attempts: 1, retryAt: now + 60_000 },
    ].map(({ key, attempts, retryAt }) => ({
      externalKey: key,
      canonicalUrl: `https://example.com/${key}`,
      title: key,
      publishedAt: null,
      sourceUpdatedAt: null,
      body: '',
      quality: 'metadata_only' as const,
      metadata: { extractionAttempts: attempts, nextBodyRetryAt: retryAt },
    }));
    await repo.commitPage({ runId: 'run-retry', pageNo: 0, lease: lease!, items,
      requestCursor: null, expectedCursorVersion: 0, nextCursor: null, complete: true });
    expect(await repo.findBodyRetryCandidates('html-fixture', now)).toEqual([
      expect.objectContaining({ externalKey: 'eligible', attempts: 1 }),
    ]);
  });

  it('retries a due metadata-only article even after it disappears from the list page', async () => {
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === source.url) return new Response('<main></main>', { headers: { 'content-type': 'text/html' } });
      if (url === 'https://example.com/gone') {
        return new Response('<main><article>Recovered body</article></main>', { headers: { 'content-type': 'text/html' } });
      }
      throw new Error(`unexpected ${url}`);
    });
    const page = await createCollector('html_list', { fetcher }).fetchPage({
      source, cursor: null, deadlineAt: Date.now() + 10_000, signal: new AbortController().signal,
      bodyBudget: 1,
      bodyRetryCandidates: [{ itemId: 'item-gone', versionId: 'version-gone', externalKey: 'gone',
        canonicalUrl: 'https://example.com/gone', title: 'Gone article', publishedAt: null,
        sourceUpdatedAt: null, attempts: 1 }],
    });

    expect(page.items).toEqual([expect.objectContaining({ externalKey: 'gone', body: 'Recovered body', quality: 'full' })]);
    expect(page.bodyFetches).toBe(1);
  });
});
