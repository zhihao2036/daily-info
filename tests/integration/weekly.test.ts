import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication, type RuntimeEnv } from '../../src/app';
import { buildWeeklyReport, ensureWeeklyReport, weeklyTimes } from '../../src/editorial/weekly';
import { DigestRepository } from '../../src/db/repositories/digests';
import { digestTimes } from '../../src/scheduler/time';
import { deliverDigest, recoverDeliveries } from '../../src/delivery/service';
import { createTelegramSender } from '../../src/delivery/telegram';
import { createTelegramOutbox } from '../../src/delivery/telegram-outbox';

const now = Date.parse('2026-10-19T00:00:00Z');
const tables = ['delivery_attempts','deliveries','digest_events','digest_candidates','llm_calls','request_keys',
  'item_versions','collection_pages','items','source_leases','runs','digests','sources'];
beforeEach(async () => { await env.DB.batch(tables.map(table => env.DB.prepare(`DELETE FROM ${table}`))); });

async function seedDigest(id: string, date: string, status = 'sent', mode = 'scheduled') {
  await env.DB.prepare(`INSERT INTO digests(id,profile_id,local_date,timezone,mode,status,
    window_start_at,cutoff_at,build_deadline_at,send_at,send_deadline_at,config_snapshot_json,
    content_json,created_at,updated_at) VALUES (?1,'personal',?2,'Asia/Shanghai',?3,?4,0,1,2,3,4,'{}',?5,?6,?6)`)
    .bind(id, date, mode, status === 'sent' ? 'sent' : 'uncertain', JSON.stringify({ cards: [
      { eventId: id, title: `新闻 ${id}`, sourceVersionIds: ['v'] },
    ] }), now).run();
  await env.DB.prepare(`INSERT INTO deliveries(id,digest_id,channel,destination_key,destination_config_ref,
    payload_json,payload_hash,status,created_at,updated_at) VALUES (?1,?2,'telegram','key','ref','{}','hash',?3,?4,?4)`)
    .bind(`delivery-${id}`, id, status, now).run();
}

async function seedSource() {
  await env.DB.prepare(`INSERT INTO sources(id,kind,name,url,config_json,config_hash,created_at,updated_at)
    VALUES ('s','rss','S','https://example.com/feed','{}','hash',0,0)`).run();
  await env.DB.prepare(`INSERT INTO runs(id,job_key,workflow_id,kind,state,scheduled_at,deadline_at,params_json,created_at,updated_at)
    VALUES ('r','r','r','collect','completed',0,1,'{}',0,0)`).run();
  await env.DB.prepare(`INSERT INTO collection_pages(run_id,page_no,request_cursor_json,status) VALUES ('r',0,'{}','committed')`).run();
  await env.DB.prepare(`INSERT INTO items(id,source_id,external_key,canonical_url,first_seen_at,last_seen_at)
    VALUES ('i','s','i','https://example.com/news',0,0)`).run();
  await env.DB.prepare(`INSERT INTO item_versions(id,item_id,revision,ingest_key,collection_run_id,collection_page_no,
    content_hash,title,canonical_url,ingested_at,body_text,quality,metadata_json)
    VALUES ('v','i',1,'v','r',0,'hash','Title','https://example.com/news',0,'Body','full','{}')`).run();
}

