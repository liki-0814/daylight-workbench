// segmented（单选分段）：点击 / 方向键选择、ui:change 的 detail、roving tabindex、取消回滚、受控重绘、标记。
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, resetBody, mount, click, keyboardClick, keydown, record, preventAll } from './helpers/mini-dom.mjs';

installDom();
const { segmented } = await import('../public/ui/components/segmented/segmented.js');
const { morph } = await import('../public/ui/core/morph.js');
beforeEach(resetBody);

const options = [
  { value: 'all', label: '全部', count: 12 },
  { value: 'open', label: '进行中', count: 0 },
  { value: 'done', label: '已完成' },
];
function build(props = {}) {
  const { host, el: group } = mount(segmented({ name: 'filter', label: '筛选', value: 'all', options, ...props }));
  const item = value => group.querySelector(`.dl-seg__item[data-value="${value}"]`);
  const active = () => [...group.querySelectorAll('.dl-seg__item.is-active')].map(el => el.dataset.value);
  const checkedItems = () => [...group.querySelectorAll('.dl-seg__item')].filter(el => el.getAttribute('aria-checked') === 'true').map(el => el.dataset.value);
  const tabbable = () => [...group.querySelectorAll('.dl-seg__item')].filter(el => el.getAttribute('tabindex') === '0').map(el => el.dataset.value);
  return { host, group, item, active, checkedItems, tabbable };
}

test('点击另一项：is-active / aria-checked / tabindex 一起换到新项，派发一次 ui:change（target 是分组，value / previousValue / source:user，可取消）', t => {
  const rec = record(); t.after(rec.stop);
  const s = build();
  assert.deepEqual([s.active(), s.checkedItems(), s.tabbable()], [['all'], ['all'], ['all']]);
  click(s.item('open'));
  assert.deepEqual([s.active(), s.checkedItems(), s.tabbable()], [['open'], ['open'], ['open']]);
  assert.equal(s.item('all').getAttribute('tabindex'), '-1');
  assert.equal(rec.log.length, 1);
  assert.equal(rec.log[0].type, 'ui:change');
  assert.equal(rec.log[0].target, s.group);
  assert.deepEqual(rec.log[0].detail, { value: 'open', previousValue: 'all', source: 'user' });
  assert.equal(rec.log[0].cancelable, true);
  assert.equal(rec.log[0].bubbles, true);
});

test('点击当前项不派发、不改变；点击项内的子元素等同点击项；键盘激活（detail 0）的 source 是 keyboard', t => {
  const rec = record(); t.after(rec.stop);
  const s = build();
  click(s.item('all'));
  click(s.item('all').querySelector('span'));
  assert.equal(rec.log.length, 0);
  assert.deepEqual(s.active(), ['all']);
  click(s.item('done').querySelector('span'));
  assert.deepEqual(s.active(), ['done']);
  keyboardClick(s.item('open'));
  assert.deepEqual(rec.log.map(item => item.detail), [
    { value: 'done', previousValue: 'all', source: 'user' },
    { value: 'open', previousValue: 'done', source: 'keyboard' },
  ]);
});

test('监听器收到 ui:change 时 DOM 已经是新状态', t => {
  const s = build();
  let during = null;
  const listen = () => { during = s.active(); };
  document.addEventListener('ui:change', listen); t.after(() => document.removeEventListener('ui:change', listen));
  click(s.item('done'));
  assert.deepEqual(during, ['done']);
});

test('页面取消 ui:change：active / aria-checked / tabindex 回到之前的项', t => {
  const rec = record(); t.after(rec.stop);
  const off = preventAll('ui:change'); t.after(off);
  const s = build();
  click(s.item('done'));
  assert.equal(rec.log.length, 1);
  assert.deepEqual([s.active(), s.checkedItems(), s.tabbable()], [['all'], ['all'], ['all']]);
  assert.equal(s.item('done').getAttribute('tabindex'), '-1');
  assert.equal(s.item('done').classList.contains('is-active'), false);
});

