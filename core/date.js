const pad = value => String(value).padStart(2, '0');
const utc = day => { const [y, m, d] = day.split('-').map(Number); const date = new Date(0); date.setUTCFullYear(y, m - 1, d); date.setUTCHours(0, 0, 0, 0); return date; };
const format = date => `${String(date.getUTCFullYear()).padStart(4, '0')}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

export function isCivilDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  return format(utc(value)) === value;
}

export function addCivilDays(day, delta) {
  if (!isCivilDate(day) || !Number.isInteger(delta)) throw Object.assign(new Error('日期或天数无效'), { status: 400 });
  const date = utc(day); date.setUTCDate(date.getUTCDate() + delta);
  const result = format(date);
  if (!isCivilDate(result)) throw Object.assign(new Error('日期超出支持范围'), { status: 400 });
  return result;
}

export function validateDateRange({ from, to, maxDays = 366 }) {
  if (!isCivilDate(from) || !isCivilDate(to) || from > to) throw Object.assign(new Error('需要有效且有序的 from/to 日期'), { status: 400, code: 'INVALID_DATE_RANGE' });
  const days = Math.round((utc(to) - utc(from)) / 86400000) + 1;
  if (days > maxDays) throw Object.assign(new Error(`日期范围最多 ${maxDays} 天`), { status: 400, code: 'DATE_RANGE_TOO_LONG' });
  return { from, to, days };
}
