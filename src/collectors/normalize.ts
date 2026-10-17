const TRACKING_KEYS = new Set(['fbclid', 'gclid']);

function isIpLiteral(hostname: string): boolean {
  if (hostname.includes(':')) return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function assertAllowedUrl(raw: string, allowedHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL_INVALID');
  }
  if (url.protocol !== 'https:') throw new Error('URL_HTTPS_REQUIRED');
  if (url.username !== '' || url.password !== '') throw new Error('URL_CREDENTIALS_FORBIDDEN');
  if (url.port !== '' && url.port !== '443') throw new Error('URL_PORT_FORBIDDEN');
  const hostname = url.hostname.toLowerCase();
  if (isIpLiteral(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('URL_IP_FORBIDDEN');
  }
  if (!allowedHosts.some((host) => host.toLowerCase() === hostname)) throw new Error('URL_HOST_NOT_ALLOWED');
  return url;
}

export function canonicalizeUrl(raw: string, allowedHosts: string[]): string {
  const url = assertAllowedUrl(raw, allowedHosts);
  url.hash = '';
  const entries = [...url.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith('utm_') && !TRACKING_KEYS.has(key.toLowerCase()))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  url.search = '';
  for (const [key, value] of entries) url.searchParams.append(key, value);
  return url.toString();
}

export function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

export function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return { value, truncated: false };
  const codePoints = [...value];
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(codePoints.slice(0, middle).join('')).byteLength <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return { value: codePoints.slice(0, low).join('').trimEnd(), truncated: true };
}

export function stripMarkup(value: string): string {
  return normalizeText(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'"));
}
