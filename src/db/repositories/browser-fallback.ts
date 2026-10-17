import type { BrowserFallbackFailure, Clock, Id, Lease } from '../../domain/contracts';
import { systemClock } from './shared';

const DAILY_BROWSER_MS = 600_000;
const DAILY_PAGES = 50;
const RESERVATION_MS = 60_000;
const COOLDOWN_MS = 24 * 60 * 60_000;

export type { BrowserFallbackFailure } from '../../domain/contracts';
type BrowserFallbackSettlement = 'succeeded' | 'blocked' | 'failed' | 'uncertain';

export interface BrowserReservation {
  id: Id;
  dateUtc: string;
  sourceId: Id;
  runId: Id;
  reservedMs: typeof RESERVATION_MS;
  reservedPages: 1;
}

export interface BrowserUsage {
  dateUtc: string;
  browserMsUsed: number;
  pagesUsed: number;
  reservedBrowserMs: number;
  reservedPages: number;
}

export interface BrowserFallbackState {
  usage: BrowserUsage | null;
  cooldownUntil: number | null;
  lastErrorCode: string | null;
  fallbackCount: number;
}

interface UsageRow {
  date_utc: string;
  browser_ms_used: number;
  pages_used: number;
  reserved_browser_ms: number;
  reserved_pages: number;
}

interface SourceRow {
  browser_cooldown_until: number | null;
  last_browser_error_code: string | null;
  browser_fallback_count: number;
}

function dayUtc(now: number): string { return new Date(now).toISOString().slice(0, 10); }

export class BrowserFallbackRepository {
  constructor(private readonly db: D1Database, private readonly clock: Clock = systemClock) {}

  async reserve(input: { sourceId: Id; runId: Id; lease: Lease; urlHash: string; now?: number }): Promise<BrowserReservation | null> {
    const now = input.now ?? this.clock.now();
    const dateUtc = dayUtc(now);
    const id = crypto.randomUUID();
    const result = await this.db.batch([
      this.db.prepare(`
        INSERT INTO browser_usage_days(date_utc,updated_at) VALUES (?1,?2)
        ON CONFLICT(date_utc) DO NOTHING
      `).bind(dateUtc, now),
      this.db.prepare(`
        UPDATE browser_usage_days SET
          reserved_browser_ms=reserved_browser_ms+?1,
          reserved_pages=reserved_pages+1,
          last_reservation_id=?2,
          updated_at=?3
        WHERE date_utc=?4
          AND browser_ms_used+reserved_browser_ms+?1 <= ?5
          AND pages_used+reserved_pages+1 <= ?6
          AND EXISTS (
            SELECT 1 FROM source_leases l
            WHERE l.source_id=?7 AND l.owner_id=?8 AND l.fencing_token=?9 AND l.expires_at>?3
          )
          AND EXISTS (
            SELECT 1 FROM sources s
            WHERE s.id=?7 AND (s.browser_cooldown_until IS NULL OR s.browser_cooldown_until<=?3)
          )
          AND NOT EXISTS (
            SELECT 1 FROM browser_fallback_attempts a
            WHERE a.source_id=?7 AND a.run_id=?10 AND a.url_hash=?11
          )
      `).bind(RESERVATION_MS, id, now, dateUtc, DAILY_BROWSER_MS, DAILY_PAGES,
        input.sourceId, input.lease.ownerId, input.lease.fencingToken, input.runId, input.urlHash),
      this.db.prepare(`
        INSERT INTO browser_fallback_attempts(
          id,source_id,run_id,url_hash,state,reserved_ms,started_at
        )
        SELECT ?1,?2,?3,?4,'reserved',?5,?6
        WHERE EXISTS (
          SELECT 1 FROM browser_usage_days WHERE date_utc=?7 AND last_reservation_id=?1
        )
          AND EXISTS (
            SELECT 1 FROM source_leases l
            WHERE l.source_id=?2 AND l.owner_id=?8 AND l.fencing_token=?9 AND l.expires_at>?6
          )
      `).bind(id, input.sourceId, input.runId, input.urlHash, RESERVATION_MS, now, dateUtc,
        input.lease.ownerId, input.lease.fencingToken),
    ]);
    if (result[2]?.meta.changes !== 1) return null;
    return { id, dateUtc, sourceId: input.sourceId, runId: input.runId, reservedMs: RESERVATION_MS, reservedPages: 1 };
  }

