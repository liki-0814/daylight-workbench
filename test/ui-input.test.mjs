// input（文本输入）：非 live 在 change 时提交一次，live 每次 input 提交（输入法组合期间不提交，compositionend 补提交）；
// 值没变不提交；被取消则把控件值还原；标记与转义。
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, resetBody, mount, fire, record, preventAll } from './helpers/mini-dom.mjs';

installDom();
const { input } = await import('../public/ui/components/input/input.js');
beforeEach(resetBody);

function build(props = {}) {
  const { host, el: root } = mount(input({ name: 'title', label: '标题', value: 'start', ...props }));
  const control = root.querySelector('.dl-input__control');
  return { host, root, control };
}
const type = (control, value, eventType = 'input', init = {}) => { control.value = value; return fire(control, eventType, init); };

test('非 live：输入（input 事件）不提交；change 时提交一次——detail 的 value / previousValue / source，可取消，target 是控件', t => {
  const rec = record(); t.after(rec.stop);
  const { control } = build();
  type(control, 'start!', 'input');
  type(control, 'start!!', 'input');
  assert.equal(rec.log.length, 0);
  fire(control, 'change');
  assert.equal(rec.log.length, 1);
  assert.equal(rec.log[0].type, 'ui:change');
  assert.equal(rec.log[0].target, control);
  assert.deepEqual(rec.log[0].detail, { value: 'start!!', previousValue: 'start', source: 'user' });
  assert.equal(rec.log[0].cancelable, true);
  assert.equal(rec.log[0].bubbles, true);
});

test('提交成功后基准值前移：下一次 previousValue 是上次提交的值；值没变的 change 不提交', t => {
  const rec = record(); t.after(rec.stop);
  const { control } = build();
  type(control, 'one', 'change');
  assert.equal(control.dataset.prev, 'one');
  fire(control, 'change');
  assert.equal(rec.log.length, 1, '值没变不提交');
  type(control, 'two', 'change');
  assert.deepEqual(rec.log.map(item => item.detail), [
    { value: 'one', previousValue: 'start', source: 'user' },
    { value: 'two', previousValue: 'one', source: 'user' },
  ]);
  type(control, 'start', 'change');
  assert.deepEqual(rec.log[2].detail, { value: 'start', previousValue: 'two', source: 'user' });
});

test('值没动就收到 change（先改又改回）：不提交', t => {
  const rec = record(); t.after(rec.stop);
  const { control } = build();
  type(control, 'start', 'change');
  assert.equal(rec.log.length, 0);
});

test('页面取消 ui:change：控件值还原为 previousValue，基准值不前移（下一次仍以旧值为 previousValue）', t => {
  const rec = record(); t.after(rec.stop);
  const off = preventAll('ui:change');
  const { control } = build();
  type(control, 'rejected', 'change');
  assert.equal(control.value, 'start');
  assert.equal(control.dataset.prev, 'start');
  assert.equal(rec.log.length, 1);
  off();
  type(control, 'accepted', 'change');
  assert.deepEqual(rec.log[1].detail, { value: 'accepted', previousValue: 'start', source: 'user' });
  assert.equal(control.value, 'accepted');
  assert.equal(control.dataset.prev, 'accepted');
});

test('live：每次 input 都提交；change 事件不再重复提交；取消同样还原', t => {
  const rec = record(); t.after(rec.stop);
  const { control } = build({ live: true });
  assert.equal(control.dataset.live, '1');
  type(control, 'a', 'input');
  type(control, 'ab', 'input');
  fire(control, 'change');
  assert.deepEqual(rec.log.map(item => item.detail), [
    { value: 'a', previousValue: 'start', source: 'user' },
    { value: 'ab', previousValue: 'a', source: 'user' },
  ]);
  const off = preventAll('ui:change'); t.after(off);
  type(control, 'abc', 'input');
  assert.equal(control.value, 'ab');
  assert.equal(control.dataset.prev, 'ab');
});

test('live + 输入法：组合输入期间（isComposing）不提交；compositionend 时按最终值提交一次', t => {
  const rec = record(); t.after(rec.stop);
  const { control } = build({ live: true, value: '' });
  type(control, 'n', 'input', { isComposing: true });
  type(control, 'ni', 'input', { isComposing: true });
  assert.equal(rec.log.length, 0);
  control.value = '你';
  fire(control, 'compositionend');
  assert.deepEqual(rec.log.map(item => item.detail), [{ value: '你', previousValue: '', source: 'user' }]);
  type(control, '你好', 'input', { isComposing: false });
  assert.deepEqual(rec.log.at(-1).detail, { value: '你好', previousValue: '你', source: 'user' });
});

