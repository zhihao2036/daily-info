import { describe, expect, it, vi } from 'vitest';
import { createCollector } from '../../src/collectors';
import type { SourceConfig } from '../../src/domain/contracts';

const source: SourceConfig = { id:'official-log',name:'Official Releases',kind:'html_list',url:'https://example.com/releases',
  enabled:true,core:false,priority:90,allowedHosts:['example.com'],intervalHours:6,authority:'official',
  verification:'worker_verified',browserFallbackEnabled:false,
  html:{listLinkSelector:'a',articleSelector:'main',changelog:{entrySelector:'.entry',titleSelector:'h3',dateSelector:'.date',yearSelector:'main h2'}} };
const entry = (date: string, id: string, title: string, body = 'Supports agent tools.') =>
  `<div class="entry"><div class="date">${date}<span aria-hidden="true">decoration</span></div><div><h3 id="${id}">${title}</h3><p>${body}</p></div></div>`;
const metadata = (date = '2026-10-13') => `<script type="application/ld+json">${JSON.stringify({ '@type':'TechArticle',datePublished:date,dateModified:'2027-01-01' })}</script>`;
async function collect(html: string, pageSize = 10, maxBodyBytes = 131072) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(html,{headers:{'content-type':'text/html'}}));
  const page = await createCollector('html_list',{fetcher}).fetchPage({source,cursor:null,
    deadlineAt:Date.now()+10000,signal:new AbortController().signal,bodyBudget:0,pageSize,maxBodyBytes});
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(page.bodyFetches).toBe(0);
  return page;
}

describe('official release timeline collection', () => {
  it('separates same-day updates, preserves model code, and respects explicitly older year sections', async () => {
    const page = await collect(`${metadata()}<main><h2>October</h2>
      ${entry('October 14','model','Model release','<span class="not-prose"><code>model-4.0</code></span> supports tool use.<script>untrusted()</script>')}
      ${entry('October 14','api','API change')}
      <h2>October 2025</h2>${entry('October 5','old','Older update')}</main>`);
    expect(page.items.map(item=>item.publishedAt)).toEqual([
      Date.parse('2026-10-14T00:00:00Z'),Date.parse('2026-10-14T00:00:00Z'),Date.parse('2025-10-05T00:00:00Z'),
    ]);
    expect(page.items.map(item=>item.canonicalUrl)).toEqual([
      'https://example.com/releases#model','https://example.com/releases#api','https://example.com/releases#old',
    ]);
    expect(page.items[0]?.body).toContain('model-4.0');
    expect(page.items[0]?.body).not.toMatch(/untrusted|decoration/);
    expect(page.items[0]?.title).toBe('Official Releases: Model release');
    expect(new Set(page.items.map(item=>item.externalKey)).size).toBe(3);
  });

  it('leaves implicit years unknown without publication metadata and rejects invalid dates', async () => {
    const page = await collect(`<script type="application/ld+json">{"@type":"TechArticle","dateModified":"2026-10-13"}</script><main>
      ${entry('October 14','unknown','Unknown year')}${entry('October 14, 2026','explicit','Explicit year')}
      ${entry('February 31, 2026','invalid','Invalid date')}</main>`);
    expect(page.items.map(item=>item.publishedAt)).toEqual([null,Date.parse('2026-10-14T00:00:00Z'),null]);
  });

  it('supports Article metadata inside a JSON-LD graph without leaking metadata into the body', async () => {
    const page = await collect(`<script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":"Article","datePublished":"2026-10-13"}]}</script>
      <main>${entry('October 14','one','Update')}</main>`);
    expect(page.items[0]?.publishedAt).toBe(Date.parse('2026-10-14T00:00:00Z'));
    expect(page.items[0]?.body).not.toContain('datePublished');
  });

  it('bounds item and Unicode body sizes and marks truncated evidence partial', async () => {
    const page = await collect(`${metadata()}<main>${entry('October 14','one','First','内容🙂'.repeat(100))}
      ${entry('October 13','two','Second')}</main>`,1,60);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.quality).toBe('partial');
    expect(new TextEncoder().encode(page.items[0]!.body).length).toBeLessThanOrEqual(60);
    expect(page.items[0]?.body).not.toContain('\uFFFD');
  });
});
