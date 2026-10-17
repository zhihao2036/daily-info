import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Collector, CollectionPage, Json, RawItem, SourceConfig } from '../domain/contracts';
import { boundedFetch, type FetchLike } from './http';
import { canonicalizeUrl, stripMarkup, truncateUtf8 } from './normalize';
import { extractHtml } from '../extractors/html';
import type { BrowserFallback } from './browser-fallback';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  htmlEntities: false,
  trimValues: true,
});

function list<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value !== null && typeof value === 'object' && '#text' in value) return text((value as { '#text': unknown })['#text']);
  return '';
}

function parsedTime(value: unknown): number | null {
  const raw = text(value).trim();
  if (raw === '') return null;
  const valueMs = Date.parse(raw);
  return Number.isFinite(valueMs) ? valueMs : null;
}

function feedUrl(raw: string, source: SourceConfig): string {
  const url = new URL(raw);
  // Some official feeds still advertise HTTP links. Only opt-in sources may
  // upgrade them; canonicalization still enforces the exact host allowlist.
  if (source.upgradeHttpLinks && url.protocol === 'http:') url.protocol = 'https:';
  return canonicalizeUrl(url.toString(), source.allowedHosts);
}

function feedBody(raw: string): string {
  // Atom HTML and RSS descriptions may carry entity-escaped markup.
  return stripMarkup(stripMarkup(raw));
}

