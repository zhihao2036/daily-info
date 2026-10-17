import { DeliveryRepository } from '../db/repositories/delivery';
import { sha256 } from '../db/repositories/shared';
import type { Clock, DeliveryPayload, SendResult, Sender } from '../domain/contracts';

export interface DeliveryDependencies {
  db: D1Database;
  clock: Clock;
  sender: Sender;
  sendEnabled: boolean;
  channel: 'dummy' | 'cloudflare_email' | 'telegram';
  destinationConfigRef: string;
  destinationKey: string;
  configurationMatches?: boolean;
}

interface DigestRow {
  id: string; mode: 'scheduled' | 'preview'; status: string; build_generation: number;
  local_date: string; send_at: number; send_deadline_at: number; rendered_text: string | null;
  rendered_html: string | null; content_hash: string | null;
}

async function readDigest(db: D1Database, digestId: string): Promise<DigestRow> {
  const row = await db.prepare(`SELECT id,mode,status,build_generation,local_date,send_at,send_deadline_at,
    rendered_text,rendered_html,content_hash FROM digests WHERE id=?1`).bind(digestId).first<DigestRow>();
  if (row === null) throw new Error('DIGEST_NOT_FOUND');
  return row;
}

function suppression(row: DigestRow, dependencies: DeliveryDependencies): 'preview' | 'send_disabled' | 'dummy' | 'deadline' | 'config_changed' | null {
  if (row.mode === 'preview') return 'preview';
  if (dependencies.configurationMatches === false) return 'config_changed';
  if (!dependencies.sendEnabled) return 'send_disabled';
  if (dependencies.channel === 'dummy') return 'dummy';
  const now = dependencies.clock.now();
  if (now < row.send_at || now >= row.send_deadline_at) return 'deadline';
  return null;
}

export async function deliverDigest(digestId: string, generation: number, dependencies: DeliveryDependencies): Promise<SendResult> {
  const row = await readDigest(dependencies.db, digestId);
  const repository = new DeliveryRepository(dependencies.db);
  const payload: DeliveryPayload = { subject: `AI / Agent 早报 · ${row.local_date}`, text: row.rendered_text ?? '',
    html: row.rendered_html ?? '', destinationConfigRef: dependencies.destinationConfigRef,
    payloadHash: row.content_hash ?? await sha256(`${row.rendered_text ?? ''}\n${row.rendered_html ?? ''}`) };
  const reason = suppression(row, dependencies);
  let current = await repository.findForDigest(digestId);
  if (current !== null && (current.channel !== dependencies.channel || current.destinationKey !== dependencies.destinationKey
    || current.destinationConfigRef !== dependencies.destinationConfigRef)) {
    await repository.suppress(current.id, 'CONFIG_CHANGED', dependencies.clock.now());
    return { kind: 'suppressed', reason: 'config_changed' };
  }
  if (current === null) {
    current = await repository.ensure({ digestId, channel: dependencies.channel, destinationKey: dependencies.destinationKey,
      destinationConfigRef: dependencies.destinationConfigRef, payload, status: reason === null ? 'pending' : 'suppressed',
      ...(reason === null ? {} : { reason: reason.toUpperCase() }), now: dependencies.clock.now() });
  }
  if (reason !== null) {
    await repository.suppress(current.id, reason.toUpperCase(), dependencies.clock.now());
    if (reason === 'deadline' && dependencies.clock.now() >= row.send_deadline_at) {
      await dependencies.db.prepare(`UPDATE digests SET status='expired',updated_at=?2
        WHERE id=?1 AND status IN ('collecting','building','ready','delivery_failed')`)
        .bind(digestId, dependencies.clock.now()).run();
    }
    return { kind: 'suppressed', reason };
  }
  if (row.build_generation !== generation) return { kind: 'suppressed', reason: 'deadline' };
  if (current.status === 'sent') return { kind: 'accepted', providerMessageId: current.providerMessageId, acceptedAt: current.acceptedAt ?? dependencies.clock.now() };
  if (current.status === 'uncertain' || current.status === 'sending' || current.status === 'suppressed') return { kind: 'uncertain', code: 'CLAIM_UNAVAILABLE' };
  const attemptId = await repository.claim(current, generation, dependencies.clock.now());
  if (attemptId === null) return { kind: 'uncertain', code: 'CLAIM_LOST' };
  const beforeCall = dependencies.clock.now();
  if (beforeCall >= row.send_deadline_at) {
    await repository.settle(current.id, attemptId, { kind: 'rejected', retryable: false, code: 'DEADLINE_BEFORE_CALL' }, beforeCall);
    await dependencies.db.prepare(`UPDATE digests SET status='expired',updated_at=?2
      WHERE id=?1 AND status='delivery_failed'`).bind(digestId, beforeCall).run();
    return { kind: 'suppressed', reason: 'deadline' };
  }
  let result: SendResult;
  try { result = await dependencies.sender.send(current.payload, attemptId, new AbortController().signal); }
  catch { result = { kind: 'uncertain', code: 'SENDER_THROW' }; }
  if (result.kind === 'suppressed') {
    await repository.markUncertain(current.id, attemptId, 'UNEXPECTED_SUPPRESSION_AFTER_CLAIM', dependencies.clock.now());
    return { kind: 'uncertain', code: 'UNEXPECTED_SUPPRESSION_AFTER_CLAIM' };
  }
  await repository.settle(current.id, attemptId, result, dependencies.clock.now());
  return result;
}

export async function recoverDeliveries(now: number, dependencies: DeliveryDependencies): Promise<void> {
  const repository = new DeliveryRepository(dependencies.db);
  for (const stale of await repository.staleSending(now)) await repository.markUncertain(stale.id, stale.attemptId, 'STALE_CALLING', now);
  for (const retry of await repository.retryable(now)) await deliverDigest(retry.digestId, retry.generation, dependencies);
}
