import { constants, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// Never overwrite existing personal configuration, including a live deployment.
if (existsSync('wrangler.production.jsonc')) {
  console.log('Kept existing wrangler.production.jsonc');
} else {
  copyFileSync('wrangler.example.jsonc', 'wrangler.production.jsonc', constants.COPYFILE_EXCL);
  console.log('Created wrangler.production.jsonc; replace the zero D1 ID before deploying.');
}
const token = Array.from(randomBytes(32), byte => byte.toString(16).padStart(2, '0')).join('');
for (const [source, target] of [['.env.example', '.env'], ['.dev.vars.example', '.dev.vars']]) {
  if (existsSync(target!)) {
    console.log(`Kept existing ${target}`);
    continue;
  }
  const content = readFileSync(source!, 'utf8').replace('REPLACE_WITH_RANDOM_ADMIN_TOKEN', token);
  writeFileSync(target!, content, { flag: 'wx', mode: 0o600 });
  console.log(`Created ${target}; credentials are never printed.`);
}
