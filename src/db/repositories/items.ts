import type { BodyRetryCandidate, Clock, Json, Lease, RawItem } from '../../domain/contracts';
import { canonicalJson, json, sha256 } from './shared';
import { SourceRepository } from './sources';

export interface PageIdentity { runId: string; pageNo: number; lease: Lease; expectedCursorVersion: number }
export interface BeginPageInput extends PageIdentity { requestCursor: Json }
export interface StagePageInput extends PageIdentity { items: RawItem[] }
export interface FinalizePageInput extends PageIdentity { nextCursor: Json; complete: boolean }
export interface CommitPageInput extends FinalizePageInput { items: RawItem[]; requestCursor: Json }
interface StagedItem {
  raw: RawItem;
  itemId: string;
  versionId: string;
  ingestKey: string;
  contentHash: string;
}

export class ItemRepository {
  private readonly sources: SourceRepository;

  constructor(private readonly db: D1Database, private readonly clock: Clock) {
    this.sources = new SourceRepository(db, clock);
  }

  async beginPage(input: BeginPageInput): Promise<'pending' | 'committed'> {
    const existing = await this.db.prepare('SELECT status FROM collection_pages WHERE run_id=?1 AND page_no=?2')
      .bind(input.runId, input.pageNo).first<{ status: 'pending' | 'committed' | 'failed' }>();
    if (existing?.status === 'committed') return 'committed';
    if (existing?.status === 'pending') return 'pending';

    await this.db.prepare(`
      INSERT INTO collection_pages(run_id,page_no,request_cursor_json,status,item_count)
      SELECT ?1,?2,json(?3),'pending',0 FROM source_leases l JOIN sources s ON s.id=l.source_id
      WHERE l.source_id=?4 AND l.owner_id=?5 AND l.fencing_token=?6 AND l.expires_at>?7
        AND s.enabled=1 AND s.cursor_version=?8
    `).bind(input.runId, input.pageNo, json(input.requestCursor), input.lease.sourceId,
      input.lease.ownerId, input.lease.fencingToken, this.clock.now(), input.expectedCursorVersion).run();
    const created = await this.db.prepare('SELECT status FROM collection_pages WHERE run_id=?1 AND page_no=?2')
      .bind(input.runId, input.pageNo).first<{ status: 'pending' | 'committed' }>();
    if (created === null) throw new Error('LEASE_LOST');
    return created.status;
  }

  private async prepareItems(input: StagePageInput): Promise<StagedItem[]> {
    const output: StagedItem[] = [];
    for (const raw of input.items) {
      const itemId = await sha256(`${input.lease.sourceId}\n${raw.externalKey}`);
      const ingestKey = `${input.runId}:${input.pageNo}:${raw.externalKey}`;
      const contentHash = await sha256(canonicalJson({
        title: raw.title,
        canonicalUrl: raw.canonicalUrl,
        body: raw.body,
        quality: raw.quality,
        metadata: raw.metadata,
        publishedAt: raw.publishedAt,
        sourceUpdatedAt: raw.sourceUpdatedAt,
      }));
      output.push({ raw, itemId, ingestKey, contentHash, versionId: await sha256(`${itemId}\n${ingestKey}`) });
    }
    return output;
  }

