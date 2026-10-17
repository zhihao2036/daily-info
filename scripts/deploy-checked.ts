import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import process from 'node:process';
import { workerUrlFor } from '../src/deployment/worker-url.ts';

const exec = promisify(execFile);
const target = process.argv.slice(2).find((argument) => argument !== '--');
if (target !== 'production') throw new Error('Usage: pnpm deploy:checked -- production');
const config = `wrangler.${target}.jsonc`;
const parsed = JSON.parse(await readFile(config, 'utf8')) as { name?: unknown; workers_dev?: boolean; d1_databases?: Array<{ database_id?: unknown }> };
if (typeof parsed.name !== 'string' || parsed.d1_databases?.some((db) => typeof db.database_id !== 'string' || /DEPLOYMENT_INPUT_REQUIRED|REPLACE_WITH|00000000-0000-0000-0000-000000000000/.test(db.database_id))) {
  throw new Error('DEPLOY_CONFIG_INVALID:D1_ID');
}
const workerUrl = parsed.workers_dev === false ? null : workerUrlFor(parsed.name, process.env.WORKER_URL ?? '');

async function run(file: string, args: string[]): Promise<string> {
  const result = await exec(file, args, { env: process.env });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout;
}

await run('pnpm', ['run', 'doctor', '--', '--config', config]);
const secrets = JSON.parse(await run('pnpm', ['exec', 'wrangler', 'secret', 'list', '--config', config, '--format', 'json'])) as Array<{ name?: unknown }>;
if (!secrets.some((entry) => entry.name === 'ADMIN_TOKEN')) throw new Error('DEPLOY_CONFIG_INVALID:ADMIN_TOKEN_SECRET');
await run('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', config]);
await run('pnpm', ['exec', 'wrangler', 'deploy', '--config', config]);
if (workerUrl !== null) {
  const health = await fetch(new URL('/healthz', workerUrl), { signal: AbortSignal.timeout(15_000) });
  if (!health.ok || (await health.text()) !== '{"ok":true}') throw new Error(`DEPLOY_HEALTHCHECK_FAILED:${health.status}`);
  console.log(`Deployment verified: ${workerUrl}`);
} else {
  console.log('Deployment completed; public HTTP health check skipped because workers_dev is disabled.');
}
