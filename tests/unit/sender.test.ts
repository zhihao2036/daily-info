import { describe, expect, it, vi } from 'vitest';
import type { AppConfig, DeliveryPayload } from '../../src/domain/contracts';
import { createCloudflareEmailSender } from '../../src/delivery/cloudflare-email';
import { createDummySender } from '../../src/delivery/dummy';
import { createTelegramSender } from '../../src/delivery/telegram';

const payload: DeliveryPayload = { subject: 'Daily', text: 'plain', html: '<p>plain</p>', destinationConfigRef: 'personal-primary', payloadHash: 'hash' };

function config(): AppConfig & { emailFrom: string; emailTo: string } {
  return {
    profileId: 'personal', timezone: 'Asia/Shanghai', schedule: { morning: '07:45', cutoff: '08:00', buildDeadline: '08:25', send: '08:30', close: '09:00' },
    limits: { maxSources: 20, maxPages: 3, pageSize: 30, maxNewBodiesPerRun: 20, fetchTimeoutMs: 10_000, llmTimeoutMs: 30_000, maxResponseBytes: 2_000_000, maxBodyBytes: 128_000, maxModelCharsPerArticle: 12_000, maxCandidates: 200, maxDeepRead: 20, maxEvents: 8, perInstanceConcurrency: 2, maxAttemptsPerStage: 3, maxRepairAttempts: 1 },
    editorial: { targetMinChars: 600, targetMaxChars: 1200, historyDays: 30, lateHours: 48, initialHours: 48, threshold: 60 },
    llm: { baseUrl: 'https://llm.example.com/v1', model: 'm', promptVersion: 'v1', jsonMode: 'none', maxOutputTokens: 100, tokenizer: 'conservative_utf8', inputMicrousdPerMillionTokens: 1, outputMicrousdPerMillionTokens: 1, pricingIncludesAllBillableTokens: true },
    budget: { dayMicrousd: 1, monthMicrousd: 1 }, delivery: { channel: 'cloudflare_email', destinationConfigRef: 'personal-primary' },
    emailFrom: 'digest@example.com', emailTo: 'me@example.net',
  };
}

