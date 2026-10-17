import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          restoreMocks: true,
        },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            main: './src/index.ts',
            miniflare: {
              compatibilityDate: '2026-09-21',
              d1Databases: { DB: 'daily-info-test' },
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations(path.resolve('migrations')),
                ADMIN_TOKEN: 'integration-admin-token-32-bytes!!',
                APP_ENV: 'test',
                SEND_ENABLED: 'false',
                APP_CONFIG: await readFile(path.resolve('reference/app.config.example.json'), 'utf8'),
                SOURCES_CONFIG: await readFile(path.resolve('reference/sources.example.json'), 'utf8'),
              },
              workflows: {
                COLLECT_WORKFLOW: { name: 'collect-source', className: 'CollectSourceWorkflow' },
                DAILY_WORKFLOW: { name: 'daily-digest', className: 'DailyDigestWorkflow' },
              },
            },
          })),
        ],
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          setupFiles: ['./tests/integration/setup.ts'],
          restoreMocks: true,
        },
      },
    ],
  },
});
