import { readFile, readdir } from 'node:fs/promises';
import process from 'node:process';
import { existsSync } from 'node:fs';
import { parseAppConfig, validateHttpsEndpoint, validateSourcesConfig } from '../src/config/schema.ts';
import { isTelegramBotToken, isTelegramPrivateChatId } from '../src/config/telegram.ts';
import { assertAllowedUrl } from '../src/collectors/normalize.ts';

type Check = { name: string; status: 'pass' | 'warn' | 'fail' | 'skip'; detail: string };
const checks: Check[] = [];
const argv = process.argv.slice(2);
const args = new Set(argv);
const configFlag = argv.find((value) => value.startsWith('--config='));
const configIndex = argv.indexOf('--config');
const selectedConfig = configFlag?.slice('--config='.length) || (configIndex >= 0 ? argv[configIndex + 1] : undefined);
const configFiles = selectedConfig === undefined ? [existsSync('wrangler.production.jsonc') ? 'wrangler.production.jsonc' : 'wrangler.example.jsonc'] : [selectedConfig];

const selectedSources: Array<{ id: string; url: string; enabled: boolean; allowedHosts: string[] }> = [];
const selectedDeliveryChannels = new Set<string>();

async function checkSource(source: { url: string; allowedHosts: string[] }): Promise<Response> {
  let current = assertAllowedUrl(source.url, source.allowedHosts);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(current, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (response.status < 300 || response.status >= 400 || response.status === 304) return response;
    const location = response.headers.get('location');
    if (location === null) throw new Error('HTTP_REDIRECT_INVALID');
    if (redirects === 3) throw new Error('HTTP_TOO_MANY_REDIRECTS');
    current = assertAllowedUrl(new URL(location, current).toString(), source.allowedHosts);
  }
  throw new Error('HTTP_TOO_MANY_REDIRECTS');
}

try {
  const migrations = (await readdir('migrations')).filter((name) => name.endsWith('.sql'));
  checks.push({ name: 'D1 migrations', status: migrations.length > 0 ? 'pass' : 'fail', detail: `${migrations.length} migration file(s)` });
} catch (error) {
  checks.push({ name: 'D1 migrations', status: 'fail', detail: error instanceof Error ? error.message : String(error) });
}

for (const file of configFiles) {
  try {
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text) as {
      vars?: { APP_CONFIG?: unknown; SOURCES_CONFIG?: unknown; SEND_ENABLED?: unknown };
      d1_databases?: Array<{ binding?: unknown; database_id?: unknown; migrations_dir?: unknown }>;
      workflows?: Array<{ binding?: unknown }>;
      browser?: { binding?: unknown };
    };
    const appConfig = parseAppConfig(parsed.vars?.APP_CONFIG);
    selectedDeliveryChannels.add(appConfig.delivery.channel);
    const sources = validateSourcesConfig(parsed.vars?.SOURCES_CONFIG);
    if (Buffer.byteLength(JSON.stringify(parsed.vars?.SOURCES_CONFIG), 'utf8') > 5120) throw new Error('SOURCES_CONFIG_BINDING_TOO_LARGE');
    selectedSources.push(...sources.sources);
    if (parsed.vars?.SEND_ENABLED !== 'false' && parsed.vars?.SEND_ENABLED !== 'true') throw new Error('SEND_ENABLED_INVALID');
    const hasDb = parsed.d1_databases?.some((binding) => binding.binding === 'DB' && binding.migrations_dir === 'migrations') === true;
    const workflowBindings = new Set(parsed.workflows?.map((binding) => binding.binding));
    const hasWorkflows = workflowBindings.has('COLLECT_WORKFLOW') && workflowBindings.has('DAILY_WORKFLOW');
    const hasBrowser = parsed.browser?.binding === 'BROWSER';
    const unresolved = /REPLACE_WITH|DEPLOYMENT_INPUT_REQUIRED|00000000-0000-0000-0000-000000000000/.test(text);
    checks.push({ name: `${file} schema/bindings`, status: hasDb && hasWorkflows && hasBrowser && !unresolved ? 'pass' : unresolved && hasDb && hasWorkflows && hasBrowser ? 'warn' : 'fail',
      detail: unresolved ? 'runtime schemas pass; D1 database ID is still a deployment input' : 'runtime schemas, DB, Workflow, and Browser Run bindings pass' });
  } catch (error) {
    checks.push({ name: `${file} schema/bindings`, status: 'fail', detail: error instanceof Error ? error.message : String(error) });
  }
}

