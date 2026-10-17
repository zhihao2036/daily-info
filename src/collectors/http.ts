import { assertAllowedUrl } from './normalize';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface BoundedFetchOptions {
  fetcher?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  headers?: HeadersInit;
}

function statusError(status: number): Error {
  if (status === 404 || status === 410) return new Error(`HTTP_PERMANENT:${status}`);
  if (status === 408 || status === 429 || status >= 500) return new Error(`HTTP_RETRYABLE:${status}`);
  return new Error(`HTTP_STATUS:${status}`);
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('RESPONSE_TOO_LARGE');
        throw new Error('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function boundedFetch(raw: string, allowedHosts: string[], options: BoundedFetchOptions = {}): Promise<Response> {
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('HTTP_TIMEOUT'), options.timeoutMs ?? 15_000);
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  let current = assertAllowedUrl(raw, allowedHosts);
  try {
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      let response: Response;
      try {
        const init: RequestInit = {
          redirect: 'manual',
          signal: controller.signal,
          ...(options.headers === undefined ? {} : { headers: options.headers }),
        };
        response = await fetcher(current.toString(), init);
      } catch (error) {
        if (controller.signal.aborted) throw new Error('HTTP_TIMEOUT');
        throw error;
      }
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        const location = response.headers.get('location');
        if (location === null) throw new Error('HTTP_REDIRECT_INVALID');
        if (redirects === 3) throw new Error('HTTP_TOO_MANY_REDIRECTS');
        current = assertAllowedUrl(new URL(location, current).toString(), allowedHosts);
        continue;
      }
      if (response.status !== 304 && !response.ok) throw statusError(response.status);
      const body = await readBounded(response, options.maxBytes ?? 2 * 1024 * 1024);
      const responseBody = body === null ? null : body.buffer as ArrayBuffer;
      return new Response(responseBody, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    throw new Error('HTTP_TOO_MANY_REDIRECTS');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
