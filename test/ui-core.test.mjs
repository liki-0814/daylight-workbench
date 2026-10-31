import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, html, trusted, isTrusted, slot, flag, SafeHtml } from '../public/ui/core/html.js';
import { emit, detailErrors, VERBS, SOURCES } from '../public/ui/core/events.js';

const evil = '<img src=x onerror=alert(1)>';

test('html``：插值默认转义，SafeHtml 与它们的数组原样，false / null 为空', () => {
  assert.equal(String(html`<b>${evil}</b>`), '<b>&lt;img src=x onerror=alert(1)&gt;</b>');
  assert.equal(String(html`<i>${trusted('<u>ok</u>')}</i>`), '<i><u>ok</u></i>');
  assert.equal(String(html`<ul>${['a', trusted('<li>b</li>'), '<c>']}</ul>`), '<ul>a<li>b</li>&lt;c&gt;</ul>');
  assert.equal(String(html`<p${flag('hidden', true)}${flag('open', false)}>${null}${false}${undefined}</p>`), '<p hidden></p>');
  assert.equal(String(html`<a title="${'" onmouseover="x'}">`), '<a title="&quot; onmouseover=&quot;x">');
});
test('trusted() / 子内容槽：裸字符串按文本处理，只有 SafeHtml 才不转义；嵌套 html`` 的结果本身可信', () => {
  assert.equal(slot(evil), esc(evil));
  assert.equal(slot(trusted('<b>x</b>')), '<b>x</b>');
  assert.ok(isTrusted(html`<b></b>`) && isTrusted(trusted('x')) && !isTrusted('<b></b>'));
  assert.ok(trusted(trusted('a')) instanceof SafeHtml);
  const inner = html`<i>${evil}</i>`;
  assert.equal(String(html`<p>${inner}</p>`), '<p><i>&lt;img src=x onerror=alert(1)&gt;</i></p>');
});
test('emit()：ui:<verb>，bubbles，detail 校验；非法动词 / 非法 detail 抛错', () => {
  const parent = new EventTarget(), seen = [];
  parent.addEventListener('ui:change', e => seen.push(e));
  assert.deepEqual(VERBS, ['change', 'select', 'open', 'close', 'dismiss']);
  assert.equal(emit(parent, 'change', { value: 1, previousValue: 0, source: 'user' }), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'ui:change');
  assert.equal(seen[0].bubbles, true);
  assert.deepEqual(seen[0].detail, { value: 1, previousValue: 0, source: 'user' });
  assert.throws(() => emit(parent, 'toggle', { value: 1, source: 'user' }), /ui event contract/);
  assert.throws(() => emit(parent, 'change', { value: 1, source: 'mouse' }), /source/);
  assert.throws(() => emit(parent, 'change', { source: 'user' }), /value/);
  assert.deepEqual(detailErrors({ value: 1, source: 'keyboard', extra: 1 }), ['unexpected detail.extra']);
  assert.deepEqual(SOURCES, ['user', 'keyboard']);
});
test('emit()：cancelable 事件被页面 preventDefault 后返回 false', () => {
  const el = new EventTarget();
  el.addEventListener('ui:dismiss', e => e.preventDefault());
  assert.equal(emit(el, 'dismiss', { value: null, source: 'keyboard' }, { cancelable: true }), false);
  assert.equal(emit(el, 'dismiss', { value: null, source: 'keyboard' }), true, '不可取消的事件 preventDefault 无效');
});
