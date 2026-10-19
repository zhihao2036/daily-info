import type { Clock, DigestMode, DigestTimes, EventCard, FrozenCandidate, ItemVersion, Json } from '../../domain/contracts';
import { parseDigestConfigSnapshot } from '../../config/snapshot';
import { sha256 } from './shared';

interface DigestRow {
  frozen_at: number | null;
  build_generation: number;
  cutoff_at: number;
  config_snapshot_json: string;
}
export interface SnapshotEvent { card: EventCard; eventKey: string; factsHash: string }
interface CandidateRow {
  ordinal: number;
  reason: FrozenCandidate['reason'];
  id: string;
  item_id: string;
  source_id: string;
  revision: number;
  title: string;
  canonical_url: string;
  published_at: number | null;
  ingested_at: number;
  body_text: string;
  quality: ItemVersion['quality'];
  content_hash: string;
}

function mapCandidate(row: CandidateRow): FrozenCandidate {
  return {
    ordinal: row.ordinal,
    reason: row.reason,
    version: {
      id: row.id,
      itemId: row.item_id,
      sourceId: row.source_id,
      revision: row.revision,
      title: row.title,
      canonicalUrl: row.canonical_url,
      publishedAt: row.published_at,
      ingestedAt: row.ingested_at,
      bodyText: row.body_text,
      quality: row.quality,
      contentHash: row.content_hash,
    },
  };
}

export async function digestIdentityId(input: {
  profileId: string;
  mode: DigestMode;
  localDate: string;
  identityKey?: string;
  now: number;
}): Promise<string> {
  const identity = input.mode === 'scheduled'
    ? `${input.profileId}:${input.localDate}:scheduled`
    : `${input.profileId}:${input.localDate}:preview:${input.identityKey ?? input.now}`;
  return `digest-${await sha256(identity)}`;
}

export class DigestRepository {
  constructor(private readonly db: D1Database, private readonly clock: Clock) {}

  private async readFrozen(digestId: string): Promise<FrozenCandidate[]> {
    const rows = await this.db.prepare(`
      SELECT c.ordinal,c.reason,v.id,v.item_id,i.source_id,v.revision,v.title,v.canonical_url,
        v.published_at,v.ingested_at,v.body_text,v.quality,v.content_hash
      FROM digest_candidates c
      JOIN item_versions v ON v.id=c.item_version_id
      JOIN items i ON i.id=v.item_id
      WHERE c.digest_id=?1 ORDER BY c.ordinal
    `).bind(digestId).all<CandidateRow>();
    return rows.results.map(mapCandidate);
  }

