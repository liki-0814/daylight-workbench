import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { highlight, countLabel, probeTime, rowMarkup, tableHeader, loadingState, failureState, emptyState, noMatchState, skeletonRows } from '../public/extensions/list.js';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const css = read('public/extensions/extensions.css'), page = read('public/extensions/page.js');

test('highlight escapes first, marks every case-insensitive hit and never treats the query as a pattern', () => {
  assert.equal(highlight('Review <Code> review', 'review'), '<mark>Review</mark> &lt;Code&gt; <mark>review</mark>');
  assert.equal(highlight('a.b', '.'), 'a<mark>.</mark>b');
  assert.equal(highlight('a(b', '(' ), 'a<mark>(</mark>b');
  assert.equal(highlight('<img onerror=1>', ''), '&lt;img onerror=1&gt;');
  assert.equal(highlight('<b>', '<b>'), '<mark>&lt;b&gt;</mark>');
  assert.equal(highlight(undefined, 'x'), '');
});
test('count label says "N 项" when nothing is filtered out and "显示 a / b" otherwise', () => {
  assert.equal(countLabel(15, 15), '15 项'); assert.equal(countLabel(8, 15), '显示 8 / 15'); assert.equal(countLabel(0, 3), '显示 0 / 3');
});
test('probe time shows hours and minutes only and never invents a time', () => {
  assert.equal(probeTime(null), ''); assert.equal(probeTime({}), ''); assert.equal(probeTime({ finishedAt: 'nope' }), '');
  assert.match(probeTime({ finishedAt: '2026-10-30T06:03:09.000Z' }), /^\d\d:\d\d$/);
});
test('a row keeps the selectors the suites rely on and puts the mono id in MCP rows only', () => {
  const item = { id: 'github', name: 'GitHub "x"' };
  const mcp = rowMarkup({ tab: 'mcp', item, active: true, query: 'git', summary: '', sourceText: '共享来源', statusCells: ['<b>stdio</b>', '<b>ok</b>'] });
  assert.match(mcp, /class="extension-row selected"/); assert.match(mcp, /data-extension-id="github"/); assert.match(mcp, /aria-current="true"/);
  assert.match(mcp, /<code class="extension-row-id"><mark>git<\/mark>hub<\/code>/); assert.match(mcp, /<mark>Git<\/mark>Hub &quot;x&quot;/);
  assert.equal((mcp.match(/role="cell"/g) || []).length, 3);
  const skill = rowMarkup({ tab: 'skills', item, active: false, summary: 'd', statusCells: ['x'] });
  assert.doesNotMatch(skill, /extension-row-id|aria-current/); assert.match(skill, /class="extension-row "/);
});
test('table headers: one column title per cell, per tab', () => {
  for (const [tab, cells] of [['skills', 3], ['mcp', 4], ['clients', 2]]) assert.equal((tableHeader(tab).match(/role="columnheader"/g) || []).length, cells, tab);
});
test('loading: text stays in the DOM, skeleton only after 300ms, text visible only after 1s', () => {
  assert.doesNotMatch(loadingState({ elapsed: 0 }), /extension-skeleton/); assert.match(loadingState({ elapsed: 0 }), /extension-visually-hidden[^>]*>正在读取扩展来源/);
  assert.match(loadingState({ elapsed: 300 }), /extension-skeleton/); assert.match(loadingState({ elapsed: 300 }), /extension-visually-hidden/);
  assert.doesNotMatch(loadingState({ elapsed: 1000 }), /extension-visually-hidden/); assert.match(loadingState({ elapsed: 1000 }), /aria-busy="true"/);
  assert.match(skeletonRows(2), /aria-hidden="true"/); assert.equal((skeletonRows(2).match(/extension-skeleton-row/g) || []).length, 2);
});
test('failure, empty and no-match states each carry a button with a stable hook', () => {
  assert.match(failureState({ reason: '<x>' }), /role="alert"[\s\S]*&lt;x&gt;[\s\S]*data-extension-refresh/);
  assert.match(emptyState('skills'), /还没有 Skill[\s\S]*data-empty-create[^>]*>添加 Skill/); assert.match(emptyState('mcp', { blocked: true }), /data-empty-create disabled/);
  assert.match(noMatchState(), /data-clear-filters>清除筛选/);
});
test('page: uses list.js, keeps the 返回清单 button first in the inspector, and drops the old 1050 / container-720 hiding rules', () => {
  assert.match(page, /from '\.\/list\.js'/); assert.match(page, /extension-inspector-top/);
  assert.match(page, /<span aria-hidden="true">‹<\/span>返回清单/);
  assert.doesNotMatch(css, /max-width: 1050px/); assert.doesNotMatch(css, /@container \(max-width: 720px\)/);
  assert.doesNotMatch(css, /extension-row-status \{[^}]*flex: 0 0 150px/);
});
test('layout contract: 360 / 320 / overlay 400 with the 999 and 1339 breakpoints; inspector is sticky below the 52px toolbar', () => {
  assert.match(css, /--inspector-width: 360px/); assert.match(css, /@media \(max-width: 1339px\) \{ \.extension-browser \{ --inspector-width: 320px/);
  assert.match(css, /@media \(max-width: 999px\)[\s\S]*position: fixed[\s\S]*width: min\(400px, 100vw\)/);
  assert.match(css, /\.extension-detail \{ position: sticky; top: calc\(var\(--toolbar-height, 52px\)/);
  assert.match(css, /\.extension-row \{ min-height: 56px/);
});
test('page: an unreadable config shows the banner only, not a misleading 「还没有 MCP 服务」 empty state', () => {
  assert.match(page, /banner\?\.blocksCreate \? '' : emptyState\(route\.tab\)/); assert.match(emptyState('mcp'), /添加 MCP 服务/);
});
test('list.js is registered as a web asset', () => {
  const assets = JSON.parse(read('core/web-assets.json')); assert.equal(assets['/extensions/list.js'], 'extensions/list.js');
});
test('loading: the cancel button appears only after 1s and only when the controller says it can cancel', () => {
  assert.doesNotMatch(loadingState({ elapsed: 999, cancellable: true }), /data-cancel-load/);
  assert.doesNotMatch(loadingState({ elapsed: 2000, cancellable: false }), /data-cancel-load/);
  assert.match(loadingState({ elapsed: 1000, cancellable: true }), /<button[^>]*data-cancel-load[^>]*>取消<\/button>/);
});
