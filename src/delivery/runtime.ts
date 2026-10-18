import type { AppConfig, Sender } from '../domain/contracts';
import { createCloudflareEmailSender } from './cloudflare-email';
import { createDummySender } from './dummy';
import { createTelegramSender } from './telegram';
import { createTelegramOutbox } from './telegram-outbox';

export interface DeliveryRuntimeBindings {
  DB?: D1Database;
  EMAIL?: unknown;
  EMAIL_FROM?: string;
  EMAIL_TO?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export function deliveryDestinationValue(app: AppConfig, bindings: DeliveryRuntimeBindings): string {
  if (app.delivery.channel === 'cloudflare_email') return bindings.EMAIL_TO ?? app.delivery.destinationConfigRef;
  if (app.delivery.channel === 'telegram') return bindings.TELEGRAM_CHAT_ID ?? app.delivery.destinationConfigRef;
  return app.delivery.destinationConfigRef;
}

export function createRuntimeSender(app: AppConfig, bindings: DeliveryRuntimeBindings): Sender {
  if (app.delivery.channel === 'cloudflare_email' && bindings.EMAIL !== undefined
    && bindings.EMAIL_FROM !== undefined && bindings.EMAIL_TO !== undefined) {
    return createCloudflareEmailSender(bindings.EMAIL, { ...app, emailFrom: bindings.EMAIL_FROM, emailTo: bindings.EMAIL_TO });
  }
  if (app.delivery.channel === 'telegram' && bindings.TELEGRAM_BOT_TOKEN !== undefined
    && bindings.TELEGRAM_CHAT_ID !== undefined) {
    return createTelegramSender({ botToken: bindings.TELEGRAM_BOT_TOKEN, chatId: bindings.TELEGRAM_CHAT_ID,
      destinationConfigRef: app.delivery.destinationConfigRef,
      ...(bindings.DB ? { outbox: createTelegramOutbox(bindings.DB) } : {}) });
  }
  return createDummySender();
}
