import type { CollectionPage, SourceConfig } from '../domain/contracts';
import { canonicalizeUrl, normalizeText, truncateUtf8 } from './normalize';

const MONTHS = 'January February March April May June July August September October November December'.split(' ');
const MONTH_PATTERN = MONTHS.join('|');

function metadataYear(value: unknown): number | null {
  if (Array.isArray(value)) return value.map(metadataYear).find(year => year !== null) ?? null;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record['@graph'] !== undefined) return metadataYear(record['@graph']);
  const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
  if (!types.some(type => ['Article','TechArticle','NewsArticle','BlogPosting'].includes(String(type)))) return null;
  const date = record.datePublished;
  if (typeof date !== 'string' || !/^20\d{2}-\d{2}-\d{2}(?:T|$)/.test(date) || !Number.isFinite(Date.parse(date))) return null;
  return Number(date.slice(0, 4));
}

function entryDate(label: string, year: number | null): number | null {
  const match = normalizeText(label).match(new RegExp(`^(${MONTH_PATTERN})\\s+(\\d{1,2})(?:,?\\s+(20\\d{2}))?$`, 'i'));
  if (!match) return null;
  const actualYear = match[3] === undefined ? year : Number(match[3]);
  if (actualYear === null) return null;
  const month = MONTHS.findIndex(value => value.toLowerCase() === match[1]!.toLowerCase());
  const day = Number(match[2]);
  const at = Date.UTC(actualYear, month, day);
  const parsed = new Date(at);
  return parsed.getUTCFullYear() === actualYear && parsed.getUTCMonth() === month && parsed.getUTCDate() === day ? at : null;
}

/** Read dated entries from an official timeline; never infer a year from the current clock. */
export async function extractChangelog(response: Response, source: SourceConfig, pageSize: number, maxBodyBytes: number): Promise<CollectionPage> {
  const selectors = source.html?.changelog;
  if (!selectors) throw new Error('SOURCE_CONFIG_INVALID');
  const type = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (type && !type.includes('text/html') && !type.includes('application/xhtml+xml')) throw new Error('HTML_CONTENT_TYPE_INVALID');
  const raw = await response.text();
  let fallbackYear: number | null = null;
  let json: string[] = [];
  let jsonLength = 0;
  const metadata = new HTMLRewriter().on('script[type="application/ld+json"]', {
    element(element) {
      json = []; jsonLength = 0;
      element.onEndTag(() => {
        if (jsonLength > 65_536) return;
        try { fallbackYear ??= metadataYear(JSON.parse(json.join(''))); } catch { /* Invalid metadata supplies no year. */ }
      });
    },
    text(text) { jsonLength += text.text.length; if (jsonLength <= 65_536) json.push(text.text); },
  }).transform(new Response(raw));
  await metadata.arrayBuffer();
  // .not-prose is a typography class here: its inline model names and code are evidence.
  const clean = new HTMLRewriter().on('script,style,nav,footer,form,iframe,[hidden],[aria-hidden="true"]', {
    element(element) { element.remove(); },
  }).transform(new Response(raw));
  interface Entry { body: string[]; title: string[]; date: string[]; fragment: string | null; year: number | null }
  const entries: Entry[] = [];
  let active: Entry | null = null;
  let heading: string[] = [];
  let year: number | null = null;
  const extracted = new HTMLRewriter().on(selectors.yearSelector, {
    element(element) {
      heading = [];
      element.onEndTag(() => {
        const match = normalizeText(heading.join('')).match(new RegExp(`^(?:${MONTH_PATTERN})\\s+(20\\d{2})$`, 'i'));
        if (match) year = Number(match[1]);
      });
    },
    text(text) { heading.push(text.text); },
  }).on(selectors.entrySelector, {
    element(element) {
      active = { body: [], title: [], date: [], fragment: null, year };
      entries.push(active);
      element.onEndTag(() => { active = null; });
    },
    text(text) { active?.body.push(text.text, text.lastInTextNode ? ' ' : ''); },
  }).on(`${selectors.entrySelector} ${selectors.titleSelector}`, {
    element(element) { if (active) active.fragment = element.getAttribute('id'); },
    text(text) { active?.title.push(text.text); },
  }).on(`${selectors.entrySelector} ${selectors.dateSelector}`, {
    text(text) { active?.date.push(text.text); },
  }).transform(clean);
  await extracted.arrayBuffer();
  const base = canonicalizeUrl(source.url, source.allowedHosts);
  const items = entries.slice(0, pageSize).flatMap(entry => {
    const title = normalizeText(entry.title.join(''));
    if (!title) return [];
    const bounded = truncateUtf8(normalizeText(entry.body.join('')), maxBodyBytes);
    const url = new URL(base);
    // Anchors distinguish separately dated announcements on the same official page.
    url.hash = entry.fragment ?? title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const canonicalUrl = url.toString();
    return [{ externalKey: canonicalUrl, canonicalUrl, title: `${source.name}: ${title}`,
      publishedAt: entryDate(entry.date.join(''), entry.year ?? fallbackYear), sourceUpdatedAt: null,
      body: bounded.value, quality: bounded.truncated ? 'partial' as const : 'full' as const, metadata: {} }];
  });
  return { items, nextCursor: null, complete: true, bodyFetches: 0 };
}
