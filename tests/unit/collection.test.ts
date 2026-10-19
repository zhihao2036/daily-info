import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { boundedFetch } from '../../src/collectors/http';
import { canonicalizeUrl } from '../../src/collectors/normalize';
import { createCollector } from '../../src/collectors';
import { resumeCursor } from '../../src/collectors/cursor';
import { normalizeFeed } from '../../src/collectors/rss';
import type { SourceConfig } from '../../src/domain/contracts';

const rssSource: SourceConfig = {
  id: 'fixture-rss', name: 'Fixture RSS', kind: 'rss', url: 'https://example.com/feed.xml',
  enabled: true, core: true, priority: 100, authority: 'official', allowedHosts: ['example.com'],
  intervalHours: 1, verification: 'worker_verified', browserFallbackEnabled: false,
};

describe('URL normalization and bounded HTTP', () => {
  it('removes tracking while preserving and sorting release identity parameters', () => {
    expect(canonicalizeUrl('https://EXAMPLE.com/post?z=2&version=2&utm_source=x&a=3#top', ['example.com']))
      .toBe('https://example.com/post?a=3&version=2&z=2');
    expect(() => canonicalizeUrl('https://attacker.test/post', ['example.com'])).toThrow('URL_HOST_NOT_ALLOWED');
    expect(() => canonicalizeUrl('http://example.com/post', ['example.com'])).toThrow('URL_HTTPS_REQUIRED');
    expect(() => canonicalizeUrl('https://user:pass@example.com/post', ['example.com'])).toThrow('URL_CREDENTIALS_FORBIDDEN');
    expect(() => canonicalizeUrl('https://127.0.0.1/post', ['127.0.0.1'])).toThrow('URL_IP_FORBIDDEN');
  });

  it('validates every redirect host before following it', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://attacker.test/payload' } }));
    await expect(boundedFetch('https://example.com/start', ['example.com'], { fetcher })).rejects.toThrow('URL_HOST_NOT_ALLOWED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels a decoded response as soon as it exceeds two MiB', async () => {
    const chunk = new Uint8Array(1_100_000);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls === 3) controller.close();
      },
    });
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    await expect(boundedFetch('https://example.com/big', ['example.com'], { fetcher })).rejects.toThrow('RESPONSE_TOO_LARGE');
    expect(pulls).toBeLessThanOrEqual(3);
  });
});

