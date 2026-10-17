import type { DigestTimes, EpochMs } from '../domain/contracts';

const TIMEZONE = 'Asia/Shanghai';

function localDate(at: number, timezone: string): string {
  if (timezone !== TIMEZONE) throw new Error('CONFIG_INVALID:TIMEZONE');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shanghaiTime(date: string, time: string): number {
  const value = Date.parse(`${date}T${time}:00+08:00`);
  if (!Number.isFinite(value)) throw new Error('INVALID_LOCAL_DATE');
  return value;
}

export function digestTimes(
  scheduledAt: EpochMs,
  timezone: 'Asia/Shanghai' = TIMEZONE,
): DigestTimes {
  const date = localDate(scheduledAt, timezone);
  return {
    localDate: date,
    morningAt: shanghaiTime(date, '07:45'),
    cutoffAt: shanghaiTime(date, '08:00'),
    buildDeadlineAt: shanghaiTime(date, '08:25'),
    sendAt: shanghaiTime(date, '08:30'),
    sendDeadlineAt: shanghaiTime(date, '09:00'),
  };
}

export function previewTimes(date: string, createdAt: EpochMs): DigestTimes {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || localDate(shanghaiTime(date, '12:00'), TIMEZONE) !== date) {
    throw new Error('INVALID_LOCAL_DATE');
  }
  const nominalCutoff = shanghaiTime(date, '08:00');
  return {
    localDate: date,
    morningAt: createdAt,
    cutoffAt: date === localDate(createdAt, TIMEZONE) ? createdAt : nominalCutoff,
    buildDeadlineAt: createdAt + 3 * 60_000,
    sendAt: createdAt + 4 * 60_000,
    sendDeadlineAt: createdAt + 5 * 60_000,
  };
}

export function isRecoveryMinute(now: EpochMs): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.hour === '08' && ['35', '40', '45', '50', '55'].includes(values.minute ?? '');
}
