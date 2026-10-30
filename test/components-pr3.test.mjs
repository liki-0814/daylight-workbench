import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { switchControl } from '../public/components/switch.js';
import { searchField } from '../public/components/search-field.js';
import { chip } from '../public/components/chip.js';
import { bannerMarkup, copyText } from '../public/components/banner.js';
import { sheetFooter } from '../public/components/sheet.js';
import { icon } from '../public/components/icons.js';

test('switch: role=switch on a native checkbox, accessible name, escaped text, reason text when disabled', () => {
  const html = switchControl({ label: 'a"b · Pi', text: 'Pi', hint: '同名位置冲突', checked: true, disabled: true, inputAttrs: { 'data-binding-toggle': true, 'data-skill': 'x' } });
  assert.match(html, /<input [^>]*type="checkbox"[^>]*role="switch"/);
  assert.match(html, /aria-label="a&quot;b · Pi"/);
  assert.match(html, /\bchecked\b/); assert.match(html, /\bdisabled\b/); assert.match(html, /data-binding-toggle/);
  assert.match(html, /<small>同名位置冲突<\/small>/, 'disabled switches state their reason as text');
});
test('switch: pending and busy states carry text, not only colour', () => {
  assert.match(switchControl({ label: 'x', pending: true }), /is-pending[\s\S]*待应用/);
  assert.match(switchControl({ label: 'x', busy: true }), /aria-busy="true"[\s\S]*应用中…/);
  assert.doesNotMatch(switchControl({ label: 'x' }), /待应用|aria-busy|checked|disabled/);
});
test('search field: SVG clear button named 清除搜索, hidden while empty, value escaped', () => {
  const empty = searchField({ label: '搜索扩展', placeholder: '搜索' });
  assert.match(empty, /aria-label="清除搜索"[^>]*data-search-clear hidden/);
  assert.match(empty, /<svg/); assert.doesNotMatch(empty, /✕|×/);
  const filled = searchField({ label: '搜索扩展', value: '<b>' });
  assert.doesNotMatch(filled, /data-search-clear hidden/); assert.match(filled, /value="&lt;b&gt;"/);
});
test('chip: tone fallback, escaped label, dot is decorative', () => {
  assert.match(chip({ label: '<x>', tone: 'nope' }), /ui-chip-neutral[\s\S]*&lt;x&gt;/);
  assert.match(chip({ label: '握手成功', tone: 'success', dot: true }), /ui-chip-success[\s\S]*aria-hidden="true"[\s\S]*握手成功/);
});
test('banner: error is role=alert, other tones role=status; actions rendered as buttons; text escaped', () => {
  const error = bannerMarkup({ tone: 'error', title: '<配置>', message: 'm', attrs: { 'data-config-banner': 'X' }, actions: [{ label: '复制路径', attrs: { 'data-copy-path': true } }] });
  assert.match(error, /role="alert"/); assert.match(error, /data-config-banner="X"/); assert.match(error, /&lt;配置&gt;/);
  assert.match(error, /<button [^>]*data-copy-path[^>]*>复制路径<\/button>/);
  assert.match(bannerMarkup({ tone: 'warning', title: 't' }), /role="status"/);
  assert.match(bannerMarkup({ tone: 'bogus', title: 't' }), /ui-banner-info/);
  assert.doesNotMatch(bannerMarkup({ title: 't' }), /ui-banner-actions/);
});
test('copyText: clipboard success, rejection and missing clipboard never throw', async () => {
  let written; assert.deepEqual(await copyText('/p', { clipboard: { writeText: async value => { written = value; } } }), { copied: true, selected: false }); assert.equal(written, '/p');
  assert.deepEqual(await copyText('/p', { clipboard: { writeText: async () => { throw new Error('denied'); } } }), { copied: false, selected: false });
  assert.deepEqual(await copyText('/p', { clipboard: undefined }), { copied: false, selected: false });
});
test('sheet footer: cancel first (left), primary/danger confirm second, inline error slot is role=alert', () => {
  const html = sheetFooter({ confirmLabel: '恢复', destructive: true });
  assert.ok(html.indexOf('data-sheet-cancel') < html.indexOf('data-sheet-confirm'));
  assert.match(html, /ui-button-danger/); assert.match(html, /role="alert" data-sheet-error/);
  assert.doesNotMatch(sheetFooter(), /ui-button-danger/);
});
test('banner icons exist for every tone', () => { for (const name of ['info', 'warning', 'error', 'success']) assert.match(icon(name), /<path|<circle/); });
test('new component assets are registered and linked', async () => {
  const assets = JSON.parse(await readFile(new URL('../core/web-assets.json', import.meta.url), 'utf8')), html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const name of ['switch', 'search-field', 'banner', 'chip', 'sheet']) {
    assert.equal(assets[`/components/${name}.js`], `components/${name}.js`); assert.equal(assets[`/components/${name}.css`], `components/${name}.css`);
    assert.ok(html.includes(`href="/components/${name}.css"`), name + '.css must be linked from index.html');
  }
});
