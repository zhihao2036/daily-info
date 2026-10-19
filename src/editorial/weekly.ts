import type { AppConfig, SourceConfig } from '../domain/contracts';
import { canonicalJson, sha256 } from '../db/repositories/shared';

const DAY = 86_400_000;
const OFFSET = 8 * 3_600_000;
const date = (at: number) => new Date(at + OFFSET).toISOString().slice(0, 10);

export function weeklyTimes(at: number) {
  const local = new Date(at + OFFSET);
  if (local.getUTCDay() !== 1) return null;
  const monday = Date.parse(`${date(at)}T00:00:00+08:00`);
  return { localDate: date(at), startDate: date(monday - 7 * DAY), endDate: date(monday - DAY),
    windowStartAt: monday - 7 * DAY, cutoffAt: monday, sendAt: monday + OFFSET,
    sendDeadlineAt: monday + 9 * 3_600_000 };
}

export interface WeeklyEntry { eventId: string; title: string; url: string; localDate: string }

export function renderWeeklyReport(startDate: string, endDate: string, entries: WeeklyEntry[]) {
  // Keep the latest occurrence of an event or source URL, then restore chronological order.
  const seenEvents = new Set<string>();
  const seenUrls = new Set<string>();
  const unique = [...entries].reverse().filter(entry => {
    if (seenEvents.has(entry.eventId) || seenUrls.has(entry.url)) return false;
    seenEvents.add(entry.eventId);
    seenUrls.add(entry.url);
    return true;
  }).reverse();
  const heading = `AI / Agent 上周周报 · ${startDate} ～ ${endDate}\n共 ${unique.length} 条`;
  const blocks = unique.map((entry, index) => {
    const title = entry.title.replace(/\s+/g, ' ').trim();
    return `${index + 1}. ${title}\n${entry.url}`;
  });
  if (blocks.length === 0) blocks.push('上周没有已成功推送的新闻。');
  const chunks: string[] = [];
  let chunk = '';
  // Leave room for the heading and pagination; never split a news item or its URL.
  for (const block of blocks) {
    if (block.length > 3800) throw new Error('WEEKLY_ENTRY_TOO_LONG');
    const next = chunk === '' ? block : `${chunk}\n\n${block}`;
    if (next.length > 3800) { chunks.push(chunk); chunk = block; }
    else chunk = next;
  }
  if (chunk !== '') chunks.push(chunk);
  const messages = chunks.map((body, index) => `${heading} · ${index + 1}/${chunks.length}\n\n${body}`);
  if (messages.length > 10) throw new Error('WEEKLY_REPORT_TOO_LONG');
  return { startDate, endDate, entries: unique, messages, text: `${heading}\n\n${blocks.join('\n\n')}` };
}

export async function buildWeeklyReport(db: D1Database, profileId: string, times: NonNullable<ReturnType<typeof weeklyTimes>>) {
  const rows = await db.prepare(`SELECT d.local_date,json_extract(card.value,'$.eventId') AS event_id,
      json_extract(card.value,'$.title') AS title,
      (SELECT canonical_url FROM item_versions WHERE id=json_extract(card.value,'$.sourceVersionIds[0]')) AS url
    FROM digests d,json_each(d.content_json,'$.cards') card
    WHERE d.profile_id=?1 AND d.mode='scheduled' AND d.report_kind='daily'
      AND d.local_date>=?2 AND d.local_date<?3
      AND EXISTS (SELECT 1 FROM deliveries x WHERE x.digest_id=d.id AND x.status='sent')
    ORDER BY d.local_date,CAST(card.key AS INTEGER)`)
    .bind(profileId, times.startDate, times.localDate)
    .all<{ local_date: string; event_id: string; title: string; url: string | null }>();
  // A missing source is an integrity error; do not silently omit selected news.
  if (rows.results.some(row => !row.url || !/^https?:\/\//.test(row.url))) throw new Error('WEEKLY_SOURCE_MISSING');
  return renderWeeklyReport(times.startDate, times.endDate, rows.results.map(row => ({
    eventId: row.event_id, title: row.title, url: row.url!, localDate: row.local_date,
  })));
}

export async function ensureWeeklyReport(input: { db: D1Database; app: AppConfig; sources: SourceConfig[];
  times: NonNullable<ReturnType<typeof weeklyTimes>>; destinationKey: string; now: number }): Promise<string> {
  const { db, app, times, now } = input;
  const id = `weekly-${await sha256(`${app.profileId}:${times.localDate}`)}`;
  if (await db.prepare('SELECT id FROM digests WHERE id=?1').bind(id).first()) return id;
  const report = await buildWeeklyReport(db, app.profileId, times);
  const content = canonicalJson(report);
  const html = `<pre>${report.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
  await db.prepare(`INSERT INTO digests(id,profile_id,local_date,timezone,mode,report_kind,status,
    window_start_at,cutoff_at,build_deadline_at,send_at,send_deadline_at,config_snapshot_json,
    content_json,rendered_text,rendered_html,content_hash,created_at,updated_at)
    VALUES (?1,?2,?3,'Asia/Shanghai','scheduled','weekly','ready',?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)
    ON CONFLICT DO NOTHING`)
    .bind(id, app.profileId, times.localDate, times.windowStartAt, times.cutoffAt, times.sendAt - 1,
      times.sendAt, times.sendDeadlineAt, canonicalJson({ app, sources: input.sources,
        deliveryDestinationKey: input.destinationKey }), content, report.text, html, await sha256(content), now).run();
  return id;
}
