import { describe, expect, it, vi } from 'vitest';
import { createHttpHandler, type ApiDeps } from '../../src/api/router';
import { createApplication, type RuntimeEnv } from '../../src/app';
import appExample from '../../reference/app.config.example.json';
import sourcesExample from '../../reference/sources.example.json';

function deps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  return {
    adminToken: 'test-token',
    collect: vi.fn().mockResolvedValue({ runId: 'r1', workflowId: 'w1', statusUrl: '/api/runs/r1' }),
    preview: vi.fn().mockResolvedValue({ runId: 'r2', workflowId: 'w2', statusUrl: '/api/runs/r2' }),
    read: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('HTTP API', () => {
  it('serves the unauthenticated health check with no-store', async () => {
    const response = await createHttpHandler(deps())(new Request('https://unit.test/healthz'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('rejects unauthorized dispatch before any side effect', async () => {
    const collect = vi.fn();
    const handle = createHttpHandler(deps({ collect }));
    const response = await handle(new Request('https://unit.test/api/collect', {
      method: 'POST', body: '{"sourceId":"hf-blog"}',
    }));
    expect(response.status).toBe(401);
    expect(collect).not.toHaveBeenCalled();
  });

  it('requires a printable idempotency key before dispatch', async () => {
    const collect = vi.fn();
    const response = await createHttpHandler(deps({ collect }))(new Request('https://unit.test/api/collect', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: '{"sourceId":"hf-blog"}',
    }));
    expect(response.status).toBe(400);
    expect(collect).not.toHaveBeenCalled();
  });

  it('dispatches a validated collect request and returns 202', async () => {
    const collect = vi.fn().mockResolvedValue({ runId: 'r1', workflowId: 'w1', statusUrl: '/api/runs/r1' });
    const response = await createHttpHandler(deps({ collect }))(new Request('https://unit.test/api/collect', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnop',
      },
      body: '{"sourceId":"hf-blog"}',
    }));
    expect(response.status).toBe(202);
    expect(collect).toHaveBeenCalledWith({ sourceId: 'hf-blog' }, 'abcdefghijklmnop');
  });

  it('maps domain conflicts to the public API error without leaking details', async () => {
    const collect = vi.fn().mockRejectedValue(new Error('IDEMPOTENCY_CONFLICT:secret-body-hash'));
    const response = await createHttpHandler(deps({ collect }))(new Request('https://unit.test/api/collect', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'idempotency-key': 'abcdefghijklmnop' },
      body: '{"sourceId":"hf-blog"}',
    }));
    expect(response.status).toBe(409);
    const body = JSON.stringify(await response.json());
    expect(body).toContain('IDEMPOTENCY_CONFLICT');
    expect(body).not.toContain('secret-body-hash');
  });

  it('rejects a body larger than 8 KiB before dispatch', async () => {
    const preview = vi.fn();
    const response = await createHttpHandler(deps({ preview }))(new Request('https://unit.test/api/preview', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'idempotency-key': 'abcdefghijklmnop' },
      body: JSON.stringify({ date: 'x'.repeat(8192) }),
    }));
    expect(response.status).toBe(400);
    expect(preview).not.toHaveBeenCalled();
  });

  it('keeps read APIs free of source synchronization writes', async () => {
    const prepare = vi.fn((sql: string) => {
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) throw new Error(`unexpected write: ${sql}`);
      return {
        bind: () => ({
          all: async () => ({ results: [] }),
          first: async () => null,
        }),
        all: async () => ({ results: [] }),
        first: async () => null,
      };
    });
    const app = createApplication({
      DB: { prepare } as unknown as D1Database,
      ADMIN_TOKEN: 'a'.repeat(32),
      APP_CONFIG: appExample,
      SOURCES_CONFIG: sourcesExample,
      APP_ENV: 'test',
      SEND_ENABLED: 'false',
      COLLECT_WORKFLOW: {} as Workflow<never>,
      DAILY_WORKFLOW: {} as Workflow<never>,
    } as unknown as RuntimeEnv);

    await expect(app.read('/api/sources')).resolves.toEqual([]);
    expect(prepare.mock.calls.some(([sql]) => /^\s*INSERT/i.test(String(sql)))).toBe(false);
  });
});
