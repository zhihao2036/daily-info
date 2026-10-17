import type { DeliveryPayload, DeliveryStatus, SendResult } from '../../domain/contracts';
import { sha256 } from './shared';

export interface DeliveryRecord {
  id: string;
  digestId: string;
  channel: 'dummy' | 'cloudflare_email' | 'telegram';
  destinationKey: string;
  destinationConfigRef: string;
  payload: DeliveryPayload;
  status: DeliveryStatus;
  attemptId: string | null;
  attemptCount: number;
  providerMessageId: string | null;
  acceptedAt: number | null;
}

interface DeliveryRow {
  id: string; digest_id: string; channel: DeliveryRecord['channel']; destination_key: string;
  destination_config_ref: string; payload_json: string; status: DeliveryStatus; attempt_id: string | null;
  attempt_count: number; provider_message_id: string | null; accepted_at: number | null;
}

function map(row: DeliveryRow): DeliveryRecord {
  return { id: row.id, digestId: row.digest_id, channel: row.channel, destinationKey: row.destination_key,
    destinationConfigRef: row.destination_config_ref, payload: JSON.parse(row.payload_json) as DeliveryPayload,
    status: row.status, attemptId: row.attempt_id, attemptCount: row.attempt_count,
    providerMessageId: row.provider_message_id, acceptedAt: row.accepted_at };
}

export class DeliveryRepository {
  constructor(private readonly db: D1Database) {}

  async findForDigest(digestId: string): Promise<DeliveryRecord | null> {
    const row = await this.db.prepare(`SELECT id,digest_id,channel,destination_key,destination_config_ref,payload_json,
      status,attempt_id,attempt_count,provider_message_id,accepted_at FROM deliveries WHERE digest_id=?1 ORDER BY created_at LIMIT 1`)
      .bind(digestId).first<DeliveryRow>();
    return row === null ? null : map(row);
  }

  async ensure(input: { digestId: string; channel: DeliveryRecord['channel']; destinationKey: string; destinationConfigRef: string; payload: DeliveryPayload; status: 'pending' | 'suppressed'; reason?: string; now: number }): Promise<DeliveryRecord> {
    const id = `delivery-${await sha256(`${input.digestId}:${input.channel}:${input.destinationKey}`)}`;
    await this.db.prepare(`INSERT INTO deliveries(
      id,digest_id,channel,destination_key,destination_config_ref,payload_json,payload_hash,status,last_error_code,created_at,updated_at
    ) VALUES (?1,?2,?3,?4,?5,json(?6),?7,?8,?9,?10,?10) ON CONFLICT(digest_id,channel,destination_key) DO NOTHING`)
      .bind(id, input.digestId, input.channel, input.destinationKey, input.destinationConfigRef, JSON.stringify(input.payload),
        input.payload.payloadHash, input.status, input.reason ?? null, input.now).run();
    const record = await this.findForDigest(input.digestId);
    if (record === null) throw new Error('DELIVERY_REGISTRATION_FAILED');
    return record;
  }

  async suppress(deliveryId: string, code: string, now: number): Promise<void> {
    await this.db.prepare(`UPDATE deliveries SET status='suppressed',last_error_code=?2,updated_at=?3
      WHERE id=?1 AND status IN ('pending','failed')`).bind(deliveryId, code, now).run();
  }

  async claim(delivery: DeliveryRecord, generation: number, now: number): Promise<string | null> {
    const attemptId = `attempt-${await sha256(`${delivery.id}:${delivery.attemptCount + 1}:${crypto.randomUUID()}`)}`;
    const results = await this.db.batch([
      this.db.prepare(`UPDATE deliveries SET status='sending',attempt_id=?1,attempt_count=attempt_count+1,
        claimed_at=?2,updated_at=?2 WHERE id=?3 AND attempt_count<3 AND
        (status='pending' OR (status='failed' AND retryable=1 AND next_attempt_at<=?2)) AND EXISTS (
          SELECT 1 FROM digests WHERE id=deliveries.digest_id AND mode='scheduled'
          AND status IN ('ready','delivery_failed') AND build_generation=?4 AND ?2>=send_at AND ?2<send_deadline_at
        )`).bind(attemptId, now, delivery.id, generation),
      this.db.prepare(`INSERT INTO delivery_attempts(id,delivery_id,state,started_at)
        SELECT ?1,id,'calling',?2 FROM deliveries WHERE id=?3 AND status='sending' AND attempt_id=?1`)
        .bind(attemptId, now, delivery.id),
      this.db.prepare(`UPDATE digests SET status='sending',updated_at=?3 WHERE id=?1
        AND status IN ('ready','delivery_failed') AND build_generation=?2 AND EXISTS (
          SELECT 1 FROM deliveries WHERE id=?4 AND status='sending' AND attempt_id=?5
        )`).bind(delivery.digestId, generation, now, delivery.id, attemptId),
    ]);
    return results.every((result) => result.meta.changes === 1) ? attemptId : null;
  }

