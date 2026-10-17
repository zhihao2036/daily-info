import type { AppConfig } from '../domain/contracts';
import { parseAppConfig } from './schema';
import { isTelegramBotToken, isTelegramPrivateChatId } from './telegram';

export function parseSendEnabled(raw: string): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('CONFIG_INVALID:SEND_ENABLED');
}

export function validateAdminToken(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() !== raw || new TextEncoder().encode(raw).byteLength < 32) {
    throw new Error('CONFIG_INVALID:ADMIN_TOKEN');
  }
  return raw;
}

export { validateHttpsEndpoint } from './schema';

export function validateConfig(input: unknown): AppConfig {
  return parseAppConfig(input);
}

export function assertDeliveryConfiguration(input: {
  config: AppConfig;
  appEnv: string;
  sendEnabled: boolean;
  emailBinding: unknown;
  emailFrom?: string;
  emailTo?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}): void {
  if (!input.sendEnabled) return;
  if (input.appEnv !== 'production') throw new Error('CONFIG_INVALID:DELIVERY');
  if (input.config.delivery.channel === 'cloudflare_email') {
    if (input.emailBinding !== undefined && input.emailFrom && input.emailTo) return;
  } else if (input.config.delivery.channel === 'telegram') {
    if (isTelegramBotToken(input.telegramBotToken) && isTelegramPrivateChatId(input.telegramChatId)) return;
  }
  throw new Error('CONFIG_INVALID:DELIVERY');
}
