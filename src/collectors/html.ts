import type { Collector, CollectionPage, Json, RawItem, SourceConfig } from '../domain/contracts';
import { extractHtml } from '../extractors/html';
import { boundedFetch, type FetchLike } from './http';
import { canonicalizeUrl, normalizeText } from './normalize';
import type { BrowserFallback } from './browser-fallback';
import { extractChangelog } from './changelog';

interface LinkRecord { href: string; text: string[] }

// Some official news archives put an explicit calendar date in each link label.
function labelDate(title: string): number | null {
  const parts = title.match(/\b(20\d{2})[/-](\d{2})[/-](\d{2})\b/);
  if (parts === null) return null;
  const iso = `${parts[1]}-${parts[2]}-${parts[3]}`;
  const value = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === iso ? value : null;
}

async function extractLinks(response: Response, source: SourceConfig, pageSize: number): Promise<Array<{ url: string; title: string; publishedAt: number | null }>> {
  if (source.html === undefined) throw new Error('SOURCE_CONFIG_INVALID');
  const records: LinkRecord[] = [];
  let active: LinkRecord | null = null;
  const transformed = new HTMLRewriter().on(source.html.listLinkSelector, {
    element(element) {
      const href = element.getAttribute('href');
      if (href === null) return;
      active = { href, text: [] };
      records.push(active);
      element.onEndTag(() => { active = null; });
    },
    text(text) { active?.text.push(text.text); },
  }).transform(response);
  await transformed.arrayBuffer();
  const seen = new Set<string>();
  const output: Array<{ url: string; title: string; publishedAt: number | null }> = [];
  for (const record of records) {
    let url: string;
    try { url = canonicalizeUrl(new URL(record.href, source.url).toString(), source.allowedHosts); } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    const title = normalizeText(record.text.join(' '));
    output.push({ url, title, publishedAt: labelDate(title) });
    if (output.length === pageSize) break;
  }
  return output;
}

export class HtmlListCollector implements Collector {
  constructor(private readonly fetcher: FetchLike = fetch, private readonly browserFallback?: BrowserFallback) {}