  async stagePageItems(input: StagePageInput): Promise<void> {
    const staged = await this.prepareItems(input);
    const now = this.clock.now();
    const statements: D1PreparedStatement[] = [];
    for (const item of staged) {
      statements.push(this.db.prepare(`
        INSERT INTO items(id,source_id,external_key,canonical_url,first_seen_at,last_seen_at,current_revision)
        SELECT ?1,?2,?3,?4,?5,?5,0
        WHERE EXISTS (
          SELECT 1 FROM source_leases l JOIN sources s ON s.id=l.source_id WHERE l.source_id=?2 AND l.owner_id=?6
          AND l.fencing_token=?7 AND l.expires_at>?5 AND s.enabled=1 AND s.cursor_version=?8
        )
        ON CONFLICT(source_id,external_key) DO UPDATE SET
          canonical_url=excluded.canonical_url,last_seen_at=excluded.last_seen_at
      `).bind(item.itemId, input.lease.sourceId, item.raw.externalKey, item.raw.canonicalUrl,
        now, input.lease.ownerId, input.lease.fencingToken, input.expectedCursorVersion));
      statements.push(this.db.prepare(`
        INSERT INTO item_versions(
          id,item_id,revision,ingest_key,collection_run_id,collection_page_no,content_hash,title,
          canonical_url,published_at,source_updated_at,ingested_at,body_text,quality,metadata_json
        )
        SELECT ?1,i.id,COALESCE((SELECT MAX(v.revision) FROM item_versions v WHERE v.item_id=i.id),0)+1,
          ?2,?3,?4,?5,?6,?7,?8,?9,CAST(unixepoch('subsec')*1000 AS INTEGER),?10,?11,json(?12)
        FROM items i
        LEFT JOIN item_versions current ON current.item_id=i.id AND current.revision=i.current_revision
        WHERE i.source_id=?13 AND i.external_key=?14
          AND (i.current_revision=0 OR current.content_hash<>?5)
          AND (i.current_revision=0 OR
            CASE ?11 WHEN 'full' THEN 3 WHEN 'partial' THEN 2 ELSE 1 END >=
            CASE current.quality WHEN 'full' THEN 3 WHEN 'partial' THEN 2 ELSE 1 END)
          AND EXISTS (
            SELECT 1 FROM collection_pages p WHERE p.run_id=?3 AND p.page_no=?4 AND p.status='pending'
          )
          AND EXISTS (
            SELECT 1 FROM source_leases l JOIN sources s ON s.id=l.source_id WHERE l.source_id=?13 AND l.owner_id=?15
            AND l.fencing_token=?16 AND l.expires_at>?17 AND s.enabled=1 AND s.cursor_version=?18
          )
        ON CONFLICT(item_id,ingest_key) DO NOTHING
      `).bind(item.versionId, item.ingestKey, input.runId, input.pageNo, item.contentHash,
        item.raw.title, item.raw.canonicalUrl, item.raw.publishedAt, item.raw.sourceUpdatedAt,
        item.raw.body, item.raw.quality, JSON.stringify(item.raw.metadata), input.lease.sourceId,
        item.raw.externalKey, input.lease.ownerId, input.lease.fencingToken, now, input.expectedCursorVersion));
    }
    if (statements.length > 0) await this.db.batch(statements);
    if (!(await this.sources.ownsLease(input.lease))) throw new Error('LEASE_LOST');
    const page = await this.db.prepare("SELECT status FROM collection_pages WHERE run_id=?1 AND page_no=?2 AND status='pending'")
      .bind(input.runId, input.pageNo).first();
    if (page === null) {
      throw new Error('PAGE_NOT_PENDING');
    }
  }

