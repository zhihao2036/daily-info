import type { ContentQuality, SourceConfig } from '../domain/contracts';
import { normalizeText, truncateUtf8 } from '../collectors/normalize';

const MAX_BODY_BYTES = 128 * 1024;
const EXCLUDED = 'script,style,nav,footer,form,iframe,[hidden],[aria-hidden="true"],.not-prose';

export async function extractHtml(
  response: Response,
  source: SourceConfig,
  maxBodyBytes = MAX_BODY_BYTES,
): Promise<{ text: string; quality: ContentQuality; title?: string; publishedAt?: number }> {
  if (source.html === undefined) throw new Error('SOURCE_CONFIG_INVALID');
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType !== '' && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    throw new Error('HTML_CONTENT_TYPE_INVALID');
  }
  const withoutChrome = new HTMLRewriter().on(EXCLUDED, { element(element) { element.remove(); } }).transform(response);
  const chunks: string[] = [];
  const titleChunks: string[] = [];
  let dateChunks: string[] = [];
  let publishedAt: number | undefined;
  const recordDate = (value: string | null) => {
    if (publishedAt !== undefined || value === null) return;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) publishedAt = parsed;
  };
  let matched = 0;
  const transformed = new HTMLRewriter().on(source.html.articleSelector, {
    element(element) {
      matched += 1;
      element.onEndTag(() => { chunks.push('\n\n'); });
    },
    text(text) {
      chunks.push(text.text);
      if (text.lastInTextNode) chunks.push(' ');
    },
  }).on('p,h2,h3,h4,li,pre,blockquote', { element(element) { element.onEndTag(() => { chunks.push('\n\n'); }); } })
    .on('main h1, article h1', { text(text) { titleChunks.push(text.text); } })
    .on('meta[property="article:published_time"], meta[name="date"]', {
      element(element) { recordDate(element.getAttribute('content')); },
    }).on(source.html.dateSelector ?? 'time[datetime]', {
      element(element) {
        recordDate(element.getAttribute('datetime') ?? element.getAttribute('content'));
        dateChunks = [];
        element.onEndTag(() => {
          const label = normalizeText(dateChunks.join(''));
          // Text-only dates must explicitly include a year. Never guess from the clock.
          if (/\b20\d{2}\b/.test(label)) recordDate(label);
        });
      },
      text(text) { dateChunks.push(text.text); },
    }).transform(withoutChrome);
  await transformed.arrayBuffer();
  if (matched === 0) return { text: '', quality: 'metadata_only' };
  const normalized = normalizeText(chunks.join(''));
  if (normalized === '') return { text: '', quality: 'metadata_only' };
  const truncated = truncateUtf8(normalized, Math.max(1, Math.min(MAX_BODY_BYTES, Math.trunc(maxBodyBytes))));
  const title = normalizeText(titleChunks.join(''));
  return { text: truncated.value, quality: truncated.truncated ? 'partial' : 'full',
    ...(title === '' ? {} : { title }), ...(publishedAt === undefined ? {} : { publishedAt }) };
}