test('非 live 的控件忽略 input 与 compositionend', t => {
  const rec = record(); t.after(rec.stop);
  const { control } = build({ value: '' });
  type(control, '你', 'input');
  fire(control, 'compositionend');
  assert.equal(rec.log.length, 0);
});

test('不是 .dl-input__control 的 input / change 事件被忽略', t => {
  const rec = record(); t.after(rec.stop);
  const { el } = mount('<input class="other" data-prev="a" data-live="1" value="b">');
  fire(el, 'input');
  fire(el, 'change');
  fire(document.body, 'change');
  assert.equal(rec.log.length, 0);
});

test('多行（textarea）：同样的提交与还原规则', t => {
  const rec = record(); t.after(rec.stop);
  const { control } = build({ multiline: true, value: 'line 1', rows: 5 });
  assert.equal(control.nodeName, 'TEXTAREA');
  assert.equal(control.getAttribute('rows'), '5');
  assert.equal(control.value, 'line 1');
  type(control, 'line 1\nline 2', 'change');
  assert.deepEqual(rec.log[0].detail, { value: 'line 1\nline 2', previousValue: 'line 1', source: 'user' });
  assert.equal(build({ multiline: true, label: 'x', rows: 'bad' }).control.getAttribute('rows'), '3');
  assert.equal(build({ multiline: true, label: 'x' }).control.getAttribute('rows'), '3');
});

test('标记：aria-label、name、placeholder、id、data-prev / data-live / aria-invalid、type 白名单、disabled / autofocus、额外属性；label 必填', () => {
  const { control, root } = build({ id: 'the-id', placeholder: '输入…', invalid: true, type: 'search', attrs: { 'data-x': '1' }, disabled: true, autofocus: true });
  assert.equal(control.nodeName, 'INPUT');
  assert.equal(control.getAttribute('aria-label'), '标题');
  assert.equal(control.getAttribute('name'), 'title');
  assert.equal(control.getAttribute('placeholder'), '输入…');
  assert.equal(control.getAttribute('id'), 'the-id');
  assert.equal(control.getAttribute('data-prev'), 'start');
  assert.equal(control.getAttribute('aria-invalid'), 'true');
  assert.equal(control.getAttribute('type'), 'search');
  assert.equal(control.getAttribute('data-x'), '1');
  assert.equal(control.getAttribute('data-ui-keep'), 'value');
  assert.equal(control.hasAttribute('disabled'), true);
  assert.equal(control.hasAttribute('autofocus'), true);
  assert.equal(control.hasAttribute('data-live'), false);
  assert.ok(root.classList.contains('is-invalid'));
  const plain = build({ label: 'x', type: 'date' });
  assert.equal(plain.control.getAttribute('type'), 'text', '不在白名单的 type 回落到 text');
  assert.equal(plain.control.hasAttribute('disabled'), false);
  assert.equal(plain.control.hasAttribute('autofocus'), false);
  assert.equal(plain.control.hasAttribute('aria-invalid'), false);
  assert.equal(plain.root.classList.contains('is-invalid'), false);
  assert.throws(() => input({ name: 'x' }), TypeError);
});

test('外观：variant / mono / align=end 的 class，图标与 kbd 的有无', () => {
  const { root } = build({ variant: 'pill', mono: true, align: 'end', icon: 'search', kbd: '⌘K' });
  for (const name of ['dl-input', 'dl-input--pill', 'dl-input--mono', 'dl-input--end']) assert.ok(root.classList.contains(name), name);
  assert.equal(root.getAttribute('data-ui'), 'input');
  assert.ok(root.querySelector('svg'));
  assert.equal(root.querySelector('kbd.dl-kbd').textContent, '⌘K');
  const plain = build().root;
  assert.ok(plain.classList.contains('dl-input--field'));
  for (const name of ['dl-input--mono', 'dl-input--end']) assert.equal(plain.classList.contains(name), false, name);
  assert.equal(plain.querySelector('svg'), null);
  assert.equal(plain.querySelector('kbd'), null);
});

test('用户输入的值经转义写回（引号 / 尖括号不会逃出属性或 textarea）', () => {
  const nasty = '"><img src=x onerror=alert(1)>';
  const single = build({ value: nasty });
  assert.equal(single.control.value, nasty);
  assert.equal(single.control.getAttribute('data-prev'), nasty);
  assert.equal(single.root.querySelector('img'), null);
  const area = build({ multiline: true, value: '</textarea><b>x</b>' });
  assert.equal(area.control.value, '</textarea><b>x</b>');
  assert.equal(area.root.querySelector('b'), null);
});
