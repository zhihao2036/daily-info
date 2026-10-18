import type { Sender, SendResult } from '../domain/contracts';
import type { TelegramOutbox } from './telegram-outbox';
import { isTelegramBotToken, isTelegramPrivateChatId } from '../config/telegram';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface TelegramSenderConfig {
  botToken: string;
  chatId: string;
  destinationConfigRef: string;
  fetcher?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  outbox?: TelegramOutbox;
  messageIntervalMs?: number;
}

export function createTelegramSender(config: TelegramSenderConfig): Sender {
  if (!isTelegramBotToken(config.botToken)
    || !isTelegramPrivateChatId(config.chatId)
    || config.destinationConfigRef.trim() === '') throw new Error('CONFIG_INVALID:TELEGRAM');
  const fetcher = config.fetcher ?? fetch;
  const now = config.now ?? (() => Date.now());
  async function sendOne(text: string, signal: AbortSignal): Promise<SendResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('TELEGRAM_TIMEOUT'), config.timeoutMs ?? 15_000);
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetcher(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: config.chatId, text }),
        signal: controller.signal,
      });
      if (response.status === 429) {
        let retryAfterMs = 60_000;
        try {
          const body = await response.json() as { parameters?: { retry_after?: unknown } };
          if (typeof body.parameters?.retry_after === 'number' && Number.isSafeInteger(body.parameters.retry_after)
            && body.parameters.retry_after > 0) retryAfterMs = Math.min(body.parameters.retry_after * 1000, 3_600_000);
        } catch { /* The explicit 429 remains safely retryable with the default delay. */ }
        return { kind: 'rejected', retryable: true, code: 'TELEGRAM_HTTP_429', retryAfterMs };
      }
      if (response.status >= 500) {
        return { kind: 'rejected', retryable: true, code: `TELEGRAM_HTTP_${response.status}` };
      }
      if (!response.ok) {
        return { kind: 'rejected', retryable: false, code: `TELEGRAM_HTTP_${response.status}` };
      }
      try {
        const body = await response.json() as { ok?: unknown; result?: { message_id?: unknown } };
        const messageId = body.result?.message_id;
        if (body.ok !== true || !Number.isSafeInteger(messageId) || Number(messageId) <= 0) {
          return { kind: 'uncertain', code: 'TELEGRAM_RESPONSE_INVALID' };
        }
        return { kind: 'accepted', providerMessageId: String(messageId), acceptedAt: now() };
      } catch {
        return { kind: 'uncertain', code: 'TELEGRAM_RESPONSE_INVALID' };
      }
    } catch {
      return { kind: 'uncertain', code: 'TELEGRAM_RESPONSE_UNKNOWN' };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
  }
  return {
    async send(payload, attemptId, signal) {
      if (payload.destinationConfigRef !== config.destinationConfigRef) return { kind: 'suppressed', reason: 'config_changed' };
      const messages = payload.messages ?? [`${payload.subject}\n\n${payload.text}`];
      if (messages.length === 0 || messages.length > 10 || messages.some(text => text.length === 0 || text.length > 4096)) {
        return { kind: 'rejected', retryable: false, code: 'TELEGRAM_MESSAGE_TOO_LONG' };
      }
      const outbox = config.outbox;
      const deliveryId = payload.deliveryId;
      if (messages.length > 1 && (!outbox || !deliveryId)) {
        return { kind: 'rejected', retryable: false, code: 'TELEGRAM_OUTBOX_REQUIRED' };
      }
      let last: SendResult = { kind: 'uncertain', code: 'TELEGRAM_NO_MESSAGES' };
      let requested = false;
      for (const [ordinal, text] of messages.entries()) {
        try {
          // Pace a private chat and re-check the durable claim/deadline after waiting.
          if (requested && (config.messageIntervalMs ?? 1100) > 0) {
            await new Promise<void>((resolve, reject) => {
              const abort = () => { clearTimeout(timer); reject(new Error('TELEGRAM_ABORTED')); };
              const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, config.messageIntervalMs ?? 1100);
              if (signal.aborted) abort();
              else signal.addEventListener('abort', abort, { once: true });
            });
          }
          if (outbox && deliveryId) {
            const claim = await outbox.claim(deliveryId, ordinal, text, attemptId, now());
            if (claim !== 'claimed') {
              if (claim.kind !== 'accepted') return claim;
              last = claim;
              continue;
            }
          }
          last = await sendOne(text, signal);
          requested = true;
          if (outbox && deliveryId) await outbox.settle(deliveryId, ordinal, attemptId, last, now());
          if (last.kind !== 'accepted') return last;
        } catch {
          return { kind: 'uncertain', code: 'TELEGRAM_PROGRESS_UNKNOWN' };
        }
      }
      return last;
    },
  };
}