  async freezeCandidates(digestId: string, generation: number): Promise<FrozenCandidate[]> {
    const digest = await this.db.prepare(`
      SELECT frozen_at,build_generation,cutoff_at,config_snapshot_json FROM digests WHERE id=?1
    `)
      .bind(digestId).first<DigestRow>();
    if (digest === null) throw new Error('DIGEST_NOT_FOUND');
    if (digest.frozen_at !== null) return this.readFrozen(digestId);
    if (digest.build_generation !== generation) throw new Error('GENERATION_LOST');
    let maxCandidates = 0;
    let lateHours = 72;
    let enabledSourceIds: string[] = [];
    let coreSourceIds: string[] = [];
    try {
      const snapshot = parseDigestConfigSnapshot(digest.config_snapshot_json);
      maxCandidates = snapshot.app.limits.maxCandidates;
      lateHours = snapshot.app.editorial.lateHours;
      enabledSourceIds = snapshot.sources.filter((source) => source.enabled).map((source) => source.id);
      coreSourceIds = snapshot.sources.filter((source) => source.enabled && source.core).map((source) => source.id);
    } catch { /* Invalid legacy snapshots fail closed instead of inheriting live source authority. */ }
    const lateCutoffAt = digest.cutoff_at - lateHours * 3_600_000;
    const enabledSourcesJson = JSON.stringify(enabledSourceIds);
    const coreSourcesJson = JSON.stringify(coreSourceIds);

    await this.db.batch([
      this.db.prepare(`
        INSERT INTO digest_candidates(digest_id,item_id,item_version_id,ordinal,reason)
        WITH eligible AS (
          SELECT v.*,i.source_id,i.first_seen_at,d.window_start_at,d.cutoff_at,
            ROW_NUMBER() OVER (PARTITION BY v.item_id ORDER BY v.revision DESC) AS latest_rank
          FROM digests d
          JOIN item_versions v ON v.ingested_at<=d.cutoff_at
          JOIN items i ON i.id=v.item_id
          JOIN sources s ON s.id=i.source_id AND s.enabled=1
          JOIN collection_pages p ON p.run_id=v.collection_run_id AND p.page_no=v.collection_page_no
            AND p.status='committed' AND p.committed_at<=d.cutoff_at
          WHERE d.id=?1 AND d.build_generation=?2 AND d.frozen_at IS NULL
            AND (v.ingested_at>d.window_start_at OR p.committed_at>d.window_start_at)
            AND v.published_at>=?4 AND v.published_at<=d.cutoff_at
            AND v.quality<>'metadata_only'
            AND (v.revision=1 OR EXISTS (
              SELECT 1 FROM item_versions previous WHERE previous.item_id=v.item_id AND previous.revision=v.revision-1
                AND (previous.body_text<>v.body_text OR previous.title<>v.title OR previous.quality<>v.quality)
            ))
            AND i.source_id IN (SELECT value FROM json_each(?5))
        ), source_ranked AS (
          SELECT *,ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY published_at DESC,ingested_at DESC,id) AS source_rank
          FROM eligible WHERE latest_rank=1
        ), ranked AS (
          SELECT *,ROW_NUMBER() OVER (ORDER BY source_rank,published_at DESC,ingested_at DESC,id) AS ordinal
          FROM source_ranked ORDER BY source_rank,published_at DESC,ingested_at DESC,id LIMIT ?3
        )
        SELECT ?1,item_id,id,ordinal,
          CASE
            WHEN published_at IS NULL OR published_at<window_start_at THEN 'late'
            WHEN revision>1 THEN 'updated'
            ELSE 'new'
          END
        FROM ranked
      `).bind(digestId, generation, maxCandidates, lateCutoffAt, enabledSourcesJson),
      this.db.prepare(`
        UPDATE digests SET frozen_at=CAST(unixepoch('subsec')*1000 AS INTEGER),
          coverage_json=json_object(
            'coreTotal',?4,
            'coreFailed',(SELECT COUNT(*) FROM json_each(?5) frozen
              LEFT JOIN sources s ON s.id=frozen.value
              WHERE s.id IS NULL OR s.enabled<>1 OR s.failure_count>0 OR s.last_success_at IS NULL OR
                s.last_success_at<(SELECT window_start_at FROM digests WHERE id=?1))
          ),updated_at=?3
        WHERE id=?1 AND build_generation=?2 AND frozen_at IS NULL
      `).bind(digestId, generation, this.clock.now(), coreSourceIds.length, coreSourcesJson),
    ]);
    const frozen = await this.db.prepare('SELECT frozen_at,build_generation,cutoff_at,config_snapshot_json FROM digests WHERE id=?1')
      .bind(digestId).first<DigestRow>();
    if (frozen?.frozen_at === null || frozen?.build_generation !== generation) throw new Error('GENERATION_LOST');
    return this.readFrozen(digestId);
  }

  async ensure(input: {
    profileId: string;
    mode: DigestMode;
    times: DigestTimes;
    configSnapshot: Json;
    now: number;
    identityKey?: string;
  }): Promise<{ id: string; generation: number; status: string }> {
    const id = await digestIdentityId({ profileId: input.profileId, mode: input.mode,
      localDate: input.times.localDate, now: input.now, ...(input.identityKey === undefined ? {} : { identityKey: input.identityKey }) });
    let initialHours = 48;
    if (typeof input.configSnapshot === 'object' && input.configSnapshot !== null && !Array.isArray(input.configSnapshot)) {
      const root = input.configSnapshot.app;
      const editorial = typeof root === 'object' && root !== null && !Array.isArray(root) ? root.editorial : input.configSnapshot.editorial;
      if (typeof editorial === 'object' && editorial !== null && !Array.isArray(editorial)
        && typeof editorial.initialHours === 'number' && Number.isFinite(editorial.initialHours)) {
        initialHours = editorial.initialHours;
      }
    }
    let windowStartAt = input.times.cutoffAt - initialHours * 3_600_000;
    if (input.mode === 'scheduled') {
      const previous = await this.db.prepare(`
        SELECT MAX(d.cutoff_at) AS cutoff_at FROM digests d
        JOIN deliveries delivery ON delivery.digest_id=d.id AND delivery.status='sent'
        WHERE d.profile_id=?1 AND d.mode='scheduled' AND d.report_kind='daily' AND d.timezone='Asia/Shanghai' AND d.cutoff_at<?2
      `).bind(input.profileId, input.times.cutoffAt).first<{ cutoff_at: number | null }>();
      if (previous?.cutoff_at !== null && previous?.cutoff_at !== undefined) windowStartAt = previous.cutoff_at;
    }
    await this.db.prepare(`
      INSERT INTO digests(
        id,profile_id,local_date,timezone,mode,status,window_start_at,cutoff_at,build_deadline_at,
        send_at,send_deadline_at,build_generation,config_snapshot_json,created_at,updated_at
      ) VALUES (?1,?2,?3,'Asia/Shanghai',?4,'collecting',?5,?6,?7,?8,?9,0,json(?10),?11,?11)
      ON CONFLICT DO NOTHING
    `).bind(id, input.profileId, input.times.localDate, input.mode, windowStartAt,
      input.times.cutoffAt, input.times.buildDeadlineAt, input.times.sendAt, input.times.sendDeadlineAt,
      JSON.stringify(input.configSnapshot), input.now).run();
    const row = await this.db.prepare(`
      SELECT id,build_generation AS generation,status FROM digests
      WHERE id=?1 OR (mode='scheduled' AND report_kind='daily' AND profile_id=?2 AND local_date=?3 AND timezone='Asia/Shanghai')
      LIMIT 1
    `).bind(id, input.profileId, input.times.localDate).first<{ id: string; generation: number; status: string }>();
    if (row === null) throw new Error('DIGEST_REGISTRATION_FAILED');
    return row;
  }

