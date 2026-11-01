// ui:* 事件契约在「组件层」的横向检查（Atlas events-contract-v1）：同一套手势跑遍所有组件，
// 逐条断言 E-2（冒泡 / 合法 detail）、E-4（open/close/dismiss 的 value 是 null）、E-5（previousValue 只出现在 change）、
// E-6（只有 change / dismiss 可取消）、E-7（程序化更新静默）、E-8（click.detail 0 = keyboard）、E-10（顺序）。
// 纯 verb / detail 规则在 ui-events-contract.test.mjs（隔离文件）；这里只看组件有没有守约。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, resetBody, mount, fire, click, keyboardClick, record } from './helpers/mini-dom.mjs';

installDom();
const { detailErrors } = await import('../public/ui/core/events.js');
const { morph } = await import('../public/ui/core/morph.js');
const { checkbox } = await import('../public/ui/components/checkbox/checkbox.js');
const { switchControl } = await import('../public/ui/components/switch/switch.js');
const { segmented } = await import('../public/ui/components/segmented/segmented.js');
const { select, closeSelects } = await import('../public/ui/components/select/select.js');
const { menu, closeMenus } = await import('../public/ui/components/menu/menu.js');
const { input } = await import('../public/ui/components/input/input.js');
const { nav } = await import('../public/ui/components/nav/nav.js');
const { mountDialog } = await import('../public/ui/components/dialog/dialog.js');
const { showToast } = await import('../public/ui/components/toast/toast.js');
const { trusted } = await import('../public/ui/core/html.js');

const selectOptions = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }];
const menuOptions = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
const segOptions = [{ value: 'all', label: '全部' }, { value: 'open', label: '进行中' }, { value: 'done', label: '已完成' }];
const navSections = props => [{ title: '工作', items: [{ value: 'home', label: '首页', active: props.active !== 'tasks' }, { value: 'tasks', label: '任务', active: props.active === 'tasks' }] }];

// 手势：act(clk) 里用 clk（click 或 keyboardClick）完成一次「用户动作」。fixed 表示 source 与点击方式无关。
const gestures = [
  { name: 'checkbox', act(clk) { const { host } = mount(checkbox({ name: 'c', label: 'c', checked: false })); clk(host.querySelector('[role=checkbox]')); } },
  { name: 'switch', act(clk) { const { host } = mount(switchControl({ name: 's', label: 's', checked: false })); clk(host.querySelector('[role=switch]')); } },
  { name: 'segmented', act(clk) { const { host } = mount(segmented({ name: 'g', label: 'g', value: 'all', options: segOptions })); clk(host.querySelector('.dl-seg__item[data-value="open"]')); } },
  { name: 'select', act(clk) { const { host } = mount(select({ name: 'p', label: 'p', value: 'a', options: selectOptions })); clk(host.querySelector('.dl-select__trigger')); clk(host.querySelector('.dl-menu__item[data-value="b"]')); } },
  { name: 'menu', act(clk) { const { host } = mount(menu({ name: 'm', label: 'm', options: menuOptions })); clk(host.querySelector('.dl-menubtn__trigger')); clk(host.querySelector('.dl-menu__item[data-value="a"]')); } },
  { name: 'nav', act(clk) { const { host } = mount(nav({ label: 'n', sections: navSections({}) })); clk(host.querySelector('.dl-nav__item[data-value="tasks"]')); } },
  { name: 'toast-action', act(clk) { const { el } = showToast({ message: 'm', persistent: true, actions: [{ label: '撤销', value: 'undo' }] }); clk(el.querySelector('.dl-toast__action')); } },
  { name: 'toast-close', act(clk) { const { el } = showToast({ message: 'm', persistent: true }); clk(el.querySelector('.dl-toast__close')); } },
  { name: 'dialog-close-button', act(clk) { const d = mountDialog({ label: 'd', children: trusted('<button data-dialog-close type="button">x</button>') }); d.open(); clk(d.el.querySelector('[data-dialog-close]')); } },
  { name: 'dialog-esc', fixed: 'keyboard', act() { const d = mountDialog({ label: 'd' }); d.open(); fire(d.el, 'cancel', { bubbles: false }); } },
  { name: 'input-change', fixed: 'user', act() { const { host } = mount(input({ name: 'i', label: 'i', value: 'start' })); const control = host.querySelector('.dl-input__control'); control.value = 'next'; fire(control, 'change'); } },
];

function exercise(clk) {
  return gestures.map(gesture => {
    resetBody();
    const rec = record();
    try { gesture.act(clk); } finally { rec.stop(); }
    return { gesture, log: [...rec.log] };
  });
}
const clickRuns = exercise(click);
const keyboardRuns = exercise(keyboardClick);

test('前提：每个手势都至少派发了一个 ui:* 事件（否则下面的横向断言是空转）', () => {
  for (const { gesture, log } of [...clickRuns, ...keyboardRuns]) assert.ok(log.length >= 1, gesture.name);
});

test('E-8：鼠标点击 source 是 user，键盘激活（click.detail 0）是 keyboard——所有组件的所有事件一致；Esc 固定 keyboard、input 的 change 固定 user', () => {
  for (const { gesture, log } of clickRuns) for (const item of log) assert.equal(item.detail.source, gesture.fixed ?? 'user', `${gesture.name} ${item.type} click`);
  for (const { gesture, log } of keyboardRuns) for (const item of log) assert.equal(item.detail.source, gesture.fixed ?? 'keyboard', `${gesture.name} ${item.type} keyboardClick`);
});

