/**
 * Slots are stored as naive local wall-clock strings ("YYYY-MM-DDTHH:mm") in the
 * business timezone. ISO-like strings sort lexicographically, so comparisons stay
 * simple and no timezone library is needed.
 */

export const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function toLocalDateTime(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export function addDays(localDate: string, days: number): string {
  const d = new Date(`${localDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday */
export function weekday(localDate: string): number {
  return new Date(`${localDate}T00:00:00Z`).getUTCDay();
}

export function minutesToClock(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function clockToMinutes(clock: string): number {
  const [h, m] = clock.split(':').map(Number);
  return h * 60 + m;
}

export function isRealDate(localDate: string): boolean {
  if (!LOCAL_DATE_RE.test(localDate)) return false;
  const d = new Date(`${localDate}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === localDate;
}

/** "Monday 5 January, 10:00" */
export function humanLabel(localDateTime: string): string {
  const [date, time] = localDateTime.split('T');
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${date}T00:00:00Z`));
  return `${day.replace(',', '')}, ${time}`;
}
