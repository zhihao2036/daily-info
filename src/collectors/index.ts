import type { Collector, SourceKind } from '../domain/contracts';
import { GithubReleasesCollector } from './github';
import { HtmlListCollector } from './html';
import type { FetchLike } from './http';
import { RssCollector } from './rss';
import type { BrowserFallback } from './browser-fallback';

export interface CollectorOptions { fetcher?: FetchLike; githubToken?: string; browserFallback?: BrowserFallback }

export function createCollector(kind: SourceKind, options: CollectorOptions = {}): Collector {
  const fetcher = options.fetcher ?? fetch;
  switch (kind) {
    case 'rss': return new RssCollector(fetcher, options.browserFallback);
    case 'github_releases': return new GithubReleasesCollector(fetcher, options.githubToken);
    case 'html_list': return new HtmlListCollector(fetcher, options.browserFallback);
  }
}