  async finalizePage(input: FinalizePageInput): Promise<void> {
    const now = this.clock.now();
    const completeCursor = json({ highWater: input.nextCursor, resume: null, scanStartedAt: null });
    const statements = [
      this.db.prepare(`
        UPDATE collection_pages SET status='committed',next_cursor_json=json(?1),
          item_count=(SELECT COUNT(*) FROM item_versions v WHERE v.collection_run_id=?2 AND v.collection_page_no=?3),
          committed_at=CAST(unixepoch('subsec')*1000 AS INTEGER),error_code=NULL
        WHERE run_id=?2 AND page_no=?3 AND status='pending'
          AND EXISTS (SELECT 1 FROM source_leases l WHERE l.source_id=?4 AND l.owner_id=?5
            AND l.fencing_token=?6 AND l.expires_at>?7)
          AND EXISTS (SELECT 1 FROM sources s WHERE s.id=?4 AND s.enabled=1 AND s.cursor_version=?8)
      `).bind(json(input.nextCursor), input.runId, input.pageNo, input.lease.sourceId,
        input.lease.ownerId, input.lease.fencingToken, now, input.expectedCursorVersion),
      this.db.prepare(`
        UPDATE items SET current_revision=(
          SELECT MAX(v.revision) FROM item_versions v
          WHERE v.item_id=items.id AND v.collection_run_id=?1 AND v.collection_page_no=?2
        )
        WHERE EXISTS (SELECT 1 FROM item_versions v WHERE v.item_id=items.id
          AND v.collection_run_id=?1 AND v.collection_page_no=?2)
          AND EXISTS (SELECT 1 FROM collection_pages p WHERE p.run_id=?1 AND p.page_no=?2 AND p.status='committed')
          AND EXISTS (SELECT 1 FROM source_leases l WHERE l.source_id=?3 AND l.owner_id=?4
            AND l.fencing_token=?5 AND l.expires_at>?6)
          AND EXISTS (SELECT 1 FROM sources s WHERE s.id=?3 AND s.enabled=1 AND s.cursor_version=?7)
      `).bind(input.runId, input.pageNo, input.lease.sourceId, input.lease.ownerId,
        input.lease.fencingToken, now, input.expectedCursorVersion),
      input.complete
        ? this.db.prepare(`
            UPDATE sources SET cursor_json=json(?1),cursor_version=cursor_version+1,updated_at=?2
            WHERE id=?3 AND EXISTS (SELECT 1 FROM source_leases l WHERE l.source_id=?3
              AND l.owner_id=?4 AND l.fencing_token=?5 AND l.expires_at>?2)
              AND enabled=1 AND cursor_version=?8
              AND EXISTS (SELECT 1 FROM collection_pages p WHERE p.run_id=?6 AND p.page_no=?7 AND p.status='committed')
          `).bind(completeCursor, now, input.lease.sourceId, input.lease.ownerId,
            input.lease.fencingToken, input.runId, input.pageNo, input.expectedCursorVersion)
        : this.db.prepare(`
            UPDATE sources SET cursor_json=json_object(
              'highWater',json_extract(COALESCE(cursor_json,'{}'),'$.highWater'),
              'resume',json(?1),
              'scanStartedAt',COALESCE(json_extract(COALESCE(cursor_json,'{}'),'$.scanStartedAt'),?2)
            ),cursor_version=cursor_version+1,updated_at=?2
            WHERE id=?3 AND EXISTS (SELECT 1 FROM source_leases l WHERE l.source_id=?3
              AND l.owner_id=?4 AND l.fencing_token=?5 AND l.expires_at>?2)
              AND enabled=1 AND cursor_version=?8
              AND EXISTS (SELECT 1 FROM collection_pages p WHERE p.run_id=?6 AND p.page_no=?7 AND p.status='committed')
          `).bind(json(input.nextCursor), now, input.lease.sourceId, input.lease.ownerId,
            input.lease.fencingToken, input.runId, input.pageNo, input.expectedCursorVersion),
    ];
    await this.db.batch(statements);
    const page = await this.db.prepare("SELECT status FROM collection_pages WHERE run_id=?1 AND page_no=?2 AND status='committed'")
      .bind(input.runId, input.pageNo).first();
    if (page === null) {
      if (!(await this.sources.ownsLease(input.lease))) throw new Error('LEASE_LOST');
      throw new Error('PAGE_NOT_FOUND');
    }
  }

  async commitPage(input: CommitPageInput): Promise<void> {
    const status = await this.beginPage({ runId: input.runId, pageNo: input.pageNo, lease: input.lease,
      requestCursor: input.requestCursor, expectedCursorVersion: input.expectedCursorVersion });
    if (status === 'committed') return;
    await this.stagePageItems(input);
    await this.finalizePage(input);
  }

  async findBodyRetryCandidates(sourceId: string, now: number, limit = 20): Promise<BodyRetryCandidate[]> {
    const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
    const rows = await this.db.prepare(`
      SELECT i.id AS item_id,v.id AS version_id,i.external_key,v.canonical_url,v.title,v.published_at,v.source_updated_at,
        COALESCE(json_extract(v.metadata_json,'$.extractionAttempts'),0) AS attempts
      FROM items i JOIN item_versions v ON v.item_id=i.id AND v.revision=i.current_revision
      WHERE i.source_id=?1 AND v.quality='metadata_only' AND i.last_seen_at>=?2
        AND COALESCE(json_extract(v.metadata_json,'$.extractionAttempts'),0)<3
        AND COALESCE(json_extract(v.metadata_json,'$.nextBodyRetryAt'),0)<=?3
      ORDER BY i.last_seen_at DESC,i.id LIMIT ?4
    `).bind(sourceId, now - 7 * 86_400_000, now, boundedLimit).all<{
      item_id: string;
      version_id: string;
      external_key: string;
      canonical_url: string;
      title: string;
      published_at: number | null;
      source_updated_at: number | null;
      attempts: number;
    }>();
    return rows.results.map((row) => ({
      itemId: row.item_id,
      versionId: row.version_id,
      externalKey: row.external_key,
      canonicalUrl: row.canonical_url,
      title: row.title,
      publishedAt: row.published_at,
      sourceUpdatedAt: row.source_updated_at,
      attempts: row.attempts,
    }));
  }
}
