import {
  addDays,
  clockToMinutes,
  humanLabel,
  isRealDate,
  minutesToClock,
  toLocalDateTime,
  weekday,
} from './local-time';

describe('local-time', () => {
  it('converts an instant to wall-clock time in a timezone', () => {
    const instant = new Date('2026-07-01T22:30:00Z');
    expect(toLocalDateTime(instant, 'Europe/Paris')).toBe('2026-07-02T00:30');
    expect(toLocalDateTime(instant, 'America/New_York')).toBe('2026-07-01T18:30');
    expect(toLocalDateTime(instant, 'UTC')).toBe('2026-07-01T22:30');
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('returns the weekday of a local date', () => {
    expect(weekday('2026-01-05')).toBe(1);
    expect(weekday('2026-01-04')).toBe(0);
  });

  it('converts between minutes and HH:mm', () => {
    expect(minutesToClock(9 * 60 + 5)).toBe('09:05');
    expect(clockToMinutes('17:30')).toBe(1050);
  });

  it('validates calendar dates', () => {
    expect(isRealDate('2026-02-28')).toBe(true);
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('2026-2-3')).toBe(false);
    expect(isRealDate('2026-13-01')).toBe(false);
  });

  it('formats a human label', () => {
    expect(humanLabel('2026-01-05T10:30')).toBe('Monday 5 January, 10:30');
  });
});
