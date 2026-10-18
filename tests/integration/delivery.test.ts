import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication, type RuntimeEnv } from '../../src/app';
import { sha256 } from '../../src/db/repositories/shared';
import type { Clock, Sender } from '../../src/domain/contracts';
import { deliverDigest, recoverDeliveries } from '../../src/delivery/service';
import { createTelegramOutbox } from '../../src/delivery/telegram-outbox';
import { renderDigest } from '../../src/editorial/render';
import type { DigestContent } from '../../src/domain/contracts';
import { createTelegramSender } from '../../src/delivery/telegram';

const tables = ['delivery_attempts', 'deliveries', 'digests'] as const;
async function reset(): Promise<void> { await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`))); }

class FakeClock implements Clock { constructor(public value: number) {} now(): number { return this.value; } }
class SequenceClock implements Clock {
  private index = 0;
  constructor(private readonly values: number[]) {}
  now(): number { return this.values[Math.min(this.index++, this.values.length - 1)]!; }
}

async function seedDigest(input: { id?: string; mode?: 'scheduled' | 'preview'; now: number; sendAt?: number; deadline?: number; localDate?: string }): Promise<string> {
  const id = input.id ?? 'digest-send';
  const sendAt = input.sendAt ?? input.now - 1;
  const deadline = input.deadline ?? input.now + 30 * 60_000;
  await env.DB.prepare(`INSERT INTO digests(
    id,profile_id,local_date,timezone,mode,status,window_start_at,cutoff_at,build_deadline_at,send_at,
    send_deadline_at,build_generation,config_snapshot_json,content_json,rendered_text,rendered_html,content_hash,created_at,updated_at
  ) VALUES (?1,'personal',?2,'Asia/Shanghai',?3,'ready',?4,?5,?6,?7,?8,0,'{}','{}','plain','<p>plain</p>','content-hash',?9,?9)`)
    .bind(id, input.localDate ?? '2026-09-21', input.mode ?? 'scheduled', input.now - 172_800_000, input.now - 60_000,
      input.now - 30_000, sendAt, deadline, input.now - 120_000).run();
  return id;
}

async function seedNewsDigest(now: number, count: number): Promise<string> {
  const id = await seedDigest({ now });
  const content: DigestContent = { digestId: id, localDate: '2026-09-21', cutoffAt: now - 60_000,
    windowStartAt: now - 86400_000, coverageNote: null, degradedReason: null, noImportantUpdates: false,
    cards: Array.from({ length: count }, (_, i) => ({ eventId: `e${i}`, eventVersionId: `v${i}`,
      organization: 'Example', product: 'Product', productVersion: '', changeKind: 'release', title: `News ${i + 1}`,
      summary: '摘要'.repeat(250), whyItMatters: '值得关注', suggestedAction: null, evidenceLabel: 'official' as const,
      facts: [], scores: { relevance: 80, impact: 80, evidence: 80, novelty: 80, actionability: 80 }, score: 80,
      sourceVersionIds: [], newInformation: null })) };
  const rendered = renderDigest(content);
  await env.DB.prepare('UPDATE digests SET content_json=?1,rendered_text=?2,rendered_html=?3 WHERE id=?4')
    .bind(JSON.stringify(content), rendered.text, rendered.html, id).run();
  return id;
}

function dependencies(clock: Clock, sender: Sender, overrides: Partial<{ sendEnabled: boolean; channel: 'dummy' | 'cloudflare_email' | 'telegram'; destinationConfigRef: string; destinationKey: string; configurationMatches: boolean }> = {}) {
  return {
    db: env.DB, clock, sender,
    sendEnabled: overrides.sendEnabled ?? true,
    channel: overrides.channel ?? 'cloudflare_email' as const,
    destinationConfigRef: overrides.destinationConfigRef ?? 'personal-primary',
    destinationKey: overrides.destinationKey ?? 'recipient-a',
    configurationMatches: overrides.configurationMatches ?? true,
  };
}

describe('delivery state machine', () => {
  beforeEach(reset);
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['disabled', { sendEnabled: false }],
    ['dummy', { channel: 'dummy' as const }],
  ])('suppresses %s without calling the external sender', async (_name, override) => {
    const now = Date.parse('2026-09-21T00:35:00Z');
    const digestId = await seedDigest({ now });
    const send = vi.fn<Sender['send']>();
    const result = await deliverDigest(digestId, 0, dependencies(new FakeClock(now), { send }, override));
    expect(result.kind).toBe('suppressed');
    expect(send).not.toHaveBeenCalled();
  });

  it('suppresses preview without calling the external sender', async () => {
    const now = Date.parse('2026-09-21T00:35:00Z');
    const digestId = await seedDigest({ now, mode: 'preview' });
    const send = vi.fn<Sender['send']>();
    expect((await deliverDigest(digestId, 0, dependencies(new FakeClock(now), { send }))).kind).toBe('suppressed');
    expect(send).not.toHaveBeenCalled();
  });

  it('lets only one of twenty concurrent claimants call the sender', async () => {
    const now = Date.parse('2026-09-21T00:35:00Z');
    const digestId = await seedDigest({ now });
    const send = vi.fn<Sender['send']>().mockResolvedValue({ kind: 'accepted', providerMessageId: 'message-1', acceptedAt: now + 1 });
    await Promise.all(Array.from({ length: 20 }, () => deliverDigest(digestId, 0, dependencies(new FakeClock(now), { send }))));
    expect(send).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare('SELECT status,attempt_count FROM deliveries').first()).toMatchObject({ status: 'sent', attempt_count: 1 });
    expect((await env.DB.prepare('SELECT status FROM digests WHERE id=?1').bind(digestId).first<{ status: string }>())?.status).toBe('sent');
  });

  it('does not resend an ambiguous accepted request during recovery', async () => {
    const now = Date.parse('2026-09-21T00:35:00Z');
    const digestId = await seedDigest({ now });
    const send = vi.fn<Sender['send']>().mockResolvedValue({ kind: 'uncertain', code: 'CONNECTION_LOST' });
    const deps = dependencies(new FakeClock(now), { send });
    await deliverDigest(digestId, 0, deps);
    await recoverDeliveries(now + 5 * 60_000, deps);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await env.DB.prepare('SELECT status FROM deliveries').first<{ status: string }>())?.status).toBe('uncertain');
  });

  it('sends ten news items as ten messages and never duplicates a completed delivery', async () => {
    const now = Date.parse('2026-09-21T00:35:00Z');
    const digestId = await seedNewsDigest(now, 10);
    let messageId = 40;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toMatch(/\/sendMessage$/);
      const body = JSON.parse(String(init?.body));
      expect(body.text.length).toBeLessThanOrEqual(4096);
      return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId } }));
    });
    let queries = 0;
    const countedDb = { prepare(sql: string) { queries++; return env.DB.prepare(sql); },
      batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements) } as D1Database;
    const sender = createTelegramSender({ botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '987654321',
      destinationConfigRef: 'personal-primary', fetcher, now: () => now,
      outbox: createTelegramOutbox(countedDb), messageIntervalMs: 0 });
    const deps = { ...dependencies(new FakeClock(now), sender, { channel: 'telegram' }), db: countedDb };
    await deliverDigest(digestId, 0, deps);
    expect(queries + fetcher.mock.calls.length).toBeLessThan(50);
    await deliverDigest(digestId, 0, deps);
    expect(fetcher).toHaveBeenCalledTimes(10);
    const texts = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).text);
    expect(texts[0]).toContain('1/10');
    expect(texts[9]).toContain('10/10');
    expect(await env.DB.prepare("SELECT count(*) n FROM telegram_messages WHERE status='sent'").first()).toEqual({ n: 10 });
    expect(await env.DB.prepare('SELECT status FROM digests WHERE id=?1').bind(digestId).first()).toMatchObject({ status: 'sent' });
  });

  it('resumes after a throttled item without repeating news already accepted', async () => {
    const now = Date.parse('2026-09-21T00:35:00Z');
    const clock = new FakeClock(now);
    const digestId = await seedNewsDigest(now, 3);
    const texts: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      texts.push(JSON.parse(String(init?.body)).text);
      if (texts.length === 2) return new Response(JSON.stringify({ parameters: { retry_after: 1 } }), { status: 429 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 40 + texts.length } }));
    });
    const sender = createTelegramSender({ botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '987654321',
      destinationConfigRef: 'personal-primary', fetcher, now: () => clock.now(),
      outbox: createTelegramOutbox(env.DB), messageIntervalMs: 0 });
    const deps = dependencies(clock, sender, { channel: 'telegram' });
    expect(await deliverDigest(digestId, 0, deps)).toMatchObject({ kind: 'rejected', retryable: true });
    clock.value += 1001;
    await recoverDeliveries(clock.value, deps);
    expect(texts).toHaveLength(4);
    expect(texts[0]).toContain('1/3');
    expect(texts[1]).toBe(texts[2]);
    expect(texts[3]).toContain('3/3');
    expect(await env.DB.prepare('SELECT status,attempt_count FROM deliveries').first()).toMatchObject({ status: 'sent', attempt_count: 2 });
    expect(await env.DB.prepare("SELECT count(*) n FROM telegram_messages WHERE status='sent'").first()).toEqual({ n: 3 });
  });

  it('stops after an ambiguous item and does not repeat its accepted prefix', async () => {
    const now = Date.parse('2026-09-21T00:35:00Z');
    const clock = new FakeClock(now);
    const digestId = await seedNewsDigest(now, 3);
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (fetcher.mock.calls.length === 2) throw new Error('response lost');
      return new Response(JSON.stringify({ ok: true, result: { message_id: 41 } }));
    });
    const sender = createTelegramSender({ botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '987654321',
      destinationConfigRef: 'personal-primary', fetcher, now: () => clock.now(),
      outbox: createTelegramOutbox(env.DB), messageIntervalMs: 0 });
    const deps = dependencies(clock, sender, { channel: 'telegram' });
    expect(await deliverDigest(digestId, 0, deps)).toMatchObject({ kind: 'uncertain' });
    clock.value += 300_000;
    await recoverDeliveries(clock.value, deps);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await env.DB.prepare('SELECT status FROM telegram_messages ORDER BY ordinal').all()).results)
      .toEqual([{ status: 'sent' }, { status: 'uncertain' }]);
  });

  it('normalizes a stale in-flight call to uncertain without retrying it', async () => {
    const now = Date.parse('2026-09-21T00:35:00Z');
    const digestId = await seedDigest({ now });
    const send = vi.fn<Sender['send']>().mockResolvedValue({ kind: 'accepted', providerMessageId: 'late', acceptedAt: now });
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO deliveries(id,digest_id,channel,destination_key,destination_config_ref,payload_json,
        payload_hash,status,attempt_id,attempt_count,claimed_at,created_at,updated_at)
        VALUES ('delivery-stale',?1,'cloudflare_email','recipient-a','personal-primary','{}','hash','sending',
          'attempt-stale',1,?2,?2,?2)`).bind(digestId, now - 301_000),
      env.DB.prepare(`INSERT INTO delivery_attempts(id,delivery_id,state,started_at)
        VALUES ('attempt-stale','delivery-stale','calling',?1)`).bind(now - 301_000),
      env.DB.prepare("UPDATE digests SET status='sending' WHERE id=?1").bind(digestId),
    ]);
    await recoverDeliveries(now, dependencies(new FakeClock(now), { send }));
    expect(send).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT status,last_error_code FROM deliveries WHERE id=?1').bind('delivery-stale').first())
      .toMatchObject({ status: 'uncertain', last_error_code: 'STALE_CALLING' });
    expect((await env.DB.prepare('SELECT status FROM digests WHERE id=?1').bind(digestId).first<{ status: string }>())?.status)
      .toBe('uncertain');
  });

  it('rechecks the live clock before each recovered claim and never starts one after 09:00', async () => {
    const deadline = Date.parse('2026-09-21T01:00:00Z');
    const clock = new FakeClock(deadline - 11 * 60_000);
    const firstId = await seedDigest({ id: 'digest-retry-a', now: clock.now(), deadline });
    const secondId = await seedDigest({ id: 'digest-retry-b', now: clock.now(), deadline, localDate: '2026-09-22' });
    const initial: Sender = { async send() { return { kind: 'rejected', retryable: true, code: 'TEMPORARY' }; } };
    await deliverDigest(firstId, 0, dependencies(clock, initial));
    await deliverDigest(secondId, 0, dependencies(clock, initial));
    clock.value = deadline - 5 * 60_000;
    const send = vi.fn<Sender['send']>().mockImplementation(async () => {
      clock.value = deadline + 1;
      return { kind: 'accepted', providerMessageId: 'first-only', acceptedAt: clock.now() };
    });
    await recoverDeliveries(clock.now(), dependencies(clock, { send }));
    expect(send).toHaveBeenCalledTimes(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE status='suppressed'").first<{ count: number }>())?.count).toBe(1);
  });

  it('does not start a new send at 09:00 or for a restored old digest', async () => {
    const deadline = Date.parse('2026-09-21T01:00:00Z');
    const digestId = await seedDigest({ now: deadline - 60_000, deadline });
    const send = vi.fn<Sender['send']>();
    expect((await deliverDigest(digestId, 0, dependencies(new FakeClock(deadline), { send }))).kind).toBe('suppressed');
    expect(send).not.toHaveBeenCalled();
    expect((await env.DB.prepare('SELECT status FROM digests WHERE id=?1').bind(digestId).first<{ status: string }>())?.status).toBe('expired');
  });

  it('does not call the sender when a pre-deadline claim returns after 09:00', async () => {
    const deadline = Date.parse('2026-09-21T01:00:00Z');
    const before = deadline - 10_000;
    const digestId = await seedDigest({ id: 'digest-claim-crosses-deadline', now: before, deadline });
    await env.DB.prepare(`INSERT INTO deliveries(id,digest_id,channel,destination_key,destination_config_ref,payload_json,
      payload_hash,status,created_at,updated_at) VALUES ('delivery-crosses',?1,'cloudflare_email','recipient-a',
      'personal-primary',json(?2),'content-hash','pending',?3,?3)`).bind(digestId, JSON.stringify({
      subject: 'subject', text: 'plain', html: '<p>plain</p>', destinationConfigRef: 'personal-primary', payloadHash: 'content-hash',
    }), before).run();
    const send = vi.fn<Sender['send']>();
    const result = await deliverDigest(digestId, 0, dependencies(new SequenceClock([before, before, deadline + 1]), { send }));
    expect(result).toEqual({ kind: 'suppressed', reason: 'deadline' });
    expect(send).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT status,last_error_code FROM deliveries WHERE id=?1').bind('delivery-crosses').first())
      .toMatchObject({ status: 'failed', last_error_code: 'DEADLINE_BEFORE_CALL' });
    expect((await env.DB.prepare('SELECT status FROM digests WHERE id=?1').bind(digestId).first<{ status: string }>())?.status)
      .toBe('expired');
  });

  it('allows an accepted response claimed at 08:59 to settle after 09:00', async () => {
    const deadline = Date.parse('2026-09-21T01:00:00Z');
    const clock = new FakeClock(deadline - 60_000);
    const digestId = await seedDigest({ now: clock.now(), deadline });
    const send = vi.fn<Sender['send']>().mockImplementation(async () => {
      clock.value = deadline + 1000;
      return { kind: 'accepted', providerMessageId: null, acceptedAt: clock.now() };
    });
    await deliverDigest(digestId, 0, dependencies(clock, { send }));
    expect((await env.DB.prepare('SELECT status,accepted_at FROM digests').first<{ status: string; accepted_at: number }>())).toMatchObject({ status: 'sent', accepted_at: deadline + 1000 });
  });

  it('suppresses instead of redirecting a persisted outbox after the destination changes', async () => {
    const now = Date.parse('2026-09-21T00:35:00Z');
    const digestId = await seedDigest({ now });
    const sender: Sender = { async send() { return { kind: 'rejected', retryable: true, code: 'NOT_ACCEPTED' }; } };
    await deliverDigest(digestId, 0, dependencies(new FakeClock(now), sender, { destinationKey: 'recipient-a' }));
    const send = vi.fn<Sender['send']>();
    const result = await deliverDigest(digestId, 0, dependencies(new FakeClock(now + 1), { send }, { destinationKey: 'recipient-b' }));
    expect(result).toEqual({ kind: 'suppressed', reason: 'config_changed' });
    expect(send).not.toHaveBeenCalled();
  });

  it('suppresses a retryable outbox when the configured delivery channel changes', async () => {
    const now = Date.parse('2026-09-21T00:35:00Z');
    const digestId = await seedDigest({ now });
    const retryable: Sender = { async send() { return { kind: 'rejected', retryable: true, code: 'NOT_ACCEPTED' }; } };
    await deliverDigest(digestId, 0, dependencies(new FakeClock(now), retryable, { channel: 'cloudflare_email' }));
    const send = vi.fn<Sender['send']>();

    expect(await deliverDigest(digestId, 0, dependencies(new FakeClock(now + 1), { send }, { channel: 'telegram' })))
      .toEqual({ kind: 'suppressed', reason: 'config_changed' });
    expect(send).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT status,last_error_code FROM deliveries').first())
      .toMatchObject({ status: 'suppressed', last_error_code: 'CONFIG_CHANGED' });
  });

  it('records a frozen/live destination mismatch before the first outbox send', async () => {
    const now = Date.parse('2026-09-21T00:35:00Z');
    const digestId = await seedDigest({ now });
    const send = vi.fn<Sender['send']>();

    expect(await deliverDigest(digestId, 0, dependencies(new FakeClock(now), { send }, {
      destinationKey: 'frozen-recipient', configurationMatches: false,
    }))).toEqual({ kind: 'suppressed', reason: 'config_changed' });
    expect(send).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT destination_key,status,last_error_code FROM deliveries').first())
      .toMatchObject({ destination_key: 'frozen-recipient', status: 'suppressed', last_error_code: 'CONFIG_CHANGED' });
  });

  it('recovers a Telegram delivery through the configured private-chat sender', async () => {
    const now = Date.parse('2026-09-21T00:35:00Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const digestId = await seedDigest({ now });
    await env.DB.prepare("UPDATE digests SET status='delivery_failed' WHERE id=?1").bind(digestId).run();
    const destinationKey = await sha256('987654321');
    await env.DB.prepare(`INSERT INTO deliveries(id,digest_id,channel,destination_key,destination_config_ref,payload_json,
      payload_hash,status,attempt_count,retryable,next_attempt_at,created_at,updated_at)
      VALUES ('delivery-telegram',?1,'telegram',?2,'personal-primary',json(?3),'content-hash','failed',1,1,?4,?4,?4)`)
      .bind(digestId, destinationKey, JSON.stringify({ subject: 'Daily', text: 'plain', html: '<p>plain</p>',
        destinationConfigRef: 'personal-primary', payloadHash: 'content-hash' }), now - 1).run();
    const request = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', request);
    const appConfig = JSON.parse(env.APP_CONFIG as string);
    appConfig.delivery.channel = 'telegram';
    const runtimeEnv = Object.assign(Object.create(env), {
      APP_ENV: 'production', SEND_ENABLED: 'true', APP_CONFIG: JSON.stringify(appConfig),
      TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz', TELEGRAM_CHAT_ID: '987654321',
    }) as RuntimeEnv;

    await createApplication(runtimeEnv, () => now).scheduled({ cron: '*/5 * * * *', scheduledTime: now,
      noRetry() {} } as unknown as ScheduledController);

    expect(request).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT status,provider_message_id FROM deliveries WHERE id='delivery-telegram'").first())
      .toMatchObject({ status: 'sent', provider_message_id: '99' });
  });
});
