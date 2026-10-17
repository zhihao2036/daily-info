import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';

const configured = process.env.TEST_STATE_DIR;
if (!configured) throw new Error('TEST_STATE_DIR is required for isolated local D1 migrations');
const stateDir = resolve(configured);
const repositoryRoot = resolve('.');
const relativeToRepository = relative(repositoryRoot, stateDir);
const insideRepository = relativeToRepository === ''
  || (!relativeToRepository.startsWith('..') && !isAbsolute(relativeToRepository));
if (stateDir === '/' || insideRepository || existsSync(stateDir)) {
  throw new Error('TEST_STATE_DIR must be a new dedicated directory outside the repository');
}
const result = spawnSync('wrangler', [
  'd1', 'migrations', 'apply', 'DB', '--local', '--config', 'wrangler.production.jsonc', '--persist-to', stateDir,
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
