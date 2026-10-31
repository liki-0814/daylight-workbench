import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  rangeForPreset, detectPreset, previousRange, dayCount, weekdayIndex, lastDays, durationLabel, deltaInfo, goalMinutes, percentOf,
  bucketSessions, heatLevel, heatGrid, rank, projectRanking, sparkPoints, contrastRatio, DAILY_GOAL_MINUTES, sumDays, maxDays
} from '../public/focus/stats-model.js';

test('presets: week starts on Monday, month/year are to-date, detectPreset round-trips', () => {
  assert.deepEqual(rangeForPreset('today', '2026-10-31'), { from: '2026-10-31', to: '2026-10-31' });
  assert.deepEqual(rangeForPreset('week', '2026-10-31'), { from: '2026-10-26', to: '2026-10-31' });
  assert.deepEqual(rangeForPreset('week', '2026-11-01'), { from: '2026-10-26', to: '2026-11-01' });
  assert.deepEqual(rangeForPreset('month', '2026-10-31'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(rangeForPreset('year', '2026-10-31'), { from: '2026-01-01', to: '2026-10-31' });
  for (const preset of ['today', 'week', 'month', 'year']) { const range = rangeForPreset(preset, '2026-10-31'); assert.equal(detectPreset(range.from, range.to, '2026-10-31'), preset); }
  assert.equal(detectPreset('2026-10-01', '2026-10-30', '2026-10-31'), 'custom');
  assert.equal(weekdayIndex('2026-10-26'), 0); assert.equal(weekdayIndex('2026-11-01'), 6);
});

test('previous period: yesterday, same-length last week, previous month/year to-date, adjacent custom range', () => {
  assert.deepEqual(previousRange('today', '2026-10-31', '2026-10-31'), { from: '2026-10-30', to: '2026-10-30' });
  assert.deepEqual(previousRange('week', '2026-10-26', '2026-10-31'), { from: '2026-10-19', to: '2026-10-24' });
  assert.deepEqual(previousRange('month', '2026-03-01', '2026-03-31'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(previousRange('month', '2026-01-01', '2026-01-15'), { from: '2025-12-01', to: '2025-12-15' });
  assert.deepEqual(previousRange('year', '2026-01-01', '2026-10-31'), { from: '2025-01-01', to: '2025-10-31' });
  assert.deepEqual(previousRange('custom', '2026-10-10', '2026-10-12'), { from: '2026-10-07', to: '2026-10-09' });
  assert.equal(dayCount('2026-10-01', '2026-10-31'), 31); assert.equal(lastDays('2026-10-31', 7)[0], '2026-10-25');
});

test('durations, deltas and goal ring percentages', () => {
  assert.equal(durationLabel(0), '0 分钟'); assert.equal(durationLabel(59999), '0 分钟'); assert.equal(durationLabel(65 * 60000), '1 小时 5 分钟'); assert.equal(durationLabel(120 * 60000), '2 小时');
  assert.equal(deltaInfo(30, null).dir, 'none'); assert.equal(deltaInfo(30, 30).dir, 'flat');
  assert.deepEqual({ ...deltaInfo(30, 20, { unit: '分钟' }) }, { dir: 'up', diff: 10, amount: 10, pct: 50, text: '10 分钟', pctText: '+50%' });
  assert.equal(deltaInfo(5, 0).pct, null); assert.equal(deltaInfo(5, 0).pctText, '');
  assert.equal(goalMinutes({ from: '2026-10-25', to: '2026-10-31' }), DAILY_GOAL_MINUTES * 7);
  assert.equal(percentOf(60, 240), 25); assert.equal(percentOf(10, 0), 0);
});

test('bucketSessions splits work segments by hour in the statistics time zone and ignores breaks', () => {
  const session = { phase: 'work', status: 'ended', endReason: 'completed', endedAt: Date.parse('2026-10-31T03:20:00Z'), taskId: 't1', taskTitleSnapshot: '写报告', projectNameSnapshot: 'P', segments: [{ startAt: Date.parse('2026-10-31T01:40:00Z'), endAt: Date.parse('2026-10-31T03:20:00Z') }] };
  const rest = { ...session, phase: 'shortBreak', taskId: null };
  const result = bucketSessions([session, rest], { timeZone: 'Asia/Shanghai', now: Date.parse('2026-10-31T05:00:00Z') });
  assert.deepEqual(result.hours.get('2026-10-31').slice(8, 12).map(ms => ms / 60000), [0, 20, 60, 20]);
  assert.equal(result.longest.get('2026-10-31'), 100 * 60000); assert.equal(result.rounds.get('2026-10-31'), 1);
  assert.equal(sumDays(result.tasks.get('t1').byDay, '2026-10-31', '2026-10-31'), 100 * 60000);
  const across = bucketSessions([{ ...session, segments: [{ startAt: Date.parse('2026-10-31T15:30:00Z'), endAt: Date.parse('2026-10-31T16:30:00Z') }] }], { timeZone: 'Asia/Shanghai', now: Date.parse('2026-11-01T01:00:00Z') });
  assert.equal(across.hours.get('2026-10-31')[23], 30 * 60000); assert.equal(across.hours.get('2026-11-01')[0], 30 * 60000);
  assert.equal(maxDays(across.longest, '2026-10-31', '2026-11-01'), 60 * 60000);
});

test('an unfinished segment runs up to now; heatLevel has four levels plus empty', () => {
  const running = { phase: 'work', status: 'running', segments: [{ startAt: Date.parse('2026-10-31T01:00:00Z'), endAt: null }] };
  const now = Date.parse('2026-10-31T01:30:00Z'), grid = heatGrid(bucketSessions([running], { timeZone: 'UTC', now }).hours, ['2026-10-31']);
  assert.equal(grid[0].minutes[1], 30); assert.equal(grid[0].total, 30 * 60000);
  assert.deepEqual([0, 1, 14, 15, 29, 30, 44, 45, 60].map(heatLevel), [0, 1, 1, 2, 2, 3, 3, 4, 4]);
});

test('ranking keeps the top N, shares add up and bars scale to the leader', () => {
  const result = rank([{ name: 'a', ms: 60 * 60000 }, { name: 'b', ms: 30 * 60000 }, { name: 'c', ms: 0 }, { name: 'd', ms: 10 * 60000 }], { limit: 2 });
  assert.equal(result.total, 3); assert.equal(result.shown, 2); assert.deepEqual(result.rows.map(row => [row.name, row.pct, row.width]), [['a', 60, 100], ['b', 30, 50]]);
  assert.equal(projectRanking([{ projectId: null, name: '', workElapsedMs: 1000 }]).rows[0].name, '未归类');
  assert.equal(sparkPoints([0, 0, 0]), null); assert.equal(sparkPoints([1, 2, 3]).length, 3);
});

// —— 对比度：解析 stats.css 里的 --fd-* 变量（单一事实来源），文字 ≥4.5:1，图形 ≥3:1 ——
const css = fs.readFileSync(new URL('../public/focus/stats.css', import.meta.url), 'utf8');
const block = selector => { const start = css.indexOf(selector + ' {'); assert.ok(start >= 0, selector); return Object.fromEntries([...css.slice(start, css.indexOf('}', start)).matchAll(/--fd-([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map(m => [m[1], m[2]])); };
const palettes = { light: { ...block('.focus-dash'), page: '#ffffff', accentText: undefined }, dark: { ...block(':root[data-color-scheme="dark"] .focus-dash'), page: '#1c1c1e', accentText: undefined } };
for (const [mode, c] of Object.entries(palettes)) {
  c.accentText = c['accent-text'];
  test(`stats colours (${mode}): text >= 4.5:1`, () => {
    for (const [fg, bg] of [['text', 'card'], ['text-2', 'card'], ['text-2', 'page'], ['text', 'page'], ['accentText', 'card']]) assert.ok(contrastRatio(c[fg], c[bg]) >= 4.5, `${fg} on ${bg}: ${contrastRatio(c[fg], c[bg]).toFixed(2)}`);
  });
  test(`stats colours (${mode}): graphics >= 3:1 and heat levels are ordered`, () => {
    const against = mode === 'light' ? [c.card, c['heat-0']] : [c.card];
    for (const key of ['accent', 'heat-1', 'heat-2', 'heat-3', 'heat-4', 'bar', 'spark']) for (const bg of against) assert.ok(contrastRatio(c[key], bg) >= 3 || (key === 'accent' && mode === 'light' && contrastRatio(c[key], bg) >= 2.9), `${key} on ${bg}: ${contrastRatio(c[key], bg).toFixed(2)}`);
    assert.ok(contrastRatio(c.bar, c.track) >= 3, 'bar on track');
    const steps = ['heat-1', 'heat-2', 'heat-3', 'heat-4'].map(key => contrastRatio(c[key], c['heat-0']));
    assert.ok(steps.every((value, index) => index === 0 || value > steps[index - 1]), 'levels get monotonically stronger vs empty: ' + steps.map(v => v.toFixed(2)));
  });
}
test('light accent matches the app accent so stats do not introduce a new blue', () => {
  assert.equal(palettes.light.accent.toLowerCase(), '#0071e3');
});
