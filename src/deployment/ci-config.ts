const RUNTIME_SECRETS = ['ADMIN_TOKEN','LLM_API_KEY','GITHUB_TOKEN','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','EMAIL_FROM','EMAIL_TO'];

/** Validate without echoing any part of a malformed secret into public Actions logs. */
export function ciProductionConfig(raw: string | undefined): string {
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw ?? '');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    value = parsed as Record<string, unknown>;
    if (typeof value.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value.name)) throw new Error();
    const vars = value.vars as Record<string, unknown> | undefined;
    if (vars?.APP_ENV !== 'production' || typeof vars.SEND_ENABLED !== 'string'
      || !['true','false'].includes(vars.SEND_ENABLED)) throw new Error();
    if (RUNTIME_SECRETS.some(name => name in vars)) throw new Error();
    if (!Array.isArray(value.d1_databases) || !value.d1_databases.some(db =>
      typeof db === 'object' && db !== null && db.binding === 'DB'
      && typeof db.database_id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(db.database_id)
      && db.database_id !== '00000000-0000-0000-0000-000000000000')) throw new Error();
  } catch {
    throw new Error('CI_CONFIG_INVALID: supply the private production JSON configuration; keep runtime credentials in Cloudflare Secrets.');
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}
