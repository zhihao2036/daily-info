import type { SourceConfig } from '../domain/contracts';

// Compact, opt-in source definitions keep Workers' JSON bindings below 5 KiB.
// Enabling a preset still requires verification in the deployment's Worker runtime.
const defaults = { kind: 'html_list' as const, enabled: false, core: true, priority: 100,
  authority: 'official' as const, intervalHours: 2, verification: 'discovered' as const,
  browserFallbackEnabled: false };

export const SOURCE_PRESETS: Readonly<Record<string, SourceConfig>> = {
  'minimax-blog': { ...defaults, id: 'minimax-blog', name: 'MiniMax Research',
    url: 'https://www.minimax.io/blog', allowedHosts: ['www.minimax.io', 'minimax.io'],
    html: { listLinkSelector: 'a.overflow-hidden[href^="/blog/"]', articleSelector: 'article', dateSelector: 'article time' } },
  'cursor-changelog': { ...defaults, id: 'cursor-changelog', name: 'Cursor Changelog',
    url: 'https://cursor.com/changelog', allowedHosts: ['cursor.com', 'www.cursor.com'],
    html: { listLinkSelector: 'article h1 a[href^="/changelog/"]', articleSelector: 'article', dateSelector: 'time' } },
};
