import test from 'node:test';
import assert from 'node:assert/strict';
import { isCivilDate, addCivilDays, validateDateRange } from '../core/date.js';
import { dayWindows } from '../focus/time-zone.mjs';

test('civil dates reject normalization and use stable leap/month arithmetic', () => {
  for (const date of ['2026-02-30', '2025-02-29', '2026-13-01', '0000-01-01', '2026-1-01']) assert.equal(isCivilDate(date), false);
  assert.equal(isCivilDate('2024-02-29'), true);
  assert.equal(isCivilDate('0099-02-28'), true);
  assert.equal(addCivilDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addCivilDays('2026-12-31', 1), '2027-01-01');
  assert.throws(() => validateDateRange({ from: '2026-01-01', to: '2027-01-02', maxDays: 366 }));
});

test('statistics windows preserve DST 23/25-hour days and mark skipped dates', () => {
  const spring = dayWindows('2026-03-08', '2026-03-08', 'America/New_York')[0];
  const autumn = dayWindows('2026-11-01', '2026-11-01', 'America/New_York')[0];
  assert.equal(spring.endAt - spring.startAt, 23 * 3600000);
  assert.equal(autumn.endAt - autumn.startAt, 25 * 3600000);
  const skipped = dayWindows('2011-12-30', '2011-12-30', 'Pacific/Apia')[0];
  assert.equal(skipped.exists, false); assert.equal(skipped.endAt, skipped.startAt);
});
