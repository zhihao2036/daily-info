import type { D1Migration } from '@cloudflare/vitest-plugin';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
      DAILY_WORKFLOW: Workflow<import('../src/domain/contracts').DigestParams>;
      COLLECT_WORKFLOW: Workflow<import('../src/domain/contracts').CollectParams>;
      ADMIN_TOKEN: string;
      APP_ENV: string;
      SEND_ENABLED: string;
      APP_CONFIG: string;
      SOURCES_CONFIG: string;
      BROWSER?: import('../src/collectors/browser-fallback').BrowserBinding;
    }
  }
}

export {};