describe('weekly production flow', () => {
  it('keeps the daily collection window anchored to the last daily delivery', async () => {
    await seedSource();
    await seedDigest('last-daily', '2026-10-18');
    const app = JSON.parse(env.APP_CONFIG as string);
    const weekly = await ensureWeeklyReport({ db: env.DB, app, sources: [], times: weeklyTimes(now)!, destinationKey: 'key', now });
    await env.DB.prepare("UPDATE digests SET status='sent' WHERE id=?1").bind(weekly).run();
    await env.DB.prepare(`INSERT INTO deliveries(id,digest_id,channel,destination_key,destination_config_ref,
      payload_json,payload_hash,status,created_at,updated_at) VALUES ('weekly-delivery',?1,'telegram','key','ref','{}','hash','sent',?2,?2)`)
      .bind(weekly, now).run();
    const daily = await new DigestRepository(env.DB, { now: () => now }).ensure({ profileId: 'personal',
      mode: 'scheduled', times: digestTimes(now), configSnapshot: { app, sources: [] }, now });
    expect(await env.DB.prepare('SELECT window_start_at,report_kind FROM digests WHERE id=?1').bind(daily.id).first())
      .toEqual({ window_start_at: 1, report_kind: 'daily' });
  });

  it('selects only sent daily reports within the previous calendar week', async () => {
    await seedSource();
    await seedDigest('sunday', '2026-10-18');
    await seedDigest('older', '2026-10-11');
    await seedDigest('today', '2026-10-19');
    await seedDigest('preview', '2026-10-17', 'sent', 'preview');
    await seedDigest('uncertain', '2026-10-16', 'uncertain');
    const report = await buildWeeklyReport(env.DB, 'personal', weeklyTimes(now)!);
    expect(report.entries.map(entry => entry.eventId)).toEqual(['sunday']);
    expect(report.text).toContain('https://example.com/news');
    const app = JSON.parse(env.APP_CONFIG as string);
    const id = await ensureWeeklyReport({ db: env.DB, app, sources: [], times: weeklyTimes(now)!, destinationKey: 'key', now });
    // A weekly report on Monday cannot take the daily report's identity or move its window.
    const daily = await new DigestRepository(env.DB, { now: () => now }).ensure({ profileId: 'personal',
      mode: 'scheduled', times: digestTimes(now), configSnapshot: { app, sources: [] }, now });
    expect(daily.id).toBe('today');
    expect(id).not.toBe(daily.id);
    await seedDigest('late-arriving', '2026-10-15');
    expect(await ensureWeeklyReport({ db: env.DB, app, sources: [], times: weeklyTimes(now)!, destinationKey: 'key', now })).toBe(id);
    const frozen = await env.DB.prepare('SELECT content_json FROM digests WHERE id=?1').bind(id).first<{ content_json: string }>();
    expect(JSON.parse(frozen!.content_json).entries).toHaveLength(1);
  });

  it('sends once on the Monday cron and suppresses disabled, early, late and Tuesday triggers', async () => {
    const appConfig = JSON.parse(env.APP_CONFIG as string);
    appConfig.weeklyReport = { enabled: true };
    appConfig.delivery = { channel: 'telegram', destinationConfigRef: 'weekly-test' };
    const runtime = { ...env, APP_CONFIG: appConfig, APP_ENV: 'production', SEND_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz', TELEGRAM_CHAT_ID: '987654321' } as unknown as RuntimeEnv;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      for (const at of [now - 1, now + 3_600_000, now + 86_400_000]) {
        await createApplication(runtime, () => at).scheduled({ cron: '0 0 * * 1', scheduledTime: at } as ScheduledController);
      }
      await createApplication({ ...runtime, SEND_ENABLED: 'false' }, () => now)
        .scheduled({ cron: '0 0 * * 1', scheduledTime: now } as ScheduledController);
      expect(fetcher).not.toHaveBeenCalled();
      const app = createApplication(runtime, () => now);
      await Promise.all([app.scheduled({ cron: '0 0 * * 1', scheduledTime: now } as ScheduledController),
        app.scheduled({ cron: '0 0 * * 1', scheduledTime: now } as ScheduledController)]);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
      expect(body.text).toContain('2026-10-12 ～ 2026-10-18');
      expect(body.link_preview_options).toEqual({ is_disabled: true });
      expect(await env.DB.prepare("SELECT status FROM digests WHERE report_kind='weekly'").first()).toEqual({ status: 'sent' });
    } finally { fetcher.mockRestore(); clock.mockRestore(); }
  });

  it('resumes weekly chunks after throttling and does not resend the accepted prefix', async () => {
    let at = now;
    const app = JSON.parse(env.APP_CONFIG as string);
    const id = await ensureWeeklyReport({ db: env.DB, app, sources: [], times: weeklyTimes(now)!, destinationKey: 'key', now });
    await env.DB.prepare('UPDATE digests SET content_json=?1 WHERE id=?2')
      .bind(JSON.stringify({ messages: ['Weekly 1', 'Weekly 2'] }), id).run();
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>(async () => ++calls === 2
      ? new Response(JSON.stringify({ parameters: { retry_after: 1 } }), { status: 429 })
      : new Response(JSON.stringify({ ok: true, result: { message_id: calls } })));
    const sender = createTelegramSender({ botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '987654321',
      destinationConfigRef: app.delivery.destinationConfigRef, fetcher, now: () => at,
      outbox: createTelegramOutbox(env.DB), messageIntervalMs: 0 });
    const dependencies = { db: env.DB, clock: { now: () => at }, sender, sendEnabled: true,
      channel: 'telegram' as const, destinationConfigRef: app.delivery.destinationConfigRef, destinationKey: 'key' };
    expect(await deliverDigest(id, 0, dependencies)).toMatchObject({ kind: 'rejected', retryable: true });
    at += 1001;
    await recoverDeliveries(at, dependencies);
    expect(fetcher.mock.calls.map(call => JSON.parse(String(call[1]!.body)).text)).toEqual(['Weekly 1', 'Weekly 2', 'Weekly 2']);
    expect(await env.DB.prepare('SELECT status FROM digests WHERE id=?1').bind(id).first()).toEqual({ status: 'sent' });
  });

  it('does not resend an ambiguous weekly delivery', async () => {
    const app = JSON.parse(env.APP_CONFIG as string);
    const id = await ensureWeeklyReport({ db: env.DB, app, sources: [], times: weeklyTimes(now)!, destinationKey: 'key', now });
    const send = vi.fn().mockResolvedValue({ kind: 'uncertain', code: 'CONNECTION_LOST' });
    const dependencies = { db: env.DB, clock: { now: () => now }, sender: { send }, sendEnabled: true,
      channel: 'telegram' as const, destinationConfigRef: app.delivery.destinationConfigRef, destinationKey: 'key' };
    await deliverDigest(id, 0, dependencies);
    await recoverDeliveries(now + 300_000, dependencies);
    await deliverDigest(id, 0, dependencies);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['disabled', 'destination-changed'])('suppresses a frozen weekly report when %s', async reason => {
    const app = JSON.parse(env.APP_CONFIG as string);
    const id = await ensureWeeklyReport({ db: env.DB, app, sources: [], times: weeklyTimes(now)!, destinationKey: 'key', now });
    const send = vi.fn();
    expect(await deliverDigest(id, 0, { db: env.DB, clock: { now: () => now }, sender: { send }, sendEnabled: true,
      weeklyEnabled: reason !== 'disabled', channel: 'telegram', destinationConfigRef: app.delivery.destinationConfigRef,
      destinationKey: reason === 'destination-changed' ? 'new-key' : 'key' }))
      .toMatchObject({ kind: 'suppressed', reason: reason === 'disabled' ? 'send_disabled' : 'config_changed' });
    expect(send).not.toHaveBeenCalled();
  });
});