  async settle(input: {
    reservation: BrowserReservation;
    lease: Lease;
    outcome: BrowserFallbackSettlement;
    actualMs?: number | null;
    errorCode?: string | null;
    now?: number;
  }): Promise<void> {
    const now = input.now ?? this.clock.now();
    const errorCode = input.errorCode?.slice(0, 120) ?? null;
    if (input.outcome === 'uncertain') {
      const result = await this.db.prepare(`
        UPDATE browser_fallback_attempts SET state='uncertain',error_code=?1,finished_at=?2
        WHERE id=?3 AND source_id=?4 AND state='reserved' AND EXISTS (
          SELECT 1 FROM source_leases l WHERE l.source_id=?4 AND l.owner_id=?5
            AND l.fencing_token=?6 AND l.expires_at>?2
        )
      `).bind(errorCode, now, input.reservation.id, input.lease.sourceId, input.lease.ownerId, input.lease.fencingToken).run();
      if (result.meta.changes !== 1) throw new Error('LEASE_LOST');
      return;
    }

    const suppliedMs = input.actualMs;
    const actualMs = suppliedMs === null || suppliedMs === undefined || !Number.isFinite(suppliedMs)
      ? RESERVATION_MS
      : Math.min(RESERVATION_MS, Math.max(0, Math.floor(suppliedMs)));
    const statements: D1PreparedStatement[] = [
      this.db.prepare(`
        UPDATE browser_usage_days SET
          reserved_browser_ms=MAX(0,reserved_browser_ms-?1),
          reserved_pages=MAX(0,reserved_pages-1),
          browser_ms_used=browser_ms_used+?2,
          pages_used=pages_used+1,
          updated_at=?3
        WHERE date_utc=?4 AND EXISTS (
          SELECT 1 FROM browser_fallback_attempts a
          WHERE a.id=?5 AND a.source_id=?6 AND a.state='reserved'
        ) AND EXISTS (
          SELECT 1 FROM source_leases l WHERE l.source_id=?6 AND l.owner_id=?7
            AND l.fencing_token=?8 AND l.expires_at>?3
        )
      `).bind(RESERVATION_MS, actualMs, now, input.reservation.dateUtc, input.reservation.id,
        input.lease.sourceId, input.lease.ownerId, input.lease.fencingToken),
      this.db.prepare(`
        UPDATE browser_fallback_attempts SET state=?1,actual_ms=?2,error_code=?3,finished_at=?4
        WHERE id=?5 AND source_id=?6 AND state='reserved' AND EXISTS (
          SELECT 1 FROM source_leases l WHERE l.source_id=?6 AND l.owner_id=?7
            AND l.fencing_token=?8 AND l.expires_at>?4
        )
      `).bind(input.outcome, actualMs, errorCode, now, input.reservation.id, input.lease.sourceId,
        input.lease.ownerId, input.lease.fencingToken),
    ];
    if (input.outcome === 'blocked') {
      statements.push(this.db.prepare(`
        UPDATE sources SET browser_cooldown_until=?1,last_browser_error_code=?2,
          browser_fallback_count=browser_fallback_count+1,updated_at=?3
        WHERE id=?4 AND EXISTS (
          SELECT 1 FROM source_leases l WHERE l.source_id=?4 AND l.owner_id=?5
            AND l.fencing_token=?6 AND l.expires_at>?3
        )
      `).bind(now + COOLDOWN_MS, errorCode, now, input.lease.sourceId, input.lease.ownerId, input.lease.fencingToken));
    }
    const result = await this.db.batch(statements);
    if (result.some((entry) => entry.meta.changes !== 1)) throw new Error('LEASE_LOST');
  }

  async state(sourceId: Id, now = this.clock.now()): Promise<BrowserFallbackState> {
    const result = await this.db.batch([
      this.db.prepare(`SELECT date_utc,browser_ms_used,pages_used,reserved_browser_ms,reserved_pages
        FROM browser_usage_days WHERE date_utc=?1`).bind(dayUtc(now)),
      this.db.prepare(`SELECT browser_cooldown_until,last_browser_error_code,browser_fallback_count
        FROM sources WHERE id=?1`).bind(sourceId),
    ]);
    const usageRow = result[0]?.results[0] as UsageRow | undefined;
    const sourceRow = result[1]?.results[0] as SourceRow | undefined;
    return {
      usage: usageRow === undefined ? null : {
        dateUtc: usageRow.date_utc,
        browserMsUsed: usageRow.browser_ms_used,
        pagesUsed: usageRow.pages_used,
        reservedBrowserMs: usageRow.reserved_browser_ms,
        reservedPages: usageRow.reserved_pages,
      },
      cooldownUntil: sourceRow?.browser_cooldown_until ?? null,
      lastErrorCode: sourceRow?.last_browser_error_code ?? null,
      fallbackCount: sourceRow?.browser_fallback_count ?? 0,
    };
  }

  async cooldown(lease: Lease, errorCode: string, now = this.clock.now()): Promise<void> {
    const result = await this.db.prepare(`
      UPDATE sources SET browser_cooldown_until=?1,last_browser_error_code=?2,
        browser_fallback_count=browser_fallback_count+1,updated_at=?3
      WHERE id=?4 AND EXISTS (
        SELECT 1 FROM source_leases l WHERE l.source_id=?4 AND l.owner_id=?5
          AND l.fencing_token=?6 AND l.expires_at>?3
      )
    `).bind(now + COOLDOWN_MS, errorCode.slice(0, 120), now, lease.sourceId, lease.ownerId, lease.fencingToken).run();
    if (result.meta.changes !== 1) throw new Error('LEASE_LOST');
  }
}