describe('feed collectors', () => {
  it('upgrades legacy HTTP feed links only with opt-in and still rejects other hosts', () => {
    const xml = '<rss><channel><item><title>Legacy</title><link>http://example.com/post</link></item><item><title>Other host</title><link>http://attacker.test/post</link></item></channel></rss>';
    expect(normalizeFeed(xml, rssSource)).toHaveLength(0);
    const items = normalizeFeed(xml, { ...rssSource, upgradeHttpLinks: true });
    expect(items).toHaveLength(1);
    expect(items[0]?.canonicalUrl).toBe('https://example.com/post');
  });

  it('cleans escaped Atom HTML without inventing a publication date from updated', () => {
    const xml = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>one</id><title>Release</title><link href="https://example.com/release"/><updated>2026-10-17T00:00:00Z</updated><content type="html">&lt;p&gt;Fixed &lt;b&gt;streaming&lt;/b&gt;.&lt;/p&gt;&lt;script&gt;bad()&lt;/script&gt;</content></entry></feed>';
    const item = normalizeFeed(xml, rssSource)[0]!;
    expect(item.body).toBe('Fixed streaming .');
    expect(item.publishedAt).toBeNull();
    expect(item.sourceUpdatedAt).toBe(Date.parse('2026-10-17T00:00:00Z'));
  });

  it('resumes an interrupted scan before falling back to the high-water cursor', () => {
    expect(resumeCursor({ highWater: { page: 1 }, resume: { page: 3 }, scanStartedAt: 42 })).toEqual({ page: 3 });
    expect(resumeCursor({ highWater: { page: 2 }, resume: null, scanStartedAt: null })).toEqual({ page: 2 });
    expect(resumeCursor(null)).toBeNull();
  });

  it('normalizes the synthetic RSS fixture without inventing missing dates', () => {
    const xml = readFileSync(new URL('../../fixtures/synthetic-feed.xml', import.meta.url), 'utf8');
    const items = normalizeFeed(xml, rssSource);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      externalKey: 'widget-2-release',
      canonicalUrl: 'https://example.com/releases/widget-2',
      quality: 'partial',
    });
    expect(items[2]?.publishedAt).toBeNull();
  });

  it('honors lower configured page and body limits', () => {
    const xml = readFileSync(new URL('../../fixtures/synthetic-feed.xml', import.meta.url), 'utf8');
    const items = normalizeFeed(xml, rssSource, { pageSize: 1, maxBodyBytes: 16 });
    expect(items).toHaveLength(1);
    expect(new TextEncoder().encode(items[0]!.body).byteLength).toBeLessThanOrEqual(16);
    expect(items[0]!.quality).toBe('partial');
  });

  it('uses the configured fetch timeout instead of the hard-coded maximum', async () => {
    vi.useFakeTimers();
    const outer = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetcher = vi.fn((_request: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined;
      requestSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const pending = createCollector('rss', { fetcher }).fetchPage({
      source: rssSource, cursor: null, deadlineAt: Date.now() + 60_000, signal: outer.signal,
      fetchTimeoutMs: 5, maxResponseBytes: 1024, maxBodyBytes: 1024, pageSize: 1,
    });
    const rejection = expect(pending).rejects.toThrow('HTTP_TIMEOUT');
    await vi.advanceTimersByTimeAsync(6);
    expect(requestSignal?.aborted).toBe(true);
    await rejection;
    vi.useRealTimers();
  });

  it('accepts Atom entries and uses their stable id', () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <title>Fixture</title><entry><id>tag:example.com,2026:one</id><title>Atom update</title>
      <link href="https://example.com/atom/one"/><content>Complete body</content></entry></feed>`;
    const items = normalizeFeed(xml, rssSource);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ externalKey: 'tag:example.com,2026:one', publishedAt: null, quality: 'full' });
  });

  it('truncates oversized feed bodies at a Unicode boundary and marks them partial', () => {
    const xml = `<rss version="2.0"><channel><item><guid>large</guid><title>Large</title>
      <link>https://example.com/large</link><content:encoded><![CDATA[${'内容🙂'.repeat(50_000)}]]></content:encoded>
    </item></channel></rss>`;
    const item = normalizeFeed(xml, rssSource)[0]!;
    expect(item.quality).toBe('partial');
    expect(new TextEncoder().encode(item.body).byteLength).toBeLessThanOrEqual(128 * 1024);
    expect(item.body.endsWith('\uFFFD')).toBe(false);
  });

  it('rejects DTD/entity input, malformed XML, and HTML masquerading as a feed', () => {
    expect(() => normalizeFeed('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss>&x;</rss>', rssSource)).toThrow('XML_DTD_FORBIDDEN');
    expect(() => normalizeFeed('<rss><channel><item></rss>', rssSource)).toThrow('XML_INVALID');
    expect(() => normalizeFeed('<html><body>not a feed</body></html>', rssSource)).toThrow('FEED_STRUCTURE_INVALID');
  });

  it('counts actual XML markup without treating CDATA HTML and comments as feed nodes', () => {
    const html = '<section>'.repeat(80) + '<p>Official announcement</p>'.repeat(10_100) + '</section>'.repeat(80);
    const xml = `<rss><channel><!-- ${'<nested>'.repeat(70)} --><item><guid>official</guid>
      <title>Release</title><link>https://example.com/release</link>
      <content:encoded><![CDATA[${html}]]></content:encoded></item></channel></rss>`;
    expect(normalizeFeed(xml, rssSource)[0]).toMatchObject({ title: 'Release', quality: 'partial' });
    expect(normalizeFeed(xml, rssSource)[0]?.body).toContain('Official announcement');
  });

  it('retains real node, nesting, and malformed CDATA limits', () => {
    expect(() => normalizeFeed(`<rss><channel>${'<item/>'.repeat(20_000)}</channel></rss>`, rssSource))
      .toThrow('XML_NODE_LIMIT');
    expect(() => normalizeFeed('<rss>' + '<nested>'.repeat(64) + '</nested>'.repeat(64) + '</rss>', rssSource))
      .toThrow('XML_DEPTH_LIMIT');
    expect(() => normalizeFeed('<rss><channel><![CDATA[unterminated</channel></rss>', rssSource)).toThrow('XML_INVALID');
    expect(() => normalizeFeed('<rss><channel><!-- unterminated</channel></rss>', rssSource)).toThrow('XML_INVALID');
  });

  it('lists GitHub releases, filters drafts/prereleases, and preserves next-page state', async () => {
    const github: SourceConfig = {
      ...rssSource,
      id: 'github-fixture', kind: 'github_releases', url: 'https://api.github.com/repos/acme/widget/releases',
      allowedHosts: ['api.github.com', 'github.com'],
      github: { owner: 'acme', repo: 'widget', includePrerelease: false },
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      { id: 1, name: 'Widget 2', tag_name: 'v2.0.0', body: 'Release notes', draft: false, prerelease: false,
        html_url: 'https://github.com/acme/widget/releases/tag/v2.0.0', published_at: '2026-09-20T18:00:00Z' },
      { id: 2, name: 'Draft', tag_name: 'draft', body: '', draft: true, prerelease: false,
        html_url: 'https://github.com/acme/widget/releases/tag/draft' },
      { id: 3, name: 'RC', tag_name: 'v3-rc', body: '', draft: false, prerelease: true,
        html_url: 'https://github.com/acme/widget/releases/tag/v3-rc' },
    ]), { headers: { 'content-type': 'application/json', link: '<https://api.github.com/repositories/1/releases?page=2>; rel="next"' } }));
    const page = await createCollector('github_releases', { fetcher }).fetchPage({
      source: github, cursor: { page: 1 }, deadlineAt: Date.now() + 10_000, signal: new AbortController().signal,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ externalKey: 'github-release:1', quality: 'full',
      title: `${github.name}: Widget 2`, publishedAt: Date.parse('2026-09-20T18:00:00Z') });
    expect(page.nextCursor).toEqual({ page: 2 });
    expect(page.complete).toBe(false);
  });
});
