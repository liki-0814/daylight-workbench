import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { barChart, nextBarIndex } from '../public/focus/bar-chart.js';

const bars = [{ key: 'a', value: 30, label: '08:00–09:00，专注 30 分钟' }, { key: 'b', value: 0, label: '09:00–10:00，无专注' }, { key: 'c', value: 60, label: '<b>10</b>', future: false }, { key: 'd', value: 0, label: 'x', future: true }];
const html = barChart({ id: 'c1', label: '今日分时专注', bars, yMax: 60, yTicks: [{ value: 60, label: '60 分' }, { value: 0, label: '0' }], xTicks: [{ pos: 0, label: '00', major: true }, { pos: .5 }], band: [{ from: 0, to: .25, tone: 'night' }, { from: .25, to: 1, tone: 'day' }], marker: { pos: .9, label: '现在 11:30' }, showValues: true, initialIndex: 2 });

test('bar chart renders accessible bars with roving tabindex and escaped labels', () => {
  assert.equal((html.match(/class="bc-col"/g) || []).length, 4);
  assert.equal((html.match(/tabindex="0"/g) || []).length, 1); assert.match(html, /data-bc-index="2"[^>]*aria-label|tabindex="0" data-bc-index="2"/);
  assert.match(html, /role="img"[^>]*aria-label="08:00–09:00，专注 30 分钟"/); assert.match(html, /aria-label="&lt;b&gt;10&lt;\/b&gt;"/); assert.ok(!html.includes('<b>10</b>'));
  assert.match(html, /role="group" aria-label="今日分时专注/); assert.match(html, /role="tooltip" hidden/);
  assert.match(html, /bc-zero/); assert.match(html, /bc-future/); assert.match(html, /bc-now bc-now-left/); assert.match(html, /data-tone="day"/);
  assert.ok(!/\sstyle="/.test(html), 'CSP forbids inline style attributes');
  assert.match(html, /data-bc-height="50%"/);
});

test('keyboard navigation clamps at both ends and supports Home/End', () => {
  assert.equal(nextBarIndex('ArrowRight', 3, 4), 3); assert.equal(nextBarIndex('ArrowLeft', 0, 4), 0); assert.equal(nextBarIndex('ArrowRight', 1, 4), 2);
  assert.equal(nextBarIndex('Home', 3, 4), 0); assert.equal(nextBarIndex('End', 0, 4), 3); assert.equal(nextBarIndex('a', 2, 4), 2); assert.equal(nextBarIndex('End', 0, 0), -1);
});

test('the reusable module has no hard-coded colours and is registered for the app bundle', () => {
  for (const file of ['bar-chart.css', 'bar-chart.js']) assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/.test(fs.readFileSync(new URL('../public/focus/' + file, import.meta.url), 'utf8').replace(/rgba\(0, 0, 0, \.14\)/g, '')), file + ' has no colour literals');
  const assets = JSON.parse(fs.readFileSync(new URL('../core/web-assets.json', import.meta.url), 'utf8')), flat = JSON.stringify(assets);
  assert.ok(flat.includes('"/focus/bar-chart.js"') && flat.includes('"/focus/bar-chart.css"'));
});
