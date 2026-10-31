// 0.8 组件库单测（node 环境，无 DOM）：转义契约（每个组件一条注入测试）、事件契约（detail 模式）、属性名白名单。
// DOM 行为（mount → 用户操作 → 恰好一次 ui:change；update() 不派发）在 Playwright e2e（e2e/cases/ui-components.mjs）里跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { html, esc, trusted, attrs, slot } from '../public/ui/core/html.js';
import { emit, detailErrors, eventName, VERBS } from '../public/ui/core/events.js';
import { button } from '../public/ui/components/button/button.js';
import { iconButton } from '../public/ui/components/icon-button/icon-button.js';
import { input } from '../public/ui/components/input/input.js';
import { select } from '../public/ui/components/select/select.js';
import { menu } from '../public/ui/components/menu/menu.js';
import { chip } from '../public/ui/components/chip/chip.js';
import { switchControl } from '../public/ui/components/switch/switch.js';
import { checkbox } from '../public/ui/components/checkbox/checkbox.js';
import { dialog } from '../public/ui/components/dialog/dialog.js';
import { statusTag } from '../public/ui/components/status-tag/status-tag.js';
import { nav } from '../public/ui/components/nav/nav.js';
import { toolbar } from '../public/ui/components/toolbar/toolbar.js';
import { segmented } from '../public/ui/components/segmented/segmented.js';
import { toastMarkup } from '../public/ui/components/toast/toast.js';
import { taskRow, groupHeader, rowList } from '../public/ui/patterns/data-row/data-row.js';
import { settingsLayout, settingsGroup, settingsRow } from '../public/ui/patterns/settings/settings.js';
import { inspector } from '../public/ui/patterns/inspector/inspector.js';
import { composerBody } from '../public/ui/patterns/composer/composer.js';
import { serviceHero } from '../public/ui/patterns/service-status/service-status.js';
import { pageLayout } from '../public/ui/patterns/shell/shell.js';

const EVIL = '<img src=x onerror=alert(1)>"\'';
// 输出里不允许出现可执行标签：任何以 <img / <script / <svg onload / 带 on* 属性的真实标签。
function assertInert(out, name) {
  const text = String(out);
  assert.ok(!/<img\b/i.test(text), `${name}: <img> 没被转义`);
  assert.ok(!/<script\b/i.test(text), `${name}: <script> 没被转义`);
  // 先去掉带引号的属性值（值里的转义文本不是属性），再看真实标签里有没有 on* 属性
  const bare = text.replace(/"[^"]*"/g, '""');
  assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(bare), `${name}: 出现了 on* 事件属性`);
  assert.ok(!/<[a-z][^>]*\sstyle\s*=/i.test(bare), `${name}: 出现了内联 style`);
  assert.ok(text.includes('&lt;img'), `${name}: 注入文本应以转义形式出现`);
}