  async fetchPage(input: { source: SourceConfig; cursor: Json; deadlineAt: number; signal: AbortSignal;
    bodyBudget?: number; retryState?: Record<string, { attempts: number; nextBodyRetryAt: number | null }>;
    bodyRetryCandidates?: import('../domain/contracts').BodyRetryCandidate[];
    pageSize?: number; fetchTimeoutMs?: number; maxResponseBytes?: number; maxBodyBytes?: number;
    conditional?: { etag: string | null; lastModified: string | null };
    runId?: string; lease?: import('../domain/contracts').Lease;
    beforeRequest?(): Promise<void> }): Promise<CollectionPage> {
    await input.beforeRequest?.();
    let listResponse: Response;
    try {
      listResponse = await boundedFetch(input.source.url, input.source.allowedHosts, {
        fetcher: this.fetcher, signal: input.signal,
        timeoutMs: Math.max(1, Math.min(input.fetchTimeoutMs ?? 15_000, input.deadlineAt - Date.now())),
        maxBytes: input.maxResponseBytes ?? 2 * 1024 * 1024,
      });
    } catch (error) {
      const status = error instanceof Error ? error.message.match(/^HTTP_(?:STATUS|RETRYABLE):(401|403|429)$/)?.[1] : undefined;
      if (status !== undefined && this.browserFallback?.block !== undefined && input.runId !== undefined && input.lease !== undefined) {
        await this.browserFallback.block({ source: input.source, lease: input.lease, status: Number(status) as 401 | 403 | 429 });
      }
      throw error;
    }
    const pageSize = Math.max(1, Math.min(30, Math.trunc(input.pageSize ?? 30)));
    const maxBodyBytes = Math.max(1, Math.min(128 * 1024, Math.trunc(input.maxBodyBytes ?? 128 * 1024)));
    if (input.source.html?.changelog !== undefined) {
      return extractChangelog(listResponse, input.source, pageSize, maxBodyBytes);
    }
    let links = await extractLinks(listResponse, input.source, 30);
    if (links.length === 0 && this.browserFallback !== undefined && input.runId !== undefined && input.lease !== undefined) {
      const rendered = await this.browserFallback.render({ source: input.source, runId: input.runId, lease: input.lease,
        url: input.source.url, deadlineAt: input.deadlineAt });
      if (rendered.kind === 'rendered') links = await extractLinks(new Response(rendered.html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }), input.source, 30);
    }
    const cursor = input.cursor !== null && typeof input.cursor === 'object' && !Array.isArray(input.cursor)
      ? input.cursor as Record<string, Json> : {};
    const offset = typeof cursor.offset === 'number' && Number.isInteger(cursor.offset) && cursor.offset >= 0 ? cursor.offset : 0;
    const budget = Math.max(0, Math.min(20, Math.trunc(input.bodyBudget ?? 20)));
    if (budget === 0) return { items: [], nextCursor: { offset }, complete: false, bodyFetches: 0 };
    const items: RawItem[] = [];
    let bodyFetches = 0;
    const retryKeys = new Set<string>();
    for (const retry of input.bodyRetryCandidates ?? []) {
      if (items.length >= pageSize || bodyFetches >= budget) break;
      retryKeys.add(retry.externalKey);
      retryKeys.add(retry.canonicalUrl);
      bodyFetches += 1;
      let body = retry.body ?? '';
      let quality: RawItem['quality'] = retry.quality ?? 'metadata_only';
      let nextBodyRetryAt: number | null = null;
      try {
        await input.beforeRequest?.();
        const article = await boundedFetch(retry.canonicalUrl, input.source.allowedHosts, {
          fetcher: this.fetcher, signal: input.signal,
          timeoutMs: Math.max(1, Math.min(input.fetchTimeoutMs ?? 15_000, input.deadlineAt - Date.now())),
          maxBytes: input.maxResponseBytes ?? 2 * 1024 * 1024,
        });
        const extracted = await extractHtml(article, input.source, maxBodyBytes);
        if (extracted.quality === 'full' || (extracted.quality === 'partial' && quality === 'metadata_only')) {
          body = extracted.text;
          quality = extracted.quality;
        }
        if (quality !== 'full') nextBodyRetryAt = Date.now() + 3_600_000 * (retry.attempts + 1);
      } catch {
        nextBodyRetryAt = Date.now() + 3_600_000 * (retry.attempts + 1);
      }
      items.push({ externalKey: retry.externalKey, canonicalUrl: retry.canonicalUrl, title: retry.title,
        publishedAt: retry.publishedAt, sourceUpdatedAt: retry.sourceUpdatedAt, body, quality,
        metadata: { extractionAttempts: retry.attempts + 1, nextBodyRetryAt } });
    }
    const selected = links.filter((link) => !retryKeys.has(link.url))
      .slice(offset, offset + Math.min(pageSize - items.length, budget - bodyFetches));
    for (const link of selected) {
      let body = '';
      let title = link.title;
      let publishedAt = link.publishedAt;
      let quality: RawItem['quality'] = 'metadata_only';
      const retry = input.retryState?.[link.url];
      let extractionAttempts = retry?.attempts ?? 0;
      let nextBodyRetryAt: number | null = null;
      const mayTry = extractionAttempts < 3 && (retry?.nextBodyRetryAt ?? 0) <= Date.now();
      if (mayTry) {
        bodyFetches += 1;
        try {
          await input.beforeRequest?.();
          const article = await boundedFetch(link.url, input.source.allowedHosts, {
            fetcher: this.fetcher, signal: input.signal,
            timeoutMs: Math.max(1, Math.min(input.fetchTimeoutMs ?? 15_000, input.deadlineAt - Date.now())),
            maxBytes: input.maxResponseBytes ?? 2 * 1024 * 1024,
          });
          const extracted = await extractHtml(article, input.source, maxBodyBytes);
          let resolved = extracted;
          if (resolved.quality === 'metadata_only' && this.browserFallback !== undefined && input.runId !== undefined && input.lease !== undefined) {
            const rendered = await this.browserFallback.render({ source: input.source, runId: input.runId, lease: input.lease,
              url: link.url, deadlineAt: input.deadlineAt });
            if (rendered.kind === 'rendered') resolved = await extractHtml(new Response(rendered.html, {
              headers: { 'content-type': 'text/html; charset=utf-8' },
            }), input.source, maxBodyBytes);
          }
          body = resolved.text;
          quality = resolved.quality;
          title = resolved.title ?? title;
          publishedAt = resolved.publishedAt ?? publishedAt;
          if (quality === 'metadata_only') {
            extractionAttempts += 1;
            nextBodyRetryAt = Date.now() + 3_600_000 * extractionAttempts;
          }
        } catch {
          extractionAttempts += 1;
          nextBodyRetryAt = Date.now() + 3_600_000 * extractionAttempts;
        }
      } else {
        nextBodyRetryAt = retry?.nextBodyRetryAt ?? null;
      }
      items.push({
        externalKey: link.url,
        canonicalUrl: link.url,
        title: title || new URL(link.url).pathname.split('/').filter(Boolean).at(-1) || link.url,
        publishedAt,
        sourceUpdatedAt: null,
        body,
        quality,
        metadata: { extractionAttempts, nextBodyRetryAt },
      });
    }
    const nextOffset = offset + selected.length;
    return { items, nextCursor: nextOffset >= links.length ? null : { offset: nextOffset },
      complete: nextOffset >= links.length, bodyFetches };
  }
}