// 原来没有选中项时，被取消的选择要回到「没有任何选中项」（回滚时 previous 为空，只取消 item 的选中态）。
test('原来没有选中项、选择被取消：回到没有任何选中项（is-active / aria-checked / tabindex 都复位）', t => {
  const off = preventAll('ui:change'); t.after(off);
  const s = build({ value: '' });
  assert.deepEqual(s.active(), []);
  click(s.item('open'));
  assert.deepEqual(s.active(), []);
  assert.deepEqual(s.checkedItems(), []);
  assert.equal(s.item('open').getAttribute('tabindex'), '-1');
});

test('roving tabindex：原来没有选中项、选择被取消 → 恰好一个 tabindex="0"（第一个未禁用项），整组仍能 Tab 进入', t => {
  const off = preventAll('ui:change'); t.after(off);
  const s = build({ value: '' });
  click(s.item('open'));
  assert.deepEqual(s.active(), []);
  assert.deepEqual(s.tabbable(), ['all']);
  assert.equal(s.group.querySelectorAll('.dl-seg__item[tabindex="0"]').length, 1);
  const skip = build({ value: '', options: [{ value: 'x', label: 'X', attrs: { disabled: true } }, ...options] });
  click(skip.item('open'));
  assert.deepEqual(skip.active(), []);
  assert.deepEqual(skip.tabbable(), ['all'], '第一项被禁用时落到下一个未禁用项');
});

test('roving tabindex（初始 markup）：刚渲染、没有 value → 恰好一个 tabindex="0"（第一个未禁用项）；与 render() 同一规则', () => {
  const none = build({ value: '' });
  assert.deepEqual(none.active(), []);
  assert.deepEqual(none.tabbable(), ['all']);
  assert.equal(none.group.querySelectorAll('.dl-seg__item[tabindex="0"]').length, 1);
  const skip = build({ value: '', options: [{ value: 'x', label: 'X', attrs: { disabled: true } }, ...options] });
  assert.deepEqual(skip.tabbable(), ['all'], '第一项被禁用时落到下一个未禁用项');
  const unknown = build({ value: 'nope' });
  assert.deepEqual([unknown.active(), unknown.tabbable()], [[], ['all']], 'value 不匹配任何项同样视为没有选中项');
  const selected = build({ value: 'open' });
  assert.deepEqual(selected.tabbable(), ['open'], '有选中项时只有选中项可 Tab');
  const allDisabled = build({ value: '', options: options.map(o => ({ ...o, attrs: { disabled: true } })) });
  assert.deepEqual(allDisabled.tabbable(), [], '全部禁用时没有可 Tab 项');
});

test('原来没有选中项：选择后 previousValue 是空串', t => {
  const rec = record(); t.after(rec.stop);
  const s = build({ value: '' });
  assert.deepEqual(s.tabbable(), ['all'], '没有选中项时第一项承担 tabindex=0');
  click(s.item('open'));
  assert.deepEqual(rec.log[0].detail, { value: 'open', previousValue: '', source: 'user' });
  assert.deepEqual([s.active(), s.tabbable()], [['open'], ['open']]);
});

test('方向键：→ 移到下一项并选中（焦点跟随，source:keyboard，preventDefault），到末尾循环；← 反向', t => {
  const rec = record(); t.after(rec.stop);
  const s = build();
  const right = keydown(s.item('all'), 'ArrowRight');
  assert.equal(right.defaultPrevented, true);
  assert.equal(document.activeElement, s.item('open'));
  assert.deepEqual(s.active(), ['open']);
  keydown(s.item('open'), 'ArrowRight');
  keydown(s.item('done'), 'ArrowRight');
  assert.deepEqual(s.active(), ['all'], '末尾向右循环到第一项');
  keydown(s.item('all'), 'ArrowLeft');
  assert.deepEqual(s.active(), ['done'], '第一项向左循环到末尾');
  keydown(s.item('done'), 'ArrowLeft');
  assert.deepEqual(s.active(), ['open']);
  assert.deepEqual(rec.log.map(item => item.detail), [
    { value: 'open', previousValue: 'all', source: 'keyboard' },
    { value: 'done', previousValue: 'open', source: 'keyboard' },
    { value: 'all', previousValue: 'done', source: 'keyboard' },
    { value: 'done', previousValue: 'all', source: 'keyboard' },
    { value: 'open', previousValue: 'done', source: 'keyboard' },
  ]);
});

