import { z } from 'zod';
import type { Json, RunAccepted } from '../domain/contracts';
import { isAuthorized } from './auth';
import { validateIdempotencyKey } from './idempotency';

export interface ApiDeps {
  adminToken: string;
  collect(input: { sourceId: string }, key: string): Promise<RunAccepted>;
  preview(input: { date?: string }, key: string): Promise<RunAccepted>;
  read(path: string): Promise<Json | null>;
}

const collectBody = z.strictObject({ sourceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) });
const previewBody = z.strictObject({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const responseHeaders = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

function publicError(code: string, status: number, retryable = false): Response {
  const messages: Record<string, string> = {
    INVALID_REQUEST: 'The request is invalid.',
    UNAUTHORIZED: 'Authentication is required.',
    NOT_FOUND: 'The resource was not found.',
    IDEMPOTENCY_CONFLICT: 'The idempotency key was already used for another request.',
    DATE_OUT_OF_RANGE: 'The preview date is outside the allowed range.',
    RATE_LIMITED: 'Too many new requests.',
    CONFIG_INVALID: 'The service configuration is invalid.',
    DATABASE_UNAVAILABLE: 'The database is unavailable.',
  };
  return json({ error: { code, message: messages[code] ?? 'The request failed.', requestId: crypto.randomUUID(), retryable } }, status);
}

async function readJsonBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > 8192) throw new Error('INVALID_REQUEST');
  if (request.body === null) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        throw new Error('INVALID_REQUEST');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new Error('INVALID_REQUEST');
  }
}

function mapError(error: unknown): Response {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('IDEMPOTENCY_CONFLICT')) return publicError('IDEMPOTENCY_CONFLICT', 409);
  if (message.startsWith('RATE_LIMITED')) return publicError('RATE_LIMITED', 429, true);
  if (message.startsWith('DATE_OUT_OF_RANGE')) return publicError('DATE_OUT_OF_RANGE', 422);
  if (message.startsWith('CONFIG_INVALID')) return publicError('CONFIG_INVALID', 422);
  if (message.startsWith('DATABASE_UNAVAILABLE')) return publicError('DATABASE_UNAVAILABLE', 503, true);
  if (error instanceof z.ZodError || message.startsWith('INVALID_REQUEST')) return publicError('INVALID_REQUEST', 400);
  return publicError('DATABASE_UNAVAILABLE', 503, true);
}

export function createHttpHandler(deps: ApiDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') return json({ ok: true });
    if (!isAuthorized(request, deps.adminToken)) return publicError('UNAUTHORIZED', 401);

    try {
      if (request.method === 'POST' && url.pathname === '/api/collect') {
        const key = validateIdempotencyKey(request.headers.get('idempotency-key'));
        const body = collectBody.parse(await readJsonBody(request));
        return json(await deps.collect(body, key), 202);
      }
      if (request.method === 'POST' && url.pathname === '/api/preview') {
        const key = validateIdempotencyKey(request.headers.get('idempotency-key'));
        const body = previewBody.parse(await readJsonBody(request));
        const input = body.date === undefined ? {} : { date: body.date };
        return json(await deps.preview(input, key), 202);
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/')) {
        const value = await deps.read(url.pathname);
        return value === null ? publicError('NOT_FOUND', 404) : json(value);
      }
      return publicError('NOT_FOUND', 404);
    } catch (error) {
      return mapError(error);
    }
  };
}
