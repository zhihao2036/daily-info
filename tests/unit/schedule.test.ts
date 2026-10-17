import { describe, expect, it } from 'vitest';
import { digestTimes, previewTimes } from '../../src/scheduler/time';
import { stableJobId } from '../../src/scheduler/dispatch';

describe('schedule time boundaries', () => {
  it('maps UTC evening to next local digest date', () => {
    const times = digestTimes(Date.parse('2026-09-20T23:45:00Z'));
    expect(times.localDate).toBe('2026-09-21');
    expect(new Date(times.cutoffAt).toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(new Date(times.sendDeadlineAt).toISOString()).toBe('2026-09-21T01:00:00.000Z');
  });

  it('rejects timezones outside the v1 contract', () => {
    expect(() => digestTimes(Date.now(), 'UTC' as 'Asia/Shanghai')).toThrow('CONFIG_INVALID:TIMEZONE');
  });

  it('gives historical previews a fresh five minute deadline', () => {
    const createdAt = Date.parse('2026-09-21T10:00:00Z');
    const times = previewTimes('2026-08-31', createdAt);
    expect(times.localDate).toBe('2026-08-31');
    expect(times.cutoffAt).toBe(Date.parse('2026-08-31T00:00:00Z'));
    expect(times.sendDeadlineAt).toBe(createdAt + 5 * 60_000);
    expect(times.buildDeadlineAt).toBeLessThan(times.sendDeadlineAt);
  });

  it('uses the current instant as today preview cutoff before 08:00 Shanghai time', () => {
    const createdAt = Date.parse('2026-09-20T23:00:00Z');
    const times = previewTimes('2026-09-21', createdAt);
    expect(times.cutoffAt).toBe(createdAt);
    expect(times.cutoffAt).toBeLessThan(times.buildDeadlineAt);
  });

  it('includes newly collected articles in today previews after 08:00 Shanghai time', () => {
    const createdAt = Date.parse('2026-09-21T04:00:00Z');
    expect(previewTimes('2026-09-21', createdAt).cutoffAt).toBe(createdAt);
  });
});

describe('stable workflow identifiers', () => {
  it('hashes a business key into a deterministic safe identifier', async () => {
    const first = await stableJobId('digest:personal:2026-09-21:0', 'digest');
    const second = await stableJobId('digest:personal:2026-09-21:0', 'digest');
    expect(second).toBe(first);
    expect(first).toMatch(/^digest-[a-f0-9]{64}$/);
    expect(first.length).toBeLessThanOrEqual(100);
  });
});
