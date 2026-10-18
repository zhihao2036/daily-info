import type { SendResult } from '../domain/contracts';
import { sha256 } from '../db/repositories/shared';

type Accepted = Extract<SendResult, { kind: 'accepted' }>;
export interface TelegramOutbox {
  claim(deliveryId: string, ordinal: number, text: string, attemptId: string, now: number): Promise<'claimed' | SendResult>;
  settle(deliveryId: string, ordinal: number, attemptId: string, result: SendResult, now: number): Promise<void>;
}

export function createTelegramOutbox(db: D1Database): TelegramOutbox {
  return {
    async claim(deliveryId, ordinal, text, attemptId, now) {
      const hash = await sha256(text);
      // Claim and initialize in one query so ten messages fit the Free plan request budget.
      const claimed = await db.prepare(`INSERT INTO telegram_messages(delivery_id,ordinal,text_hash,status,attempt_id,updated_at)
        SELECT ?1,?2,?3,'sending',?4,?5 WHERE EXISTS (
          SELECT 1 FROM deliveries d JOIN digests g ON g.id=d.digest_id
          WHERE d.id=?1 AND d.status='sending' AND d.attempt_id=?4 AND g.send_at<=?5 AND ?5<g.send_deadline_at)
        ON CONFLICT(delivery_id,ordinal) DO UPDATE SET status='sending',attempt_id=excluded.attempt_id,updated_at=excluded.updated_at
        WHERE telegram_messages.text_hash=excluded.text_hash AND (telegram_messages.status='pending'
          OR (telegram_messages.status='failed' AND telegram_messages.retryable=1 AND telegram_messages.next_attempt_at<=?5))
        RETURNING ordinal`).bind(deliveryId, ordinal, hash, attemptId, now).first<{ ordinal: number }>();
      if (claimed !== null) return 'claimed';
      const row = await db.prepare(`SELECT text_hash,status,provider_message_id,accepted_at,retryable,next_attempt_at,error_code
        FROM telegram_messages WHERE delivery_id=?1 AND ordinal=?2`).bind(deliveryId, ordinal).first<{
          text_hash: string; status: string; provider_message_id: string | null; accepted_at: number | null;
          retryable: number; next_attempt_at: number | null; error_code: string | null;
        }>();
      if (!row) return { kind: 'suppressed', reason: 'deadline' };
      if (row.text_hash !== hash) return { kind: 'uncertain', code: 'TELEGRAM_CONTENT_CHANGED' };
      if (row.status === 'sent') return { kind: 'accepted', providerMessageId: row.provider_message_id, acceptedAt: row.accepted_at! } satisfies Accepted;
      if (row.status === 'sending' || row.status === 'uncertain') return { kind: 'uncertain', code: 'TELEGRAM_MESSAGE_UNCERTAIN' };
      if (row.status === 'failed' && (!row.retryable || (row.next_attempt_at ?? 0) > now)) {
        return { kind: 'rejected', retryable: !!row.retryable, code: row.error_code ?? 'TELEGRAM_MESSAGE_FAILED',
          ...(row.retryable ? { retryAfterMs: Math.max(1, (row.next_attempt_at ?? now) - now) } : {}) };
      }
      return { kind: 'suppressed', reason: 'deadline' };
    },
    async settle(deliveryId, ordinal, attemptId, result, now) {
      const accepted = result.kind === 'accepted';
      const rejected = result.kind === 'rejected';
      const retryable = rejected && result.retryable;
      const update = await db.prepare(`UPDATE telegram_messages SET status=?4,provider_message_id=?5,accepted_at=?6,
        retryable=?7,next_attempt_at=?8,error_code=?9,updated_at=?10
        WHERE delivery_id=?1 AND ordinal=?2 AND status='sending' AND attempt_id=?3`)
        .bind(deliveryId, ordinal, attemptId, accepted ? 'sent' : rejected ? 'failed' : 'uncertain',
          accepted ? result.providerMessageId : null, accepted ? result.acceptedAt : null,
          retryable ? 1 : 0, retryable ? now + (result.retryAfterMs ?? 300_000) : null,
          accepted ? null : 'code' in result ? result.code : 'TELEGRAM_UNEXPECTED_SUPPRESSION', now).run();
      if (update.meta.changes !== 1) throw new Error('TELEGRAM_MESSAGE_SETTLEMENT_LOST');
    },
  };
}