test('Home / End 跳到首 / 末项并选中；已在目标项上时只移焦点，不派发', t => {
  const rec = record(); t.after(rec.stop);
  const s = build({ value: 'open' });
  assert.equal(keydown(s.item('open'), 'End').defaultPrevented, true);
  assert.deepEqual(s.active(), ['done']);
  assert.equal(document.activeElement, s.item('done'));
  keydown(s.item('done'), 'Home');
  assert.deepEqual(s.active(), ['all']);
  const before = rec.log.length;
  const again = keydown(s.item('all'), 'Home');
  assert.equal(again.defaultPrevented, true);
  assert.equal(rec.log.length, before);
  assert.equal(document.activeElement, s.item('all'));
});

test('方向键跳过 disabled 的选项；其他按键与分组之外的按键不处理', t => {
  const rec = record(); t.after(rec.stop);
  const s = build({ options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', attrs: { disabled: true } }, { value: 'c', label: 'C' }], value: 'a' });
  keydown(s.item('a'), 'ArrowRight');
  assert.deepEqual(s.active(), ['c']);
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter', ' ', 'a']) assert.equal(keydown(s.item('c'), key).defaultPrevented, false, key);
  const { el: stray } = mount('<button class="plain">x</button>');
  assert.equal(keydown(stray, 'ArrowRight').defaultPrevented, false);
  assert.deepEqual(rec.log.map(item => item.detail.value), ['c']);
});

test('方向键选中被取消：选中态回到原项（焦点已经移动）', t => {
  const off = preventAll('ui:change'); t.after(off);
  const s = build();
  keydown(s.item('all'), 'ArrowRight');
  assert.deepEqual([s.active(), s.checkedItems(), s.tabbable()], [['all'], ['all'], ['all']]);
});

test('两个分组互不影响', t => {
  const rec = record(); t.after(rec.stop);
  const first = build(), second = build();
  click(first.item('done'));
  assert.deepEqual(first.active(), ['done']);
  assert.deepEqual(second.active(), ['all']);
  assert.equal(rec.log[0].target, first.group);
});

test('受控：页面用新 value 重绘（morph）时切换选中项，不派发事件', t => {
  const rec = record(); t.after(rec.stop);
  const s = build();
  morph(s.host, segmented({ name: 'filter', label: '筛选', value: 'done', options }));
  assert.equal(s.host.firstElementChild, s.group);
  assert.deepEqual([s.active(), s.checkedItems(), s.tabbable()], [['done'], ['done'], ['done']]);
  assert.equal(rec.log.length, 0);
});

test('标记：radiogroup / radio、aria-label、data-name、roving tabindex、count（含 0）、option.attrs、数字与字符串的 value 视为相同；label 必填', () => {
  const s = build({ value: 2, options: [{ value: '1', label: 'One', count: 0 }, { value: 2, label: 'Two', attrs: { 'data-x': 'y' } }] });
  assert.equal(s.group.getAttribute('role'), 'radiogroup');
  assert.equal(s.group.getAttribute('aria-label'), '筛选');
  assert.equal(s.group.getAttribute('data-name'), 'filter');
  assert.equal(s.item('1').getAttribute('role'), 'radio');
  assert.deepEqual([s.active(), s.tabbable()], [['2'], ['2']]);
  assert.equal(s.item('1').getAttribute('aria-checked'), 'false');
  assert.equal(s.item('1').querySelector('.dl-seg__count').textContent, '0', 'count 为 0 也要显示');
  assert.equal(s.item('2').querySelector('.dl-seg__count'), null);
  assert.equal(s.item('2').getAttribute('data-x'), 'y');
  assert.equal(s.item('1').getAttribute('data-x'), null);
  assert.deepEqual(build({ value: 'zzz' }).active(), []);
  assert.equal(mount(segmented({ label: 'l', options })).el.hasAttribute('data-name'), false);
  assert.throws(() => segmented({ options }), TypeError);
});