  async settle(deliveryId: string, attemptId: string, result: SendResult, now: number): Promise<void> {
    if (result.kind === 'accepted') {
      await this.db.batch([
        this.db.prepare(`UPDATE deliveries SET status='sent',provider_message_id=?3,accepted_at=?4,updated_at=?5
          WHERE id=?1 AND status IN ('sending','uncertain') AND attempt_id=?2`).bind(deliveryId, attemptId, result.providerMessageId, result.acceptedAt, now),
        this.db.prepare(`UPDATE delivery_attempts SET state='succeeded',finished_at=?3,provider_message_id=?4,
          response_summary_json=json('{"audit":[]}') WHERE id=?1 AND delivery_id=?2 AND state IN ('calling','uncertain')`)
          .bind(attemptId, deliveryId, result.acceptedAt, result.providerMessageId),
        this.db.prepare(`UPDATE digests SET status='sent',accepted_at=?2,updated_at=?3
          WHERE id=(SELECT digest_id FROM deliveries WHERE id=?1) AND status IN ('sending','uncertain')
          AND EXISTS (SELECT 1 FROM deliveries WHERE id=?1 AND status='sent' AND attempt_id=?4)`)
          .bind(deliveryId, result.acceptedAt, now, attemptId),
      ]);
      return;
    }
    if (result.kind === 'rejected') {
      await this.db.batch([
        this.db.prepare(`UPDATE deliveries SET status='failed',retryable=?3,next_attempt_at=?4,last_error_code=?5,updated_at=?6
          WHERE id=?1 AND status='sending' AND attempt_id=?2`).bind(deliveryId, attemptId, result.retryable ? 1 : 0, result.retryable ? now + (result.retryAfterMs ?? 300_000) : null, result.code, now),
        this.db.prepare(`UPDATE delivery_attempts SET state='failed',finished_at=?3,error_code=?4,response_summary_json=json('{"audit":[]}')
          WHERE id=?1 AND delivery_id=?2 AND state='calling'`).bind(attemptId, deliveryId, now, result.code),
        this.db.prepare(`UPDATE digests SET status='delivery_failed',updated_at=?2 WHERE id=(SELECT digest_id FROM deliveries WHERE id=?1)
          AND status='sending' AND EXISTS (SELECT 1 FROM deliveries WHERE id=?1 AND status='failed' AND attempt_id=?3)`)
          .bind(deliveryId, now, attemptId),
      ]);
      return;
    }
    if (result.kind === 'uncertain') await this.markUncertain(deliveryId, attemptId, result.code, now);
  }

  async markUncertain(deliveryId: string, attemptId: string, code: string, now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE deliveries SET status='uncertain',retryable=0,last_error_code=?3,updated_at=?4
        WHERE id=?1 AND status='sending' AND attempt_id=?2`).bind(deliveryId, attemptId, code, now),
      this.db.prepare(`UPDATE delivery_attempts SET state='uncertain',finished_at=?3,error_code=?4,
        response_summary_json=json('{"audit":[]}') WHERE id=?1 AND delivery_id=?2 AND state='calling'`)
        .bind(attemptId, deliveryId, now, code),
      this.db.prepare(`UPDATE digests SET status='uncertain',updated_at=?2 WHERE id=(SELECT digest_id FROM deliveries WHERE id=?1)
        AND status='sending' AND EXISTS (SELECT 1 FROM deliveries WHERE id=?1 AND status='uncertain' AND attempt_id=?3)`)
        .bind(deliveryId, now, attemptId),
    ]);
  }

  async staleSending(now: number, ageMs = 300_000): Promise<Array<{ id: string; attemptId: string }>> {
    const rows = await this.db.prepare(`SELECT id,attempt_id FROM deliveries WHERE status='sending' AND attempt_id IS NOT NULL
      AND claimed_at<=?1 ORDER BY claimed_at LIMIT 20`).bind(now - ageMs).all<{ id: string; attempt_id: string }>();
    return rows.results.map((row) => ({ id: row.id, attemptId: row.attempt_id }));
  }

  async retryable(now: number): Promise<Array<{ digestId: string; generation: number }>> {
    const rows = await this.db.prepare(`SELECT delivery.digest_id,d.build_generation FROM deliveries delivery
      JOIN digests d ON d.id=delivery.digest_id WHERE delivery.status='failed' AND delivery.retryable=1
      AND delivery.next_attempt_at<=?1 AND ?1<d.send_deadline_at ORDER BY delivery.next_attempt_at LIMIT 20`)
      .bind(now).all<{ digest_id: string; build_generation: number }>();
    return rows.results.map((row) => ({ digestId: row.digest_id, generation: row.build_generation }));
  }
}