  async claimBuild(digestId: string, generation: number, now: number): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE digests SET status='building',updated_at=?3
      WHERE id=?1 AND build_generation=?2 AND status='collecting' AND ?3<send_deadline_at
    `).bind(digestId, generation, now).run();
    if (result.meta.changes === 1) return true;
    const row = await this.db.prepare("SELECT 1 AS ok FROM digests WHERE id=?1 AND build_generation=?2 AND status='building'")
      .bind(digestId, generation).first<{ ok: number }>();
    return row?.ok === 1;
  }

  async claimFallback(digestId: string, expectedGeneration: number, now: number): Promise<number | null> {
    const row = await this.db.prepare(`
      UPDATE digests SET build_generation=build_generation+1,status='building',updated_at=?3
      WHERE id=?1 AND build_generation=?2 AND mode='scheduled' AND status IN ('collecting','building')
        AND content_json IS NULL AND build_deadline_at<=?3 AND ?3<send_deadline_at
      RETURNING build_generation
    `).bind(digestId, expectedGeneration, now).first<{ build_generation: number }>();
    return row?.build_generation ?? null;
  }

  async commitSnapshot(
    digestId: string,
    generation: number,
    content: Json,
    text: string,
    html: string,
    now: number,
    events: SnapshotEvent[] = [],
  ): Promise<boolean> {
    const contentHash = await sha256(JSON.stringify(content));
    const statements: D1PreparedStatement[] = [];
    for (const [index, event] of events.entries()) {
      statements.push(this.db.prepare(`
        INSERT INTO events(id,event_key,organization,product,product_version,change_kind,created_at)
        SELECT ?1,?2,?3,?4,?5,?6,?7 FROM digests d
        WHERE d.id=?8 AND d.build_generation=?9 AND d.status IN ('collecting','building') AND d.content_json IS NULL
        ON CONFLICT(event_key) DO NOTHING
      `).bind(event.card.eventId, event.eventKey, event.card.organization, event.card.product,
        event.card.productVersion, event.card.changeKind, now, digestId, generation));
      statements.push(this.db.prepare(`
        INSERT INTO event_versions(id,event_id,revision,facts_hash,card_json,created_at)
        SELECT ?1,e.id,COALESCE((SELECT MAX(revision) FROM event_versions WHERE event_id=e.id),0)+1,?2,json(?3),?4
        FROM events e JOIN digests d ON d.id=?5
        WHERE e.event_key=?6 AND d.build_generation=?7 AND d.status IN ('collecting','building') AND d.content_json IS NULL
        ON CONFLICT(event_id,facts_hash) DO NOTHING
      `).bind(event.card.eventVersionId, event.factsHash, JSON.stringify(event.card), now,
        digestId, event.eventKey, generation));
      statements.push(this.db.prepare(`
        INSERT INTO digest_events(digest_id,event_version_id,ordinal,snapshot_json)
        SELECT d.id,ev.id,?1,json(?2) FROM digests d
        JOIN events e ON e.event_key=?3
        JOIN event_versions ev ON ev.event_id=e.id AND ev.facts_hash=?4
        WHERE d.id=?5 AND d.build_generation=?6 AND d.status IN ('collecting','building') AND d.content_json IS NULL
        ON CONFLICT(digest_id,event_version_id) DO NOTHING
      `).bind(index + 1, JSON.stringify({ eventKey: event.eventKey, factsHash: event.factsHash, card: event.card }),
        event.eventKey, event.factsHash, digestId, generation));
    }
    statements.push(this.db.prepare(`
      UPDATE digests SET status='ready',content_json=json(?3),rendered_text=?4,rendered_html=?5,
        content_hash=?6,updated_at=?7
      WHERE id=?1 AND build_generation=?2 AND status IN ('collecting','building') AND content_json IS NULL
    `).bind(digestId, generation, JSON.stringify(content), text, html, contentHash, now));
    const results = await this.db.batch(statements);
    return results.at(-1)?.meta.changes === 1;
  }
}
