import type { Collector, CollectionPage, Json, RawItem, SourceConfig } from '../domain/contracts';
import { boundedFetch, type FetchLike } from './http';
import { canonicalizeUrl, truncateUtf8 } from './normalize';

interface GithubRelease {
  id: number;
  name: string | null;
  tag_name: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  published_at?: string | null;
  created_at?: string | null;
}

function nextPage(link: string | null): number | null {
  if (link === null) return null;
  for (const part of link.split(',')) {
    if (!/;\s*rel="next"/.test(part)) continue;
    const match = part.match(/[?&]page=(\d+)/);
    if (match !== null) return Number(match[1]);
  }
  return null;
}

export class GithubReleasesCollector implements Collector {
  constructor(private readonly fetcher: FetchLike = fetch, private readonly token?: string) {}

  async fetchPage(input: { source: SourceConfig; cursor: Json; deadlineAt: number; signal: AbortSignal;
    bodyBudget?: number; retryState?: Record<string, { attempts: number; nextBodyRetryAt: number | null }>;
    bodyRetryCandidates?: import('../domain/contracts').BodyRetryCandidate[];
    pageSize?: number; fetchTimeoutMs?: number; maxResponseBytes?: number; maxBodyBytes?: number;
    conditional?: { etag: string | null; lastModified: string | null };
    beforeRequest?(): Promise<void> }): Promise<CollectionPage> {
    if (input.source.github === undefined) throw new Error('SOURCE_CONFIG_INVALID');
    const cursor = input.cursor !== null && typeof input.cursor === 'object' && !Array.isArray(input.cursor)
      ? input.cursor as Record<string, Json> : {};
    const page = typeof cursor.page === 'number' && Number.isInteger(cursor.page) ? cursor.page : 1;
    const api = new URL(input.source.url);
    const pageSize = Math.max(1, Math.min(30, Math.trunc(input.pageSize ?? 30)));
    api.searchParams.set('per_page', String(pageSize));
    api.searchParams.set('page', String(page));
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'daily-info-worker',
      'x-github-api-version': '2022-11-28',
    };
    if (this.token !== undefined) headers.authorization = `Bearer ${this.token}`;
    await input.beforeRequest?.();
    const response = await boundedFetch(api.toString(), input.source.allowedHosts, {
      fetcher: this.fetcher, signal: input.signal, headers,
      timeoutMs: Math.max(1, Math.min(input.fetchTimeoutMs ?? 15_000, input.deadlineAt - Date.now())),
      maxBytes: input.maxResponseBytes ?? 2 * 1024 * 1024,
    });
    let releases: GithubRelease[];
    try { releases = await response.json() as GithubRelease[]; } catch { throw new Error('GITHUB_RESPONSE_INVALID'); }
    if (!Array.isArray(releases)) throw new Error('GITHUB_RESPONSE_INVALID');
    const items: RawItem[] = [];
    for (const release of releases.slice(0, pageSize)) {
      if (release.draft || (release.prerelease && !input.source.github.includePrerelease)) continue;
      const canonicalUrl = canonicalizeUrl(release.html_url, input.source.allowedHosts);
      const rawBody = release.body?.trim() ?? '';
      const bodyBytes = Math.max(1, Math.min(128 * 1024, Math.trunc(input.maxBodyBytes ?? 128 * 1024)));
      const bounded = truncateUtf8(rawBody, bodyBytes);
      const body = bounded.value;
      const published = release.published_at ?? release.created_at;
      const publishedAt = published === null || published === undefined || !Number.isFinite(Date.parse(published)) ? null : Date.parse(published);
      items.push({
        externalKey: `github-release:${release.id}`,
        canonicalUrl,
        title: `${input.source.name}: ${(release.name?.trim() || release.tag_name).trim()}`,
        publishedAt,
        sourceUpdatedAt: null,
        body,
        quality: body === '' ? 'metadata_only' : bounded.truncated ? 'partial' : 'full',
        metadata: { tag: release.tag_name, prerelease: release.prerelease },
      });
    }
    const following = nextPage(response.headers.get('link'));
    return { items, nextCursor: following === null ? null : { page: following }, complete: following === null };
  }
}