test('注入：button / icon-button / chip / status-tag / toolbar / toast', () => {
  assertInert(button({ label: EVIL, kbd: EVIL, attrs: { 'data-x': EVIL } }), 'button');
  assertInert(iconButton({ label: EVIL, icon: 'plus', attrs: { 'data-x': EVIL } }), 'icon-button');
  assertInert(chip({ label: EVIL, attrs: { 'data-x': EVIL } }), 'chip');
  assertInert(statusTag({ label: EVIL, tone: EVIL }), 'status-tag');
  assertInert(toolbar({ title: EVIL, count: EVIL, start: EVIL, end: EVIL }), 'toolbar');
  assertInert(toastMarkup({ message: EVIL, tone: EVIL, actions: [{ label: EVIL, value: EVIL }] }), 'toast');
});
test('注入：input / select / switch / checkbox / segmented', () => {
  assertInert(input({ name: EVIL, value: EVIL, label: EVIL, placeholder: EVIL }), 'input');
  assertInert(input({ name: 'a', value: EVIL, label: 'x', multiline: true }), 'input textarea');
  assertInert(select({ name: EVIL, value: EVIL, label: EVIL, placeholder: EVIL, options: [{ value: EVIL, label: EVIL, meta: EVIL }] }), 'select');
  assertInert(switchControl({ name: EVIL, label: EVIL }), 'switch');
  assertInert(checkbox({ name: EVIL, label: EVIL }), 'checkbox');
  assertInert(segmented({ name: EVIL, value: EVIL, label: EVIL, options: [{ value: EVIL, label: EVIL, count: EVIL }] }), 'segmented');
});
test('注入：menu（动作菜单）与角色语义', () => {
  assertInert(menu({ label: EVIL, id: EVIL, trigger: { text: EVIL }, attrs: { 'data-x': EVIL }, options: [{ value: EVIL, label: EVIL, meta: EVIL }, { divider: true }, { value: EVIL, label: EVIL, danger: true }] }), 'menu');
  const markup = String(menu({ label: '更多操作', trigger: { text: '更多' }, options: [{ value: 'a', label: '编辑' }, { divider: true }, { value: 'd', label: '删除', danger: true }, { value: 'x', label: '停用', disabled: true }] }));
  assert.match(markup, /aria-haspopup="menu"/); assert.match(markup, /role="menu"/); assert.equal(markup.match(/role="menuitem"/g).length, 3); assert.doesNotMatch(markup, /role="option"|role="listbox"|aria-selected/);
  assert.match(markup, /is-danger/); assert.match(markup, /<button class="dl-menu__item" type="button" role="menuitem" tabindex="-1" data-value="x" data-key="x" disabled>/);
  assert.throws(() => menu({ options: [] }), TypeError);
});
test('注入：dialog / nav', () => {
  assertInert(dialog({ id: EVIL, label: EVIL, children: EVIL, className: EVIL }), 'dialog');
  assertInert(nav({ label: EVIL, header: EVIL, sections: [{ title: EVIL, empty: EVIL, action: { label: EVIL }, items: [{ value: EVIL, label: EVIL, count: EVIL, kbd: EVIL }] }], footer: [{ value: EVIL, label: EVIL }] }), 'nav');
});
test('注入：patterns（data-row / settings / inspector / composer / service-status / shell）', () => {
  assertInert(taskRow({ id: EVIL, code: EVIL, title: EVIL, due: { text: EVIL, tone: EVIL }, action: { label: EVIL, attrs: { 'data-id': EVIL } } }), 'task-row');
  assertInert(groupHeader({ key: EVIL, label: EVIL, count: EVIL }), 'group-header');
  assertInert(rowList({ label: EVIL, children: EVIL }), 'row-list');
  assertInert(settingsLayout({ title: EVIL, subtitle: EVIL, children: EVIL, sections: [{ title: EVIL, items: [{ value: 'a', label: EVIL }] }] }), 'settings-layout');
  assertInert(settingsGroup({ title: EVIL, rows: EVIL }), 'settings-group');
  assertInert(settingsRow({ label: EVIL, hint: EVIL, control: EVIL }), 'settings-row');
  assertInert(inspector({ kicker: EVIL, title: EVIL, note: EVIL, props: [{ label: EVIL, value: EVIL }], actions: EVIL }), 'inspector');
  assertInert(composerBody({ title: EVIL, notes: EVIL, projects: [{ value: 'p', label: EVIL, dot: 'green' }], project: 'p', attachments: [{ name: EVIL, meta: EVIL }], statusOptions: [{ value: EVIL, label: EVIL }] }), 'composer');
  assertInert(serviceHero({ state: 'error', title: EVIL, tagLabel: EVIL, address: EVIL, addressNote: EVIL, note: EVIL, announce: EVIL, error: { what: EVIL, why: EVIL, todo: EVIL, actions: EVIL } }), 'service-hero(error)');
  assertInert(serviceHero({ state: 'running', title: 'x', tagLabel: 'x', address: EVIL, meta: [{ label: EVIL, value: EVIL }] }), 'service-hero(running)');
  assertInert(pageLayout({ id: EVIL, label: EVIL, toolbar: EVIL, body: EVIL, inspector: EVIL, footer: EVIL }), 'page-layout');
});

