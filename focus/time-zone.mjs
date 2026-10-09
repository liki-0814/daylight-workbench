import { addCivilDays, validateDateRange } from '../core/date.js';

export function createTimeZoneAdapter() {
  const formatters = new Map(), boundaries = new Map();
  const formatter = timeZone => {
    if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }));
    return formatters.get(timeZone);
  };
  const dateAt = (time, timeZone) => {
    const parts = Object.fromEntries(formatter(timeZone).formatToParts(time).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
  };
  const boundary = (day, timeZone) => {
    const key = `${timeZone}/${day}`;
    if (boundaries.has(key)) return boundaries.get(key);
    const [y, m, d] = day.split('-').map(Number), center = new Date(0); center.setUTCFullYear(y, m - 1, d); center.setUTCHours(0, 0, 0, 0);
    let lo = center.getTime() - 48 * 3600000, hi = center.getTime() + 48 * 3600000;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (dateAt(mid, timeZone) < day) lo = mid + 1; else hi = mid; }
    const value = { at: lo, exists: dateAt(lo, timeZone) === day };
    // Bounded derived cache: never trim the actual session history.
    if (boundaries.size >= 2000) boundaries.clear();
    boundaries.set(key, value); return value;
  };
  return {
    validateTimeZone(timeZone) {
      if (typeof timeZone !== 'string' || !(timeZone === 'UTC' || timeZone.includes('/'))) throw new Error('统计时区必须是可识别的 IANA 时区');
      formatter(timeZone); return timeZone;
    },
    systemTimeZone() { try { const zone = Intl.DateTimeFormat().resolvedOptions().timeZone; return zone === 'UTC' || zone.includes('/') ? zone : 'UTC'; } catch { return 'UTC'; } },
    dateAt,
    windows(from, to, timeZone) {
      const { days } = validateDateRange({ from, to, maxDays: 366 });
      formatter(timeZone);
      return Array.from({ length: days }, (_, i) => { const day = addCivilDays(from, i), start = boundary(day, timeZone), end = boundary(addCivilDays(day, 1), timeZone); return { day, startAt: start.at, endAt: end.at, exists: start.exists }; });
    },
  };
}

export const timeZoneAdapter = createTimeZoneAdapter();
export const dayWindows = (from, to, timeZone) => timeZoneAdapter.windows(from, to, timeZone);
