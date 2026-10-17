import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { validateSourcesConfig, parseAppConfig } from '../src/config/schema.ts';

const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = paths.filter(path => path.startsWith('.private/') || path.endsWith('.bundle')
  || path === 'wrangler.production.jsonc' || /(?:^|\/)\.env(?:\.|$)/.test(path) && path !== '.env.example'
  || /(?:^|\/)\.dev\.vars(?:\.|$)/.test(path) && path !== '.dev.vars.example'
  || /wrangler\..*\.local\.jsonc$/.test(path));
if (forbidden.length > 0) throw new Error(`PRIVATE_FILES_TRACKED:${forbidden.join(',')}`);
const credential = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{24,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}|\b\d{8,12}:[A-Za-z0-9_-]{30,}/;
for (const path of paths) {
  let data: string;
  try { data = readFileSync(path, 'utf8'); } catch { continue; }
  if (credential.test(data)) throw new Error(`CREDENTIAL_PATTERN:${path}`);
  if (/https:\/\/[a-z0-9-]+\.(?!example\.|YOUR_SUBDOMAIN\.)[a-z0-9-]+\.workers\.dev/i.test(data)) {
    throw new Error(`PERSONAL_WORKER_URL:${path}`);
  }
}
const template = JSON.parse(readFileSync('wrangler.example.jsonc', 'utf8'));
const app = parseAppConfig(template.vars.APP_CONFIG);
const sources = validateSourcesConfig(template.vars.SOURCES_CONFIG);
if (template.vars.SEND_ENABLED !== 'false' || app.delivery.channel !== 'dummy'
  || template.triggers.crons.length > 0 || sources.sources.some(source => source.enabled)
  || app.budget.dayMicrousd !== 0 || app.budget.monthMicrousd !== 0
  || app.llm.inputMicrousdPerMillionTokens !== null || app.llm.outputMicrousdPerMillionTokens !== null
  || template.d1_databases.some((db: { database_id: string }) => db.database_id !== '00000000-0000-0000-0000-000000000000')
  || template.account_id !== undefined) throw new Error('PUBLIC_TEMPLATE_UNSAFE');
if (Buffer.byteLength(JSON.stringify(template.vars.SOURCES_CONFIG), 'utf8') > 5120) throw new Error('SOURCES_BINDING_TOO_LARGE');
console.log('Public-file checks passed; paid calls, sources, Cron and real delivery default off.');