test('转义契约：裸字符串是文本，trusted() / 组件返回值才原样拼入', () => {
  assert.equal(String(slot('<b>x</b>')), '&lt;b&gt;x&lt;/b&gt;');
  assert.equal(String(html`<p>${slot('<b>x</b>')}</p>`), '<p>&lt;b&gt;x&lt;/b&gt;</p>', 'slot 的返回值嵌进模板不会被二次转义，也不会放行裸字符串');
  assert.equal(String(html`<p>${slot(trusted('<b>x</b>'))}</p>`), '<p><b>x</b></p>');
  // 可信子内容必须真的渲染出来（防止过度转义把页面弄坏）
  const child = html`<i class="kid">k</i>`;
  for (const [name, out] of [['dialog', dialog({ id: 'd', label: 'l', children: child })], ['toolbar', toolbar({ title: 't', start: child, end: child })], ['settingsRow', settingsRow({ label: 'l', control: child })], ['settingsGroup', settingsGroup({ title: 't', rows: child })], ['inspector', inspector({ title: 't', actions: child })], ['pageLayout', pageLayout({ toolbar: child, body: child, footer: child })], ['rowList', rowList({ label: 'l', children: child })], ['nav', nav({ label: 'n', header: child })]]) assert.ok(String(out).includes('<i class="kid">k</i>'), `${name}: 可信子内容应原样渲染`);
  assert.equal(String(slot(trusted('<b>x</b>'))), '<b>x</b>');
  assert.equal(String(html`<p>${'<i>'}</p>`), '<p>&lt;i&gt;</p>');
  assert.equal(String(html`<p>${html`<i>${'&'}</i>`}</p>`), '<p><i>&amp;</i></p>');
  assert.equal(esc(null), '');
  // children 传裸字符串：dialog / toolbar / page-layout 不会把它当标记
  assert.ok(!String(dialog({ id: 'd', label: 'l', children: '<script>1</script>' })).includes('<script>'));
});
test('attrs()：属性名白名单，拒绝 on* 与 style（CSP 禁内联样式）', () => {
  assert.equal(String(attrs({ 'data-a': 'x"y', disabled: true, hidden: false })), ' data-a="x&quot;y" disabled');
  for (const name of ['onclick', 'onerror', 'style', 'bad name', '"><x', '']) assert.throws(() => attrs({ [name]: 'x' }), TypeError, name);
  assert.throws(() => button({ label: 'x', attrs: { onclick: 'alert(1)' } }), TypeError);
});
test('a11y 必填：控件没有 label 就抛错', () => {
  for (const [name, fn] of [['iconButton', () => iconButton({ icon: 'plus' })], ['input', () => input({ name: 'a' })], ['select', () => select({ options: [] })], ['menu', () => menu({ options: [] })], ['switch', () => switchControl({})], ['checkbox', () => checkbox({})], ['dialog', () => dialog({ id: 'a' })], ['nav', () => nav({})], ['segmented', () => segmented({})]]) assert.throws(fn, TypeError, name);
});

test('事件契约：ui:<verb>，detail 模式 { value, previousValue?, source }，只在 emit() 里派发', () => {
  assert.deepEqual([...VERBS], ['change', 'select', 'open', 'close', 'dismiss']);
  assert.equal(eventName('change'), 'ui:change');
  assert.deepEqual(detailErrors({ value: true, previousValue: false, source: 'user' }), []);
  assert.deepEqual(detailErrors({ value: 'a', source: 'keyboard' }), []);
  assert.ok(detailErrors({ value: 1, source: 'mouse' }).length > 0);
  assert.ok(detailErrors({ source: 'user' }).length > 0);
  const target = new EventTarget();
  const seen = [];
  target.addEventListener('ui:change', event => { seen.push(event); event.preventDefault(); });
  const proceed = emit(target, 'change', { value: 'b', previousValue: 'a', source: 'user' }, { cancelable: true });
  assert.equal(seen.length, 1);
  assert.equal(proceed, false, '被取消时 emit 返回 false');
  assert.equal(seen[0].cancelable, true);
  assert.equal(seen[0].bubbles, true);
  assert.throws(() => emit(target, 'bogus', { value: 1, source: 'user' }));
});

test('每个组件 README 都列出事件（含「无」）与转义说明；pattern 同理', async () => {
  const fs = await import('node:fs');
  const dirs = ['components/button', 'components/icon-button', 'components/input', 'components/select', 'components/menu', 'components/chip', 'components/switch', 'components/checkbox', 'components/dialog', 'components/status-tag', 'components/nav', 'components/toolbar', 'components/segmented', 'components/toast', 'patterns/data-row', 'patterns/settings', 'patterns/inspector', 'patterns/composer', 'patterns/service-status', 'patterns/shell'];
  for (const dir of dirs) {
    const text = fs.readFileSync(new URL(`../public/ui/${dir}/README.md`, import.meta.url), 'utf8');
    assert.match(text, /## 派发的事件/, `${dir}: README 缺「派发的事件」`);
    assert.match(text, /## 转义/, `${dir}: README 缺「转义」`);
    // README 里写的每个 ui:* 事件都必须在代码里真有（反向：代码里 emit 的每个事件 README 都要写到）
    const base = dir.split('/')[1];
    const source = fs.readFileSync(new URL(`../public/ui/${dir}/${base}.js`, import.meta.url), 'utf8');
    for (const verb of new Set([...source.matchAll(/emit\([^,]+,\s*(?:open \? '(\w+)' : '(\w+)'|'(\w+)')/g)].flatMap(m => m.slice(1).filter(Boolean)))) assert.ok(text.includes(`ui:${verb}`), `${dir}: README 没写 ui:${verb}`);
  }
});
