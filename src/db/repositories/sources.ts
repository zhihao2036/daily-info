import type { Clock, Id, Lease } from '../../domain/contracts';

interface LeaseRow {
  source_id: string;
  owner_id: string;
  fencing_token: number;
  expires_at: number;
}

function mapLease(row: LeaseRow | null): Lease | null {
  return row === null ? null : {
    sourceId: row.source_id,
    ownerId: row.owner_id,
    fencingToken: row.fencing_token,
    expiresAt: row.expires_at,
  };
}

export class SourceRepository {
  constructor(private readonly db: D1Database, private readonly clock: Clock) {}

  async acquireLease(sourceId: Id, ownerId: Id, now: number): Promise<Lease | null> {
    const row = await this.db.prepare(`
      INSERT INTO source_leases(source_id,owner_id,fencing_token,expires_at)
      VALUES (?1,?2,1,?3)
      ON CONFLICT(source_id) DO UPDATE SET
        owner_id=excluded.owner_id,
        fencing_token=source_leases.fencing_token+1,
        expires_at=excluded.expires_at
      WHERE source_leases.expires_at <= ?4
      RETURNING source_id,owner_id,fencing_token,expires_at
    `).bind(sourceId, ownerId, now + 120_000, now).first<LeaseRow>();
    return mapLease(row);
  }

  async renewLease(lease: Lease, now: number): Promise<Lease | null> {
    const row = await this.db.prepare(`
      UPDATE source_leases SET expires_at=?1
      WHERE source_id=?2 AND owner_id=?3 AND fencing_token=?4 AND expires_at>?5
      RETURNING source_id,owner_id,fencing_token,expires_at
    `).bind(now + 120_000, lease.sourceId, lease.ownerId, lease.fencingToken, now).first<LeaseRow>();
    return mapLease(row);
  }

  async ownsLease(lease: Lease): Promise<boolean> {
    const row = await this.db.prepare(`
      SELECT 1 AS owned FROM source_leases
      WHERE source_id=?1 AND owner_id=?2 AND fencing_token=?3 AND expires_at>?4
    `).bind(lease.sourceId, lease.ownerId, lease.fencingToken, this.clock.now()).first<{ owned: number }>();
    return row?.owned === 1;
  }

  async markSuccess(lease: Lease, now: number, etag?: string, lastModified?: string): Promise<void> {
    const result = await this.db.prepare(`
      UPDATE sources SET last_success_at=?1,last_error_code=NULL,failure_count=0,
        etag=COALESCE(?2,etag),last_modified=COALESCE(?3,last_modified),updated_at=?1
      WHERE id=?4 AND enabled=1 AND EXISTS (
        SELECT 1 FROM source_leases l WHERE l.source_id=?4 AND l.owner_id=?5
          AND l.fencing_token=?6 AND l.expires_at>?1
      )
    `).bind(now, etag ?? null, lastModified ?? null, lease.sourceId, lease.ownerId, lease.fencingToken).run();
    if (result.meta.changes !== 1) throw new Error('LEASE_LOST');
  }

  async markFailure(lease: Lease, errorCode: string, now: number): Promise<void> {
    await this.db.prepare(`
      UPDATE sources SET last_error_code=?1,failure_count=failure_count+1,updated_at=?2
      WHERE id=?3 AND enabled=1 AND EXISTS (
        SELECT 1 FROM source_leases l WHERE l.source_id=?3 AND l.owner_id=?4
          AND l.fencing_token=?5 AND l.expires_at>?2
      )
    `).bind(errorCode.slice(0, 120), now, lease.sourceId, lease.ownerId, lease.fencingToken).run();
  }
}
