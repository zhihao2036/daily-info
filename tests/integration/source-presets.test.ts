import { describe, expect, it } from 'vitest';
import { createCollector } from '../../src/collectors';
import { SOURCE_PRESETS } from '../../src/config/source-presets';

describe('official source presets', () => {
  it('discovers MiniMax research cards while ignoring navigation and reads visible publication dates', async () => {
    const source = SOURCE_PRESETS['minimax-blog']!;
    const fetcher: typeof fetch = async request => new Response(String(request) === source.url
      ? '<nav><a href="/blog/old">Old model</a></nav><a class="overflow-hidden" href="/blog/model">Model</a>'
      : '<article><h1>Model release</h1><time>2026-10-19</time><p>Supports tool calls.</p></article>',
      { headers: { 'content-type': 'text/html' } });
    const page = await createCollector('html_list', { fetcher }).fetchPage({ source, cursor: null,
      deadlineAt: Date.now() + 10000, signal: new AbortController().signal });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ canonicalUrl: 'https://www.minimax.io/blog/model', quality: 'full', publishedAt: Date.parse('2026-10-19') });
  });

  it('discovers each Cursor changelog once and excludes pagination and internal section links', async () => {
    const source = SOURCE_PRESETS['cursor-changelog']!;
    const fetcher: typeof fetch = async request => new Response(String(request) === source.url
      ? '<article><a href="/changelog/new">Oct 16</a><h1><a href="/changelog/new">Canvases</a></h1><a href="#api">API</a></article><a href="/changelog/page/2">Next</a>'
      : '<main><article><time datetime="2026-10-16T00:00:00Z"></time><h1>Canvases</h1><p>Agents can build interactive canvases.</p></article></main>',
      { headers: { 'content-type': 'text/html' } });
    const page = await createCollector('html_list', { fetcher }).fetchPage({ source, cursor: null,
      deadlineAt: Date.now() + 10000, signal: new AbortController().signal });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ canonicalUrl: 'https://cursor.com/changelog/new', quality: 'full', publishedAt: Date.parse('2026-10-16') });
  });
});