test('E-2：所有组件的事件都冒泡且 composed，detail 通过 schema（detailErrors 为空）', () => {
  for (const { gesture, log } of [...clickRuns, ...keyboardRuns]) for (const item of log) {
    assert.equal(item.bubbles, true, `${gesture.name} ${item.type}`);
    assert.equal(item.composed, true, `${gesture.name} ${item.type}`);
    assert.deepEqual(detailErrors(item.detail), [], `${gesture.name} ${item.type}`);
  }
});

test('E-4：open / close / dismiss 的 value 一律是 null；change / select 的 value 不是 null', () => {
  const seen = new Set();
  for (const { gesture, log } of clickRuns) for (const item of log) {
    seen.add(item.type);
    if (['ui:open', 'ui:close', 'ui:dismiss'].includes(item.type)) assert.equal(item.detail.value, null, `${gesture.name} ${item.type}`);
    else assert.notEqual(item.detail.value, null, `${gesture.name} ${item.type}`);
  }
  assert.deepEqual([...seen].sort(), ['ui:change', 'ui:close', 'ui:dismiss', 'ui:open', 'ui:select'], '五个 verb 都被覆盖到');
});

test('E-5：previousValue 只出现在 ui:change 里，且每个 ui:change 都带；其他 verb 不带', () => {
  for (const { gesture, log } of clickRuns) for (const item of log) {
    assert.equal('previousValue' in item.detail, item.type === 'ui:change', `${gesture.name} ${item.type}`);
  }
});

test('E-6：只有 ui:change 与 ui:dismiss 可取消；ui:select / open / close 不可取消', () => {
  for (const { gesture, log } of clickRuns) for (const item of log) {
    assert.equal(item.cancelable, ['ui:change', 'ui:dismiss'].includes(item.type), `${gesture.name} ${item.type}`);
  }
});

test('E-7：改 props 重绘（morph）所有受控组件都静默', t => {
  const cases = [
    ['checkbox', props => checkbox({ name: 'c', label: 'c', checked: false, ...props }), { checked: true }],
    ['switch', props => switchControl({ name: 's', label: 's', checked: false, ...props }), { checked: true }],
    ['segmented', props => segmented({ name: 'g', label: 'g', value: 'all', options: segOptions, ...props }), { value: 'done' }],
    ['select', props => select({ name: 'p', label: 'p', value: 'a', options: selectOptions, ...props }), { value: 'b' }],
    ['menu', props => menu({ name: 'm', label: 'm', options: menuOptions, ...props }), { label: 'renamed' }],
    ['input', props => input({ name: 'i', label: 'i', value: 'x', ...props }), { value: 'y' }],
    ['nav', props => nav({ label: 'n', sections: navSections(props) }), { active: 'tasks' }],
  ];
  for (const [name, make, next] of cases) {
    resetBody();
    const { host } = mount(make({}));
    const rec = record(); t.after(rec.stop);
    morph(host, make(next));
    assert.equal(rec.log.length, 0, name);
    rec.stop();
  }
});

test('E-7：程序化关闭（closeMenus / closeSelects / dialog.close / dialog.update / dialog.destroy / toast.dismiss）静默', t => {
  resetBody();
  const m = mount(menu({ name: 'm', label: 'm', options: menuOptions })).host;
  const s = mount(select({ name: 'p', label: 'p', value: 'a', options: selectOptions })).host;
  click(m.querySelector('.dl-menubtn__trigger'));
  click(s.querySelector('.dl-select__trigger'));
  const d = mountDialog({ label: 'd' }); d.open();
  const toast = showToast({ message: 'm', persistent: true });
  const rec = record(); t.after(rec.stop);
  closeMenus(); closeSelects();
  d.update(trusted('<p>x</p>')); d.close(); d.open(); d.destroy();
  toast.dismiss();
  assert.equal(rec.log.length, 0);
  assert.equal(m.querySelector('.dl-menubtn__trigger').getAttribute('aria-expanded'), 'false');
  assert.equal(s.querySelector('.dl-select__trigger').getAttribute('aria-expanded'), 'false');
  assert.equal(d.el.isConnected, false);
});

test('E-10：toast 的动作先派发 ui:select 再移除节点（事件期间节点仍在文档里）', t => {
  resetBody();
  const { el } = showToast({ message: 'm', persistent: true, actions: [{ label: '撤销', value: 'undo' }] });
  let connected = null;
  const probe = () => { connected = el.isConnected; };
  document.addEventListener('ui:select', probe);
  t.after(() => document.removeEventListener('ui:select', probe));
  click(el.querySelector('.dl-toast__action'));
  assert.equal(connected, true);
  assert.equal(el.isConnected, false);
});

test('E-10：menu 选中一项时 ui:select 先于 ui:close（close 在 select 之后）', { todo: '已知偏差 D4：menu.js 先 close 再 select，顺序与契约 E-10 相反；改组件顺序后移除 todo' }, () => {
  resetBody();
  const { host } = mount(menu({ name: 'm', label: 'm', options: menuOptions }));
  click(host.querySelector('.dl-menubtn__trigger'));
  const rec = record();
  try { click(host.querySelector('.dl-menu__item[data-value="a"]')); } finally { rec.stop(); }
  assert.deepEqual(rec.types(), ['ui:select', 'ui:close']);
});
