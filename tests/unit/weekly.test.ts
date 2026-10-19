import { describe, expect, it } from 'vitest';
import { renderWeeklyReport, weeklyTimes } from '../../src/editorial/weekly';

describe('weekly recap', () => {
  it('uses the previous Monday through Sunday across a year boundary in Shanghai', () => {
    const times = weeklyTimes(Date.parse('2027-01-04T00:00:00Z'))!;
    expect(times.startDate).toBe('2026-12-28');
    expect(times.endDate).toBe('2027-01-03');
    expect(new Date(times.sendAt).toISOString()).toBe('2027-01-04T00:00:00.000Z');
    expect(weeklyTimes(Date.parse('2027-01-03T15:59:59Z'))).toBeNull();
    expect(weeklyTimes(Date.parse('2027-01-04T16:00:00Z'))).toBeNull();
  });

  it('retains all seventy weekly headlines and intact links across bounded messages', () => {
    const entries = Array.from({ length: 70 }, (_, index) => ({ eventId: `event-${index}`,
      title: `${index}：${'新闻摘要'.repeat(35)}`, url: `https://example.com/news/${index}`, localDate: '2026-10-18' }));
    const report = renderWeeklyReport('2026-10-12', '2026-10-18', entries);
    expect(report.entries).toHaveLength(70);
    expect(report.messages.length).toBeGreaterThan(1);
    expect(report.messages.every(message => message.length <= 4096)).toBe(true);
    for (const entry of entries) {
      expect(report.messages.flatMap(message => message.split('\n')).filter(line => line === entry.url)).toHaveLength(1);
      expect(report.text).toContain(entry.title);
    }
  });

  it('keeps the latest occurrence of a repeated event or URL', () => {
    const report = renderWeeklyReport('2026-10-12', '2026-10-18', [
      { eventId: 'a', title: '旧标题', url: 'https://example.com/a', localDate: '2026-10-12' },
      { eventId: 'a', title: '新标题', url: 'https://example.com/a', localDate: '2026-10-13' },
      { eventId: 'b', title: '同链接最新标题', url: 'https://example.com/a', localDate: '2026-10-14' },
    ]);
    expect(report.entries.map(entry => entry.title)).toEqual(['同链接最新标题']);
    expect(renderWeeklyReport('2026-10-12', '2026-10-18', []).text).toContain('没有已成功推送');
  });
});
