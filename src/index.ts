import { createHttpHandler } from './api/router';
import { createApplication, type RuntimeEnv } from './app';
export { CollectSourceWorkflow } from './workflows/collect-source';
export { DailyDigestWorkflow } from './workflows/daily-digest';

export interface Env extends RuntimeEnv {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'GET' && new URL(request.url).pathname === '/healthz') {
      try {
        createApplication(env);
        const database = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
        if (database?.ok !== 1) throw new Error('DATABASE_UNAVAILABLE');
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
        });
      } catch {
        return new Response(JSON.stringify({ ok: false }), {
          status: 503,
          headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
        });
      }
    }
    try {
      const app = createApplication(env);
      return createHttpHandler({ adminToken: env.ADMIN_TOKEN, collect: app.collect, preview: app.preview, read: app.read })(request);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('CONFIG_INVALID')) {
        return new Response(JSON.stringify({ error: { code: 'CONFIG_INVALID', message: 'The service configuration is invalid.',
          requestId: crypto.randomUUID(), retryable: false } }), {
          status: 422,
          headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
        });
      }
      throw error;
    }
  },
  async scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(createApplication(env).scheduled(controller));
  },
};
