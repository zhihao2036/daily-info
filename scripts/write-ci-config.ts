import { writeFile } from 'node:fs/promises';
import { ciProductionConfig } from '../src/deployment/ci-config.ts';

const config = ciProductionConfig(process.env.WRANGLER_PRODUCTION_CONFIG);
// Wrangler prints individual bindings; GitHub's whole-secret mask does not
// necessarily cover those fragments of a JSON configuration.
if (process.env.GITHUB_ACTIONS === 'true') {
  const masks = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value.length >= 4) masks.add(value);
    if (typeof value === 'object' && value !== null) {
      masks.add(JSON.stringify(value));
      for (const child of Object.values(value)) collect(child);
    }
  };
  collect(JSON.parse(config));
  for (const value of masks) {
    const escaped = value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.log(`::add-mask::${escaped}`);
  }
}
await writeFile('wrangler.production.jsonc', config,
  { flag: 'wx', mode: 0o600 });
console.log('Private production configuration restored for this deployment.');
