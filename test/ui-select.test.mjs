// select（值选择器）：开合、选择与 ui:change（乐观更新 / 回滚）、action 项、搜索过滤、键盘、单开、静默关闭、标记。
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, resetBody, mount, fire, click, keyboardClick, keydown, record, preventAll } from './helpers/mini-dom.mjs';

installDom();
const { select, closeSelects } = await import('../public/ui/components/select/select.js');
beforeEach(resetBody);

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta', meta: '2' },
  { divider: true },
  { value: 'g', label: 'Gamma' },
  { value: '__new', label: '新建…', action: true },
];
let seq = 0;
function build(props = {}) {
  const id = props.id ?? `s${++seq}`;
  const { host, el: root } = mount(select({ name: 'pick', label: '选择', options, id, ...props }));
  const trigger = root.querySelector(':scope > .dl-select__trigger, :scope > .dl-chip'), menu = root.querySelector(':scope > .dl-menu');
  const item = value => menu.querySelector(`.dl-menu__item[data-value="${value}"]`);
  const text = () => trigger.querySelector('.dl-select__value').textContent;
  return { host, root, trigger, menu, item, text, id };
}
const isOpen = s => !s.menu.hidden;
const selected = s => [...s.menu.querySelectorAll('.dl-menu__item')].filter(item => item.getAttribute('aria-selected') === 'true').map(item => item.dataset.value);