function assertXmlBounds(xml: string): void {
  if (new TextEncoder().encode(xml).byteLength > 2 * 1024 * 1024) throw new Error('RESPONSE_TOO_LARGE');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML_DTD_FORBIDDEN');
  // CDATA contains text, often HTML. Its angle brackets are not XML nodes.
  // Scan markup once so comments, CDATA, and quoted '>' do not distort bounds.
  let offset = 0;
  let nodes = 0;
  let depth = 0;
  while ((offset = xml.indexOf('<', offset)) !== -1) {
    const delimiter = xml.startsWith('<![CDATA[', offset) ? [9, ']]>'] as const
      : xml.startsWith('<!--', offset) ? [4, '-->'] as const
      : xml.startsWith('<?', offset) ? [2, '?>'] as const : null;
    if (delimiter !== null) {
      const end = xml.indexOf(delimiter[1], offset + delimiter[0]);
      if (end === -1) throw new Error('XML_INVALID');
      offset = end + delimiter[1].length;
      continue;
    }
    let end = offset + 1;
    let quote = '';
    for (; end < xml.length; end += 1) {
      const char = xml[end]!;
      if (quote !== '') { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === xml.length) throw new Error('XML_INVALID');
    const tag = xml.slice(offset, end + 1);
    offset = end + 1;
    if (!/^<\/?[A-Za-z_]/.test(tag)) throw new Error('XML_INVALID');
    nodes += 1;
    if (nodes > 20_000) throw new Error('XML_NODE_LIMIT');
    if (tag.startsWith('</')) depth -= 1;
    else if (!tag.endsWith('/>')) {
      depth += 1;
      if (depth > 64) throw new Error('XML_DEPTH_LIMIT');
    }
  }
}

interface FeedLimits { pageSize: number; maxBodyBytes: number }

function rssItems(channel: Record<string, unknown>, source: SourceConfig, limits: FeedLimits): RawItem[] {
  const output: RawItem[] = [];
  for (const entry of list(channel.item as Record<string, unknown> | Record<string, unknown>[] | undefined).slice(0, limits.pageSize)) {
    const title = stripMarkup(text(entry.title));
    const link = text(entry.link);
    if (link === '') continue;
    let canonicalUrl: string;
    try { canonicalUrl = feedUrl(link, source); } catch { continue; }
    const full = text(entry['content:encoded']);
    const summary = text(entry.description);
    const bounded = truncateUtf8(feedBody(full || summary), limits.maxBodyBytes);
    const body = bounded.value;
    if (title === '' && body === '') continue;
    output.push({
      externalKey: text(entry.guid).trim() || canonicalUrl,
      canonicalUrl,
      title,
      publishedAt: parsedTime(entry.pubDate),
      sourceUpdatedAt: null,
      body,
      quality: body === '' ? 'metadata_only' : full.trim() !== '' && !bounded.truncated ? 'full' : 'partial',
      metadata: {},
    });
  }
  return output;
}

function atomLink(value: unknown): string {
  for (const link of list(value as Record<string, unknown> | Record<string, unknown>[] | string | undefined)) {
    if (typeof link === 'string') return link;
    const href = text(link['@_href']);
    const relation = text(link['@_rel']);
    if (href !== '' && (relation === '' || relation === 'alternate')) return href;
  }
  return '';
}

function atomItems(feed: Record<string, unknown>, source: SourceConfig, limits: FeedLimits): RawItem[] {
  const output: RawItem[] = [];
  for (const entry of list(feed.entry as Record<string, unknown> | Record<string, unknown>[] | undefined).slice(0, limits.pageSize)) {
    const title = stripMarkup(text(entry.title));
    const link = atomLink(entry.link);
    if (link === '') continue;
    let canonicalUrl: string;
    try { canonicalUrl = feedUrl(link, source); } catch { continue; }
    const content = text(entry.content);
    const summary = text(entry.summary);
    const bounded = truncateUtf8(feedBody(content || summary), limits.maxBodyBytes);
    const body = bounded.value;
    if (title === '' && body === '') continue;
    output.push({
      externalKey: text(entry.id).trim() || canonicalUrl,
      canonicalUrl,
      title,
      publishedAt: parsedTime(entry.published),
      sourceUpdatedAt: parsedTime(entry.updated),
      body,
      quality: body === '' ? 'metadata_only' : content.trim() !== '' && !bounded.truncated ? 'full' : 'partial',
      metadata: {},
    });
  }
  return output;
}

export function normalizeFeed(xml: string, source: SourceConfig, input: Partial<FeedLimits> = {}): RawItem[] {
  const limits = {
    pageSize: Math.max(1, Math.min(30, Math.trunc(input.pageSize ?? 30))),
    maxBodyBytes: Math.max(1, Math.min(128 * 1024, Math.trunc(input.maxBodyBytes ?? 128 * 1024))),
  };
  assertXmlBounds(xml);
  if (XMLValidator.validate(xml) !== true) throw new Error('XML_INVALID');
  let parsed: Record<string, unknown>;
  try { parsed = parser.parse(xml) as Record<string, unknown>; } catch { throw new Error('XML_INVALID'); }
  const rss = parsed.rss as { channel?: Record<string, unknown> } | undefined;
  if (rss?.channel !== undefined) return rssItems(rss.channel, source, limits);
  const feed = parsed.feed as Record<string, unknown> | undefined;
  if (feed !== undefined) return atomItems(feed, source, limits);
  throw new Error('FEED_STRUCTURE_INVALID');
}

export class RssCollector implements Collector {
  constructor(private readonly fetcher: FetchLike = fetch, private readonly browserFallback?: BrowserFallback) {}
  async fetchPage(input: { source: SourceConfig; cursor: Json; deadlineAt: number; signal: AbortSignal;
    bodyBudget?: number; retryState?: Record<string, { attempts: number; nextBodyRetryAt: number | null }>;
    bodyRetryCandidates?: import('../domain/contracts').BodyRetryCandidate[];
    pageSize?: number; fetchTimeoutMs?: number; maxResponseBytes?: number; maxBodyBytes?: number;
    conditional?: { etag: string | null; lastModified: string | null };
    runId?: string; lease?: import('../domain/contracts').Lease;
    beforeRequest?(): Promise<void> }): Promise<CollectionPage> {
    await input.beforeRequest?.();
    let response: Response;
    try {
      response = await boundedFetch(input.source.url, input.source.allowedHosts, {
        fetcher: this.fetcher,
        signal: input.signal,
        timeoutMs: Math.max(1, Math.min(input.fetchTimeoutMs ?? 15_000, input.deadlineAt - Date.now())),
        maxBytes: input.maxResponseBytes ?? 2 * 1024 * 1024,
        headers: {
          accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
          ...(input.conditional?.etag === null || input.conditional?.etag === undefined ? {} : { 'if-none-match': input.conditional.etag }),
          ...(input.conditional?.lastModified === null || input.conditional?.lastModified === undefined ? {} : { 'if-modified-since': input.conditional.lastModified }),
        },
      });
    } catch (error) {
      const status = error instanceof Error ? error.message.match(/^HTTP_(?:STATUS|RETRYABLE):(401|403|429)$/)?.[1] : undefined;
      if (status !== undefined && this.browserFallback?.block !== undefined && input.runId !== undefined && input.lease !== undefined) {
        await this.browserFallback.block({ source: input.source, lease: input.lease, status: Number(status) as 401 | 403 | 429 });
      }
      throw error;
    }
    if (response.status === 304) return { items: [], nextCursor: null, complete: true };
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('text/html')) throw new Error('FEED_CONTENT_TYPE_INVALID');
    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');
    const pageSize = Math.max(1, Math.min(30, Math.trunc(input.pageSize ?? 30)));
    const maxBodyBytes = Math.max(1, Math.min(128 * 1024, Math.trunc(input.maxBodyBytes ?? 128 * 1024)));
    const feedItems = normalizeFeed(await response.text(), input.source, { pageSize, maxBodyBytes });
    const items: RawItem[] = [];
    let bodyFetches = 0;
    const budget = Math.max(0, Math.min(20, Math.trunc(input.bodyBudget ?? 20)));
    const retryKeys = new Set<string>();
    for (const retry of input.bodyRetryCandidates ?? []) {
      if (items.length >= pageSize || bodyFetches >= budget) break;
      retryKeys.add(retry.externalKey);
      retryKeys.add(retry.canonicalUrl);
      bodyFetches += 1;
      let body = '';
      let quality: RawItem['quality'] = 'metadata_only';
      let nextBodyRetryAt: number | null = null;
      try {
        await input.beforeRequest?.();
        const article = await boundedFetch(retry.canonicalUrl, input.source.allowedHosts, {
          fetcher: this.fetcher, signal: input.signal,
          timeoutMs: Math.max(1, Math.min(input.fetchTimeoutMs ?? 15_000, input.deadlineAt - Date.now())),
          maxBytes: input.maxResponseBytes ?? 2 * 1024 * 1024,
        });
        const extracted = await extractHtml(article, { ...input.source,
          html: input.source.html ?? { listLinkSelector: 'a', articleSelector: 'article,main' } }, maxBodyBytes);
        body = extracted.text;
        quality = extracted.quality;
        if (quality === 'metadata_only') nextBodyRetryAt = Date.now() + 3_600_000 * (retry.attempts + 1);
      } catch {
        nextBodyRetryAt = Date.now() + 3_600_000 * (retry.attempts + 1);
      }
      items.push({ externalKey: retry.externalKey, canonicalUrl: retry.canonicalUrl, title: retry.title,
        publishedAt: retry.publishedAt, sourceUpdatedAt: retry.sourceUpdatedAt, body, quality,
        metadata: { extractionAttempts: retry.attempts + 1, nextBodyRetryAt } });
    }
    for (const item of feedItems) {
      if (items.length >= pageSize || retryKeys.has(item.externalKey) || retryKeys.has(item.canonicalUrl)) continue;
      const index = items.push(item) - 1;
      if (bodyFetches >= budget || item.quality === 'full') continue;
      const retry = input.retryState?.[item.externalKey];
      const attempts = retry?.attempts ?? 0;
      if (attempts >= 3 || (retry?.nextBodyRetryAt ?? 0) > Date.now()) {
        item.metadata = { ...item.metadata, extractionAttempts: attempts, nextBodyRetryAt: retry?.nextBodyRetryAt ?? null };
        continue;
      }
      bodyFetches += 1;
      try {
        await input.beforeRequest?.();
        const article = await boundedFetch(item.canonicalUrl, input.source.allowedHosts, {
          fetcher: this.fetcher, signal: input.signal,
          timeoutMs: Math.max(1, Math.min(input.fetchTimeoutMs ?? 15_000, input.deadlineAt - Date.now())),
          maxBytes: input.maxResponseBytes ?? 2 * 1024 * 1024,
        });
          const extracted = await extractHtml(article, { ...input.source,
          html: input.source.html ?? { listLinkSelector: 'a', articleSelector: 'article,main' } }, maxBodyBytes);
        let resolved = extracted;
        if (resolved.quality === 'metadata_only' && this.browserFallback !== undefined && input.runId !== undefined && input.lease !== undefined) {
          const rendered = await this.browserFallback.render({ source: input.source, runId: input.runId, lease: input.lease,
            url: item.canonicalUrl, deadlineAt: input.deadlineAt });
          if (rendered.kind === 'rendered') {
            resolved = await extractHtml(new Response(rendered.html, { headers: { 'content-type': 'text/html; charset=utf-8' } }), { ...input.source,
              html: input.source.html ?? { listLinkSelector: 'a', articleSelector: 'article,main' } }, maxBodyBytes);
          }
        }
        if (resolved.quality !== 'metadata_only') {
          items[index] = { ...item, body: resolved.text, quality: resolved.quality,
            metadata: { ...item.metadata, extractionAttempts: attempts + 1, nextBodyRetryAt: null } };
        } else {
          item.metadata = { ...item.metadata, extractionAttempts: attempts + 1,
            nextBodyRetryAt: Date.now() + 3_600_000 * (attempts + 1) };
        }
      } catch {
        item.metadata = { ...item.metadata, extractionAttempts: attempts + 1,
          nextBodyRetryAt: Date.now() + 3_600_000 * (attempts + 1) };
      }
    }
    return {
      items,
      nextCursor: null,
      complete: true,
      bodyFetches,
      ...(etag === null ? {} : { etag }),
      ...(lastModified === null ? {} : { lastModified }),
    };
  }
}
