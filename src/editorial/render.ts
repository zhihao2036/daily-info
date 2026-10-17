import type { DigestContent } from '../domain/contracts';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function renderDigest(content: DigestContent, versionUrls: ReadonlyMap<string, string> = new Map(),
  versionDates: ReadonlyMap<string, number | null> = new Map()): { text: string; html: string } {
  const heading = `AI / Agent 早报 · ${content.localDate}`;
  const notes = content.coverageNote === null ? [] : [content.coverageNote];
  const publication = (card: DigestContent['cards'][number]) => {
    const dates = card.sourceVersionIds.map(id => versionDates.get(id)).filter((at): at is number => typeof at === 'number');
    if (dates.length === 0) return '';
    const at = Math.max(...dates);
    return `来源发布：${new Date(at + 8 * 3_600_000).toISOString().slice(0, 10)}${at < content.windowStartAt ? '（补录）' : ''}`;
  };
  const textCards = content.cards.map((card, index) => {
    const sources = card.sourceVersionIds.map((id) => versionUrls.get(id)).filter((url): url is string => url !== undefined);
    return `${index + 1}. ${card.title}${publication(card) === '' ? '' : `\n${publication(card)}`}\n${card.summary}\n为什么值得关注：${card.whyItMatters}${card.suggestedAction === null ? '' : `\n建议：${card.suggestedAction.replace(/^(?:建议[：:]\s*)+/, '')}`}${sources.length === 0 ? '' : `\n来源：${sources.join(' ')}`}`;
  });
  const empty = content.noImportantUpdates ? ['截至 08:00 暂无达到发布标准的重要更新。'] : [];
  const coverage = content.sourceCoverage ?? [];
  const coverageText = coverage.length === 0 ? [] : ['来源覆盖（候选与收录不同）：\n'
    + coverage.map(source => `${source.name}：候选 ${source.candidates} 条，收录 ${source.selected} 条`).join('\n')
    + '\n候选为本期符合日期与内容条件的条目；未收录不等于采集失败。'];
  const text = [heading, ...notes, ...empty, ...textCards, ...coverageText].join('\n\n');
  const htmlCards = content.cards.map((card) => {
    const sources = card.sourceVersionIds.map((id) => versionUrls.get(id)).filter((url): url is string => url !== undefined)
      .map((url) => `<a href="${escapeHtml(url)}" rel="noreferrer">来源</a>`).join(' ');
    return `<article><h2>${escapeHtml(card.title)}</h2>${publication(card) === '' ? '' : `<p>${escapeHtml(publication(card))}</p>`}<p>${escapeHtml(card.summary)}</p><p><strong>为什么值得关注：</strong>${escapeHtml(card.whyItMatters)}</p>${card.suggestedAction === null ? '' : `<p><strong>建议：</strong>${escapeHtml(card.suggestedAction.replace(/^(?:建议[：:]\s*)+/, ''))}</p>`}${sources === '' ? '' : `<p>${sources}</p>`}</article>`;
  }).join('');
  const coverageHtml = coverage.length === 0 ? '' : `<section><h2>来源覆盖</h2><ul>${coverage.map(source => `<li>${escapeHtml(source.name)}：候选 ${source.candidates} 条，收录 ${source.selected} 条</li>`).join('')}</ul><p>候选为本期符合日期与内容条件的条目；未收录不等于采集失败。</p></section>`;
  const html = `<main><h1>${escapeHtml(heading)}</h1>${notes.map((note) => `<p>${escapeHtml(note)}</p>`).join('')}${empty.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}${htmlCards}${coverageHtml}</main>`;
  return { text, html };
}