describe('send adapters', () => {
  it('dummy sender always suppresses without an external call', async () => {
    await expect(createDummySender().send(payload, 'attempt', new AbortController().signal))
      .resolves.toEqual({ kind: 'suppressed', reason: 'dummy' });
  });

  it('uses the fixed Cloudflare Email addresses and accepts a missing provider id', async () => {
    const send = vi.fn().mockResolvedValue({});
    const sender = createCloudflareEmailSender({ send }, config());
    await expect(sender.send(payload, 'attempt-1', new AbortController().signal))
      .resolves.toMatchObject({ kind: 'accepted', providerMessageId: null });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: 'digest@example.com', to: 'me@example.net', subject: 'Daily' }));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends one bounded plain-text Telegram message to the fixed private chat', async () => {
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    const sender = createTelegramSender({
      botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '987654321',
      destinationConfigRef: 'personal-primary', now: () => 1234,
      fetcher: async (input, init) => {
        requestedUrl = String(input);
        requestedInit = init;
        return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      },
    });

    await expect(sender.send(payload, 'attempt-telegram', new AbortController().signal))
      .resolves.toEqual({ kind: 'accepted', providerMessageId: '42', acceptedAt: 1234 });
    expect(requestedUrl).toBe('https://api.telegram.org/bot123456:abcdefghijklmnopqrstuvwxyz/sendMessage');
    expect(requestedInit?.method).toBe('POST');
    expect(JSON.parse(String(requestedInit?.body))).toEqual({ chat_id: '987654321', text: 'Daily\n\nplain' });
  });

  it('rejects an oversized Telegram message before any external request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const sender = createTelegramSender({
      botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '987654321',
      destinationConfigRef: 'personal-primary', fetcher,
    });

    await expect(sender.send({ ...payload, text: '界'.repeat(4096) }, 'attempt', new AbortController().signal))
      .resolves.toEqual({ kind: 'rejected', retryable: false, code: 'TELEGRAM_MESSAGE_TOO_LONG' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('classifies explicit Telegram throttling as retryable and network ambiguity as uncertain', async () => {
    const throttled = createTelegramSender({
      botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '987654321', destinationConfigRef: 'personal-primary',
      fetcher: async () => new Response(JSON.stringify({ ok: false, error_code: 429,
        parameters: { retry_after: 7 } }), { status: 429 }),
    });
    await expect(throttled.send(payload, 'attempt', new AbortController().signal))
      .resolves.toEqual({ kind: 'rejected', retryable: true, code: 'TELEGRAM_HTTP_429', retryAfterMs: 7000 });

    const ambiguous = createTelegramSender({
      botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '987654321', destinationConfigRef: 'personal-primary',
      fetcher: async () => { throw new Error('connection reset'); },
    });
    await expect(ambiguous.send(payload, 'attempt', new AbortController().signal))
      .resolves.toEqual({ kind: 'uncertain', code: 'TELEGRAM_RESPONSE_UNKNOWN' });
  });

  it('keeps the Telegram timeout active while reading the response body', async () => {
    const sender = createTelegramSender({
      botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '987654321',
      destinationConfigRef: 'personal-primary', timeoutMs: 5,
      fetcher: async (_input, init) => ({
        status: 200,
        ok: true,
        json: () => new Promise((_resolve, reject) => {
          const requestSignal = init?.signal as AbortSignal;
          requestSignal.addEventListener('abort', () => reject(new Error('body aborted')), { once: true });
        }),
      }) as Response,
    });

    const result = await Promise.race([
      sender.send(payload, 'attempt', new AbortController().signal),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 50)),
    ]);
    expect(result).toEqual({ kind: 'uncertain', code: 'TELEGRAM_RESPONSE_INVALID' });
  });

  it.each(['', 'not-an-id', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'treats malformed Telegram message_id %s as an uncertain response', async (messageId) => {
      const sender = createTelegramSender({
        botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '987654321',
        destinationConfigRef: 'personal-primary',
        fetcher: async () => new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 }),
      });
      await expect(sender.send(payload, 'attempt', new AbortController().signal))
        .resolves.toEqual({ kind: 'uncertain', code: 'TELEGRAM_RESPONSE_INVALID' });
    },
  );

  it('accepts exactly 4096 Unicode code points and retries an explicit 5xx response', async () => {
    const acceptedFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 }));
    const accepted = createTelegramSender({
      botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '987654321',
      destinationConfigRef: 'personal-primary', fetcher: acceptedFetch,
    });
    await expect(accepted.send({ ...payload, subject: 'D', text: '🚀'.repeat(4093) }, 'attempt', new AbortController().signal))
      .resolves.toMatchObject({ kind: 'accepted', providerMessageId: '7' });
    expect(acceptedFetch).toHaveBeenCalledTimes(1);

    const unavailable = createTelegramSender({
      botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '987654321',
      destinationConfigRef: 'personal-primary', fetcher: async () => new Response('', { status: 503 }),
    });
    await expect(unavailable.send(payload, 'attempt', new AbortController().signal))
      .resolves.toEqual({ kind: 'rejected', retryable: true, code: 'TELEGRAM_HTTP_503' });
  });

  it('rejects non-private chat IDs and propagates an already-aborted request signal', async () => {
    expect(() => createTelegramSender({
      botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '-100123', destinationConfigRef: 'personal-primary',
    })).toThrow('CONFIG_INVALID:TELEGRAM');

    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal?.aborted).toBe(true);
      throw new DOMException('aborted', 'AbortError');
    });
    const sender = createTelegramSender({
      botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '987654321',
      destinationConfigRef: 'personal-primary', fetcher,
    });
    const controller = new AbortController();
    controller.abort('caller-stopped');
    await expect(sender.send(payload, 'attempt', controller.signal))
      .resolves.toEqual({ kind: 'uncertain', code: 'TELEGRAM_RESPONSE_UNKNOWN' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
