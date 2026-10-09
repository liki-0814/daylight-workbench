import test from 'node:test';
import assert from 'node:assert/strict';
import { isCivilDate, addCivilDays, monthGrid, validateDateRange } from '../core/date.js';
import { dayWindows } from '../focus/time-zone.mjs';

test('civil dates reject normalization and use stable leap/month arithmetic', () => {
  for (const date of ['2026-02-30', '2025-02-29', '2026-13-01', '0000-01-01', '2026-1-01']) assert.equal(isCivilDate(date), false);
  assert.equal(isCivilDate('2024-02-29'), true);
  assert.equal(isCivilDate('0099-02-28'), true);
  assert.equal(addCivilDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addCivilDays('2026-12-31', 1), '2027-01-01');
  const grid = monthGrid('2026-10');
  assert.equal(grid.length, 42); assert.equal(grid[0].day, '2026-09-28'); assert.equal(grid.at(-1).day, '2026-11-08');
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

test('boundary-year month grids retain 42 aligned cells and pad unsupported dates', () => {
  for (const month of ['0001-01', '9999-11', '9999-12']) {
    const cells = monthGrid(month), valid = cells.filter(cell => cell.day);
    assert.equal(cells.length, 42);
    assert.ok(valid.every(cell => isCivilDate(cell.day)));
    assert.ok(valid.some(cell => cell.day === month + '-01'));
    for (let i = 1; i < valid.length; i++) assert.equal(addCivilDays(valid[i - 1].day, 1), valid[i].day);
  }
  assert.equal(monthGrid('0001-01')[0].day, '0001-01-01');
  const last = monthGrid('9999-12');
  assert.ok(last.some(cell => cell.day === '9999-12-31' && cell.inMonth));
  assert.equal(last.at(-1).day, null);
  assert.ok(last.filter(cell => !cell.day).every(cell => !cell.inMonth));
});
