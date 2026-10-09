const pad = value => String(value).padStart(2, '0');
const utc = day => { const [y, m, d] = day.split('-').map(Number); const date = new Date(0); date.setUTCFullYear(y, m - 1, d); date.setUTCHours(0, 0, 0, 0); return date; };
const format = date => `${String(date.getUTCFullYear()).padStart(4, '0')}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

export function isCivilDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  return format(utc(value)) === value;
}

export function isCivilMonth(value) { return typeof value === 'string' && /^\d{4}-\d{2}$/.test(value) && isCivilDate(`${value}-01`); }

export function addCivilDays(day, delta) {
  if (!isCivilDate(day) || !Number.isInteger(delta)) throw Object.assign(new Error('日期或天数无效'), { status: 400 });
  const date = utc(day); date.setUTCDate(date.getUTCDate() + delta);
  const result = format(date);
  if (!isCivilDate(result)) throw Object.assign(new Error('日期超出支持范围'), { status: 400 });
  return result;
}

export function monthGrid(month, { weekStartsOn = 1 } = {}) {
  if (!isCivilMonth(month) || weekStartsOn !== 1) throw Object.assign(new Error('月份无效'), { status: 400 });
  const first = `${month}-01`, offset = (utc(first).getUTCDay() + 6) % 7;
  const start = utc(first); start.setUTCDate(start.getUTCDate() - offset);
  // Keep weekday alignment at the supported civil-year boundaries without
  // inventing selectable dates in year 0000 or 10000.
  return Array.from({ length: 42 }, (_, i) => { const day = format(new Date(start.getTime() + i * 86400000)); return { day: isCivilDate(day) ? day : null, inMonth: day.slice(0, 7) === month }; });
}

export function validateDateRange({ from, to, maxDays = 366 }) {
  if (!isCivilDate(from) || !isCivilDate(to) || from > to) throw Object.assign(new Error('需要有效且有序的 from/to 日期'), { status: 400, code: 'INVALID_DATE_RANGE' });
  const days = Math.round((utc(to) - utc(from)) / 86400000) + 1;
  if (days > maxDays) throw Object.assign(new Error(`日期范围最多 ${maxDays} 天`), { status: 400, code: 'DATE_RANGE_TOO_LONG' });
  return { from, to, days };
}