test('点击触发按钮打开：menu 显示、aria-expanded、data-open=1、焦点落到已选项（没有已选项落第一项）、ui:open（value:null，user）', t => {
  const rec = record(); t.after(rec.stop);
  const s = build({ value: 'g' });
  click(s.trigger);
  assert.equal(isOpen(s), true);
  assert.equal(s.trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(s.root.getAttribute('data-open'), '1');
  assert.equal(document.activeElement, s.item('g'));
  assert.deepEqual(rec.types(), ['ui:open']);
  assert.deepEqual(rec.log[0].detail, { value: null, source: 'user' });
  assert.equal(rec.log[0].target, s.root);
  assert.equal(rec.log[0].cancelable, false);
  const empty = build();
  click(empty.trigger);
  assert.equal(document.activeElement, empty.item('a'));
});

test('再点触发按钮关闭：ui:close，data-open 整个属性移除；点外部同样关闭，没有打开时点外部不派发', t => {
  const rec = record(); t.after(rec.stop);
  const s = build();
  click(document.body);
  assert.equal(rec.log.length, 0);
  click(s.trigger);
  click(s.trigger);
  assert.equal(isOpen(s), false);
  assert.equal(s.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(s.root.hasAttribute('data-open'), false);
  click(s.trigger);
  click(document.body);
  assert.equal(isOpen(s), false);
  assert.deepEqual(rec.types(), ['ui:open', 'ui:close', 'ui:open', 'ui:close']);
  assert.deepEqual(rec.log[3].detail, { value: null, source: 'user' });
});

test('键盘：触发按钮上 ArrowDown / ArrowUp / Enter / Space 打开（preventDefault，keyboard）；其他键不开', t => {
  const rec = record(); t.after(rec.stop);
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter', ' ']) {
    const s = build();
    const event = keydown(s.trigger, key);
    assert.equal(event.defaultPrevented, true, key);
    assert.equal(isOpen(s), true, key);
    assert.deepEqual(rec.log.at(-1).detail, { value: null, source: 'keyboard' }, key);
    closeSelects();
  }
  const quiet = build();
  rec.log.length = 0;
  for (const key of ['a', 'Escape', 'Tab', 'Home']) assert.equal(keydown(quiet.trigger, key).defaultPrevented, false, key);
  assert.equal(isOpen(quiet), false);
  assert.equal(rec.log.length, 0);
});

test('Esc 关闭并把焦点还给触发按钮（preventDefault + stopPropagation，keyboard）；Tab 关闭但不拦截', t => {
  const rec = record(); t.after(rec.stop);
  const s = build({ value: 'a' });
  click(s.trigger);
  const escape = keydown(document.activeElement, 'Escape');
  assert.equal(escape.defaultPrevented, true);
  assert.equal(escape.stopped, true);
  assert.equal(isOpen(s), false);
  assert.equal(document.activeElement, s.trigger);
  assert.deepEqual(rec.log.at(-1).detail, { value: null, source: 'keyboard' });
  click(s.trigger);
  const tab = keydown(s.item('a'), 'Tab');
  assert.equal(tab.defaultPrevented, false);
  assert.equal(isOpen(s), false);
  assert.deepEqual(rec.types(), ['ui:open', 'ui:close', 'ui:open', 'ui:close']);
  assert.equal(rec.log.at(-1).detail.source, 'keyboard');
});

test('方向键在选项间移动焦点并循环（Home / End 到两端）；焦点在触发按钮上时方向键不处理', () => {
  const s = build({ value: 'a' });
  click(s.trigger);
  const order = ['a', 'b', 'g', '__new'];
  assert.equal(keydown(s.item('a'), 'ArrowDown').defaultPrevented, true);
  assert.equal(document.activeElement, s.item('b'));
  keydown(s.item('b'), 'ArrowDown');
  assert.equal(document.activeElement, s.item('g'));
  keydown(s.item('g'), 'ArrowUp');
  assert.equal(document.activeElement, s.item('b'));
  keydown(s.item('b'), 'End');
  assert.equal(document.activeElement, s.item(order.at(-1)));
  keydown(s.item('__new'), 'ArrowDown');
  assert.equal(document.activeElement, s.item('a'), '向下循环');
  keydown(s.item('a'), 'ArrowUp');
  assert.equal(document.activeElement, s.item('__new'), '向上循环');
  keydown(s.item('__new'), 'Home');
  assert.equal(document.activeElement, s.item('a'));
  s.trigger.focus();
  const ignored = keydown(s.trigger, 'ArrowDown');
  assert.equal(ignored.defaultPrevented, false);
  assert.equal(document.activeElement, s.trigger);
});

test('选择新值：先 ui:change 再 ui:close（契约 E-10；value / previousValue / source，可取消）；DOM 已更新：data-value、显示文字、aria-selected 只剩新项、is-empty 去掉、焦点回触发按钮', t => {
  const rec = record(); t.after(rec.stop);
  const s = build({ value: 'a' });
  click(s.trigger);
  let during = null;
  const listen = () => { during = { value: s.trigger.dataset.value, text: s.text(), selected: selected(s) }; };
  document.addEventListener('ui:change', listen); t.after(() => document.removeEventListener('ui:change', listen));
  click(s.item('g'));
  assert.deepEqual(rec.types(), ['ui:open', 'ui:change', 'ui:close']);
  const change = rec.log[1];
  assert.deepEqual(rec.log[2].detail, { value: null, source: 'user' });
  assert.equal(change.target, s.root);
  assert.deepEqual(change.detail, { value: 'g', previousValue: 'a', source: 'user' });
  assert.equal(change.cancelable, true);
  assert.deepEqual(during, { value: 'g', text: 'Gamma', selected: ['g'] }, '监听器看到的已经是更新后的 DOM');
  assert.equal(s.trigger.dataset.value, 'g');
  assert.equal(s.text(), 'Gamma');
  assert.deepEqual(selected(s), ['g']);
  assert.equal(isOpen(s), false);
  assert.equal(document.activeElement, s.trigger);
});

test('键盘选择（Enter / Space 激活选项，click.detail 0）：ui:change 与 ui:close 的 source 都是 keyboard', t => {
  const rec = record(); t.after(rec.stop);
  const s = build({ value: 'a' });
  click(s.trigger);
  keyboardClick(s.item('b'));
  assert.deepEqual(rec.log.slice(1).map(item => [item.type, item.detail.source]), [['ui:change', 'keyboard'], ['ui:close', 'keyboard']]);
});

test('原来没有值：选择后 is-empty 去掉，previousValue 是空串', t => {
  const rec = record(); t.after(rec.stop);
  const s = build();
  assert.equal(s.trigger.classList.contains('is-empty'), true);
  assert.equal(s.text(), '未选择');
  click(s.trigger);
  click(s.item('b'));
  assert.equal(s.trigger.classList.contains('is-empty'), false);
  assert.equal(s.text(), 'Beta');
  assert.deepEqual(rec.log.at(-2).detail, { value: 'b', previousValue: '', source: 'user' });
});

test('选择被取消：data-value、文字、aria-selected 全部回到之前的值', t => {
  const rec = record(); t.after(rec.stop);
  const off = preventAll('ui:change'); t.after(off);
  const s = build({ value: 'a' });
  click(s.trigger);
  click(s.item('g'));
  assert.equal(rec.types().includes('ui:change'), true);
  assert.equal(s.trigger.dataset.value, 'a');
  assert.equal(s.text(), 'Alpha');
  assert.deepEqual(selected(s), ['a']);
  assert.equal(isOpen(s), false, '取消不影响菜单已经关闭');
});

// 原来是空值时，被取消的选择要把文字回滚成占位符，同时恢复 is-empty（否则占位符会按「已选」样式显示）。
test('选择被取消（原来为空）：is-empty 恢复，占位符样式不丢', t => {
  const off = preventAll('ui:change'); t.after(off);
  const s = build();
  click(s.trigger);
  click(s.item('a'));
  assert.equal(s.text(), '未选择');
  assert.equal(s.trigger.classList.contains('is-empty'), true);
  assert.equal(s.trigger.dataset.value, '');
  assert.deepEqual(selected(s), []);
});

test('选择被取消（原来有值）：不会误加 is-empty', t => {
  const off = preventAll('ui:change'); t.after(off);
  const s = build({ value: 'a' });
  click(s.trigger);
  click(s.item('g'));
  assert.equal(s.trigger.classList.contains('is-empty'), false);
});

test('回滚 = 按原值整体重新渲染：自定义占位符、原值不在选项里（视作空）、各项 aria-selected 与 data-value 全部一致', t => {
  const off = preventAll('ui:change'); t.after(off);
  const custom = build({ placeholder: '请选择项目' });
  assert.equal(custom.trigger.dataset.placeholder, '请选择项目');
  click(custom.trigger);
  click(custom.item('b'));
  assert.equal(custom.text(), '请选择项目');
  assert.equal(custom.trigger.classList.contains('is-empty'), true);
  assert.equal(custom.trigger.dataset.value, '');
  assert.deepEqual(selected(custom), []);
  const unknown = build({ value: 'zzz' });
  assert.equal(unknown.trigger.classList.contains('is-empty'), true);
  click(unknown.trigger);
  click(unknown.item('g'));
  assert.equal(unknown.trigger.dataset.value, 'zzz');
  assert.equal(unknown.text(), '未选择');
  assert.equal(unknown.trigger.classList.contains('is-empty'), true);
  assert.deepEqual(selected(unknown), []);
});

test('选中当前值只关闭菜单：不派发 ui:change，DOM 不变，焦点回触发按钮', t => {
  const rec = record(); t.after(rec.stop);
  const s = build({ value: 'b' });
  click(s.trigger);
  click(s.item('b'));
  assert.deepEqual(rec.types(), ['ui:open', 'ui:close']);
  assert.equal(s.text(), 'Beta');
  assert.deepEqual(selected(s), ['b']);
  assert.equal(isOpen(s), false);
  assert.equal(document.activeElement, s.trigger);
});

test('action 项（如「新建…」）：先 ui:select 再 ui:close（契约 E-10；只有 value 和 source，不可取消），不改变值、文字和 aria-selected', t => {
  const rec = record(); t.after(rec.stop);
  const s = build({ value: 'a' });
  click(s.trigger);
  click(s.item('__new'));
  assert.deepEqual(rec.types(), ['ui:open', 'ui:select', 'ui:close']);
  assert.deepEqual(rec.log[1].detail, { value: '__new', source: 'user' });
  assert.equal(rec.log[1].cancelable, false);
  assert.equal(rec.log[1].target, s.root);
  assert.equal(s.trigger.dataset.value, 'a');
  assert.equal(s.text(), 'Alpha');
  assert.deepEqual(selected(s), ['a']);
  assert.equal(document.activeElement, s.trigger);
  click(s.trigger);
  keyboardClick(s.item('__new'));
  assert.deepEqual(rec.log.at(-2).detail, { value: '__new', source: 'keyboard' });
});

test('分隔线上的点击什么都不做（菜单保持打开）；点击选项里的子元素等同点选项', t => {
  const rec = record(); t.after(rec.stop);
  const s = build({ value: 'a' });
  click(s.trigger);
  click(s.menu.querySelector('.dl-menu__divider'));
  assert.equal(isOpen(s), true);
  assert.equal(rec.log.length, 1);
  click(s.item('g').querySelector('.dl-menu__label'));
  assert.equal(rec.log.at(-2).type, 'ui:change');
  assert.equal(rec.log.at(-2).detail.value, 'g');
});

test('chip 变体：触发按钮是 .dl-chip，同样能打开、选择、回滚', t => {
  const rec = record(); t.after(rec.stop);
  const s = build({ variant: 'chip', value: 'a' });
  assert.ok(s.trigger.classList.contains('dl-chip'));
  click(s.trigger);
  assert.equal(isOpen(s), true);
  click(s.item('b'));
  assert.equal(s.trigger.dataset.value, 'b');
  assert.equal(s.text(), 'Beta');
  assert.deepEqual(rec.log.at(-2).detail, { value: 'b', previousValue: 'a', source: 'user' });
});

test('disabled：点击与键盘都打不开', t => {
  const rec = record(); t.after(rec.stop);
  const s = build({ disabled: true });
  click(s.trigger);
  keydown(s.trigger, 'ArrowDown');
  keydown(s.trigger, 'Enter');
  assert.equal(isOpen(s), false);
  assert.equal(s.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(rec.log.length, 0);
});

test('同时只开一个：打开第二个先关第一个（ui:close 在 ui:open 之前）', t => {
  const rec = record(); t.after(rec.stop);
  const first = build(), second = build();
  click(first.trigger);
  click(second.trigger);
  assert.equal(isOpen(first), false);
  assert.equal(first.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(isOpen(second), true);
  assert.deepEqual(rec.log.map(item => [item.type, item.target]), [['ui:open', first.root], ['ui:close', first.root], ['ui:open', second.root]]);
});

test('closeSelects() 静默关闭（不派发 ui:close），scope 限定范围', t => {
  const rec = record(); t.after(rec.stop);
  const s = build();
  click(s.trigger);
  rec.log.length = 0;
  closeSelects(mount('<div></div>').el);
  assert.equal(isOpen(s), true);
  closeSelects(s.host);
  assert.equal(isOpen(s), false);
  assert.equal(s.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(s.root.hasAttribute('data-open'), false);
  assert.equal(rec.log.length, 0);
  click(s.trigger);
  closeSelects();
  assert.equal(isOpen(s), false);
  assert.deepEqual(rec.types(), ['ui:open']);
});

test('带搜索：打开时焦点在搜索框；输入过滤选项（不分大小写、去首尾空白、按 data-label），清空恢复；不派发事件', t => {
  const rec = record(); t.after(rec.stop);
  const s = build({ search: true, value: 'g' });
  const search = s.menu.querySelector('.dl-menu__search');
  assert.ok(search);
  click(s.trigger);
  assert.equal(document.activeElement, search, '搜索框优先于已选项');
  rec.log.length = 0;
  const hiddenLabels = () => [...s.menu.querySelectorAll('.dl-menu__item')].filter(item => item.hidden).map(item => item.dataset.value);
  search.value = '  ALP ';
  fire(search, 'input');
  assert.deepEqual(hiddenLabels(), ['b', 'g', '__new']);
  search.value = 'ta';
  fire(search, 'input');
  assert.deepEqual(hiddenLabels(), ['a', 'g', '__new'], 'Beta 命中，Alpha 不含 ta');
  search.value = 'zzz';
  fire(search, 'input');
  assert.deepEqual(hiddenLabels(), ['a', 'b', 'g', '__new']);
  search.value = '   ';
  fire(search, 'input');
  assert.deepEqual(hiddenLabels(), []);
  assert.equal(rec.log.length, 0);
  const plain = build();
  assert.equal(plain.menu.querySelector('.dl-menu__search'), null);
  const other = mount('<input class="not-search">').el;
  fire(other, 'input');
  assert.deepEqual(hiddenLabels(), [], '非搜索框的 input 事件被忽略');
});

test('搜索框里：ArrowDown 去第一个可见项（跳过被过滤掉的），ArrowUp 去最后一项', () => {
  const s = build({ search: true });
  const search = s.menu.querySelector('.dl-menu__search');
  click(s.trigger);
  search.value = 'gam';
  fire(search, 'input');
  keydown(search, 'ArrowDown');
  assert.equal(document.activeElement, s.item('g'));
  search.value = '';
  fire(search, 'input');
  search.focus();
  keydown(search, 'ArrowUp');
  assert.equal(document.activeElement, s.item('__new'));
});

test('标记：角色、aria 关联、选中态、data-value、is-empty / 占位符、check 图标只在选中项、meta、搜索框 aria-label、非法 value 的数字比较；label 必填', () => {
  const s = build({ id: 'mk', value: 2, placement: 'up', options: [{ value: '1', label: 'One' }, { value: '2', label: 'Two', meta: 'm' }] });
  assert.equal(s.trigger.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(s.trigger.getAttribute('aria-controls'), 'mk-menu');
  assert.equal(s.trigger.getAttribute('aria-label'), '选择');
  assert.equal(s.menu.getAttribute('role'), 'listbox');
  assert.equal(s.menu.getAttribute('aria-label'), '选择');
  assert.equal(s.menu.getAttribute('id'), 'mk-menu');
  assert.equal(s.menu.hidden, true);
  assert.equal(s.root.getAttribute('data-placement'), 'up');
  assert.equal(s.root.getAttribute('data-name'), 'pick');
  assert.equal(s.trigger.dataset.value, '2', '数字 2 与选项 "2" 视为同一个值');
  assert.equal(s.text(), 'Two');
  assert.equal(s.trigger.classList.contains('is-empty'), false);
  assert.equal(s.item('1').getAttribute('role'), 'option');
  assert.equal(s.item('1').getAttribute('aria-selected'), 'false');
  assert.equal(s.item('2').getAttribute('aria-selected'), 'true');
  assert.ok(s.item('2').querySelector('.dl-menu__check'));
  assert.equal(s.item('1').querySelector('.dl-menu__check'), null);
  assert.equal(s.item('2').querySelector('.dl-menu__meta').textContent, 'm');
  assert.equal(s.item('1').dataset.label, 'One');
  const missing = build({ value: 'nope' });
  assert.equal(missing.text(), '未选择');
  assert.equal(missing.trigger.classList.contains('is-empty'), true);
  assert.deepEqual(selected(missing), []);
  assert.equal(build({ placeholder: '请选' }).text(), '请选');
  assert.equal(build({ search: true, label: '项目' }).menu.querySelector('.dl-menu__search').getAttribute('aria-label'), '搜索 项目');
  assert.ok(build({ variant: 'ghost' }).trigger.classList.contains('dl-select__trigger--ghost'));
  const action = build({ value: '__new' });
  assert.equal(action.item('__new').getAttribute('aria-selected'), 'false', 'action 项永远不是选中态');
  assert.throws(() => select({ options }), TypeError);
});

// 契约 E-10：先 select / change 再 close。
test('契约 E-10：选择时 ui:change 先于 ui:close（change 被取消时 close 仍在其后）', t => {
  const rec = record(); t.after(rec.stop);
  const s = build({ value: 'a' });
  click(s.trigger);
  rec.log.length = 0;
  click(s.item('g'));
  assert.deepEqual(rec.types(), ['ui:change', 'ui:close']);
  const off = preventAll('ui:change'); t.after(off);
  click(s.trigger);
  rec.log.length = 0;
  click(s.item('b'));
  assert.deepEqual(rec.types(), ['ui:change', 'ui:close'], '被取消的 change 之后仍补发 close');
});