if (args.has('--check-sources')) {
  for (const source of selectedSources.filter((item) => item.enabled)) {
    try {
      const response = await checkSource(source);
      checks.push({ name: `source ${source.id}`, status: response.ok ? 'pass' : 'fail', detail: `HTTP ${response.status}` });
    } catch (error) {
      checks.push({ name: `source ${source.id}`, status: 'fail', detail: error instanceof Error ? error.message : String(error) });
    }
  }
  if (!selectedSources.some((item) => item.enabled)) checks.push({ name: 'live sources', status: 'skip', detail: 'no source is enabled in the selected Wrangler config; discovery is not runtime verification' });
} else {
  checks.push({ name: 'live sources', status: 'skip', detail: 'use --check-sources after explicitly enabling verified sources' });
}

if (args.has('--check-llm')) {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  const inputRate = Number(process.env.LLM_INPUT_MICROUSD_PER_MILLION);
  const outputRate = Number(process.env.LLM_OUTPUT_MICROUSD_PER_MILLION);
  const budget = Number(process.env.DOCTOR_LLM_BUDGET_MICROUSD);
  const estimate = Number.isSafeInteger(inputRate) && Number.isSafeInteger(outputRate)
    ? Math.max(1, Math.ceil((100 * inputRate + outputRate) / 1_000_000)) : Number.NaN;
  if (!baseUrl || !apiKey || !model || !Number.isFinite(estimate) || !Number.isSafeInteger(budget) || budget < estimate) {
    checks.push({ name: 'LLM minimal call', status: 'fail', detail: 'requires LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, integer rates, and DOCTOR_LLM_BUDGET_MICROUSD covering the estimate' });
  } else {
    try {
      const safeBaseUrl = validateHttpsEndpoint(baseUrl);
      const url = new URL(`${safeBaseUrl.replace(/\/$/, '')}/chat/completions`);
      const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with JSON: {"ok":true}' }], max_tokens: 1 }), signal: AbortSignal.timeout(60_000) });
      checks.push({ name: 'LLM minimal call', status: response.ok ? 'pass' : 'fail', detail: `HTTP ${response.status}; estimated ceiling ${estimate} microUSD` });
    } catch (error) {
      checks.push({ name: 'LLM minimal call', status: 'fail', detail: error instanceof Error ? error.message : String(error) });
    }
  }
} else {
  checks.push({ name: 'LLM minimal call', status: 'skip', detail: 'use --check-llm only with explicit budget approval' });
}
if (selectedDeliveryChannels.has('telegram')) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const absent = botToken === undefined && chatId === undefined;
  const valid = isTelegramBotToken(botToken) && isTelegramPrivateChatId(chatId);
  checks.push({ name: 'Telegram local static config', status: valid ? 'pass' : absent ? 'warn' : 'fail',
    detail: valid ? 'locally supplied bot token and private chat ID have valid shapes' : absent
      ? 'Telegram secrets were not supplied to this local doctor process; no message was sent'
      : 'locally supplied Telegram token or private chat ID has an invalid shape; no value was printed' });
}
if (selectedDeliveryChannels.has('cloudflare_email')) {
  const emailConfigured = Boolean(process.env.EMAIL_FROM && process.env.EMAIL_TO);
  checks.push({ name: 'email static config', status: emailConfigured ? 'pass' : 'warn', detail: emailConfigured ? 'one sender and one destination are present in environment' : 'selected config uses email but EMAIL_FROM/EMAIL_TO are absent; doctor never sends mail' });
}
if ([...selectedDeliveryChannels].every((channel) => channel === 'dummy')) {
  checks.push({ name: 'delivery static config', status: 'skip', detail: 'selected configs use dummy; doctor never sends messages' });
}

for (const check of checks) console.log(`${check.status.toUpperCase().padEnd(4)} ${check.name}: ${check.detail}`);
if (checks.some((check) => check.status === 'fail')) process.exitCode = 1;
