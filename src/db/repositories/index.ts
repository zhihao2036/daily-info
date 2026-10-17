import type { BodyRetryCandidate, Clock, FrozenCandidate, Id, Json, Lease, RunAccepted } from '../../domain/contracts';
import { DigestRepository } from './digests';
import { ItemRepository, type BeginPageInput, type CommitPageInput, type FinalizePageInput, type StagePageInput } from './items';
import { RequestRepository } from './requests';
import { systemClock } from './shared';
import { SourceRepository } from './sources';

export { BrowserFallbackRepository } from './browser-fallback';

export interface Persistence {
  acquireLease(sourceId: Id, ownerId: Id, now: number): Promise<Lease | null>;
  renewLease(lease: Lease, now: number): Promise<Lease | null>;
  commitPage(input: CommitPageInput): Promise<void>;
  freezeCandidates(digestId: Id, generation: number): Promise<FrozenCandidate[]>;
  registerRequest(input: { scope: string; key: string; requestHash: string; params: Json; now: number }): Promise<RunAccepted>;
}

export class D1Persistence implements Persistence {
  private readonly sources: SourceRepository;
  private readonly items: ItemRepository;
  private readonly digests: DigestRepository;
  private readonly requests: RequestRepository;

  constructor(db: D1Database, clock: Clock = systemClock) {
    this.sources = new SourceRepository(db, clock);
    this.items = new ItemRepository(db, clock);
    this.digests = new DigestRepository(db, clock);
    this.requests = new RequestRepository(db);
  }

  acquireLease(sourceId: Id, ownerId: Id, now: number): Promise<Lease | null> {
    return this.sources.acquireLease(sourceId, ownerId, now);
  }
  renewLease(lease: Lease, now: number): Promise<Lease | null> { return this.sources.renewLease(lease, now); }
  markSourceSuccess(lease: Lease, now: number, etag?: string, lastModified?: string): Promise<void> {
    return this.sources.markSuccess(lease, now, etag, lastModified);
  }
  markSourceFailure(lease: Lease, errorCode: string, now: number): Promise<void> {
    return this.sources.markFailure(lease, errorCode, now);
  }
  beginPage(input: BeginPageInput): Promise<'pending' | 'committed'> { return this.items.beginPage(input); }
  stagePageItems(input: StagePageInput): Promise<void> { return this.items.stagePageItems(input); }
  finalizePage(input: FinalizePageInput): Promise<void> { return this.items.finalizePage(input); }
  commitPage(input: CommitPageInput): Promise<void> { return this.items.commitPage(input); }
  findBodyRetryCandidates(sourceId: string, now: number, limit = 20): Promise<BodyRetryCandidate[]> {
    return this.items.findBodyRetryCandidates(sourceId, now, limit);
  }
  freezeCandidates(digestId: Id, generation: number): Promise<FrozenCandidate[]> {
    return this.digests.freezeCandidates(digestId, generation);
  }
  registerRequest(input: { scope: string; key: string; requestHash: string; params: Json; now: number }): Promise<RunAccepted> {
    return this.requests.registerRequest(input);
  }
}
