import { writeFile } from 'node:fs/promises';
import { ciProductionConfig } from '../src/deployment/ci-config.ts';

await writeFile('wrangler.production.jsonc', ciProductionConfig(process.env.WRANGLER_PRODUCTION_CONFIG),
  { flag: 'wx', mode: 0o600 });
console.log('Private production configuration restored for this deployment.');
