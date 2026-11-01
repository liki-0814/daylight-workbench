// menu（动作菜单）：开合、键盘导航、ui:open / ui:close / ui:select 的 detail 与 source、单开、程序化关闭静默、翻转、重绘保持展开。
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, resetBody, mount, click, keyboardClick, keydown, record } from './helpers/mini-dom.mjs';

installDom();
const { menu, closeMenus } = await import('../public/ui/components/menu/menu.js');
const { morph } = await import('../public/ui/core/morph.js');
beforeEach(resetBody);

const options = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B', disabled: true },
  { divider: true },
  { value: 'c', label: 'C', danger: true, meta: '⌘C' },
];
let seq = 0;
function build(props = {}) {
  const id = props.id ?? `m${++seq}`;
  const { host, el: root } = mount(menu({ name: 'more', label: '更多', options, id, ...props }));
  const trigger = root.querySelector(':scope > .dl-menubtn__trigger'), list = root.querySelector(':scope > .dl-menu');
  const item = value => list.querySelector(`.dl-menu__item[data-value="${value}"]`);
  return { host, root, trigger, list, item, id };
}
const isOpen = m => !m.list.hidden;

test('点击触发按钮打开：list 显示、aria-expanded=true、data-open=1、焦点落到第一个可用项、派发一次 ui:open（value:null，source:user，不可取消）', t => {
  const rec = record(); t.after(rec.stop);
  const m = build();
  assert.equal(isOpen(m), false);
  assert.equal(m.trigger.getAttribute('aria-expanded'), 'false');
  click(m.trigger);
  assert.equal(isOpen(m), true);
  assert.equal(m.trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(m.root.dataset.open, '1');
  assert.equal(document.activeElement, m.item('a'));
  assert.equal(rec.log.length, 1);
  assert.equal(rec.log[0].type, 'ui:open');
  assert.equal(rec.log[0].target, m.root);
  assert.deepEqual(rec.log[0].detail, { value: null, source: 'user' });
  assert.equal(rec.log[0].cancelable, false);
  assert.equal(rec.log[0].bubbles, true);
});

test('再点触发按钮关闭：list 隐藏、aria-expanded=false、data-open 移除，派发 ui:close；可以再次打开', t => {
  const rec = record(); t.after(rec.stop);
  const m = build();
  click(m.trigger);
  click(m.trigger);
  assert.equal(isOpen(m), false);
  assert.equal(m.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(m.root.hasAttribute('data-open'), false);
  assert.deepEqual(rec.types(), ['ui:open', 'ui:close']);
  assert.deepEqual(rec.log[1].detail, { value: null, source: 'user' });
  click(m.trigger);
  assert.equal(isOpen(m), true);
  assert.deepEqual(rec.types(), ['ui:open', 'ui:close', 'ui:open']);
});

test('键盘：触发按钮上 ArrowDown / ArrowUp 打开（preventDefault，source:keyboard）；其他按键关闭状态下什么都不做', t => {
  const rec = record(); t.after(rec.stop);
  const m = build();
  const other = keydown(m.trigger, 'a');
  assert.equal(other.defaultPrevented, false);
  assert.equal(keydown(m.trigger, 'Escape').defaultPrevented, false);
  assert.equal(keydown(m.trigger, 'Tab').defaultPrevented, false);
  assert.equal(isOpen(m), false);
  assert.equal(rec.log.length, 0);
  const down = keydown(m.trigger, 'ArrowDown');
  assert.equal(down.defaultPrevented, true);
  assert.equal(isOpen(m), true);
  assert.deepEqual(rec.log[0].detail, { value: null, source: 'keyboard' });
  const up = build({ id: 'up-menu' });
  assert.equal(keydown(up.trigger, 'ArrowUp').defaultPrevented, true);
  assert.equal(isOpen(up), true);
  assert.equal(isOpen(m), false, '打开另一个时前一个被关掉');
  assert.equal(rec.log.at(-1).type, 'ui:open');
  assert.deepEqual(rec.log.at(-1).detail, { value: null, source: 'keyboard' });
});

test('Enter / Space 激活触发按钮（click.detail === 0）打开，source 是 keyboard', t => {
  const rec = record(); t.after(rec.stop);
  const m = build();
  keyboardClick(m.trigger);
  assert.equal(isOpen(m), true);
  assert.deepEqual(rec.log[0].detail, { value: null, source: 'keyboard' });
});

test('点击菜单之外关闭（ui:close，user）；没有打开的菜单时点击外部什么都不派发', t => {
  const rec = record(); t.after(rec.stop);
  const m = build();
  click(document.body);
  assert.equal(rec.log.length, 0);
  click(m.trigger);
  click(document.body);
  assert.equal(isOpen(m), false);
  assert.deepEqual(rec.types(), ['ui:open', 'ui:close']);
  assert.deepEqual(rec.log[1].detail, { value: null, source: 'user' });
});

test('Esc：关闭、焦点回到触发按钮、preventDefault + stopPropagation（不会再传给外层的 Esc 处理），ui:close 的 source 是 keyboard', t => {
  const rec = record(); t.after(rec.stop);
  const m = build();
  click(m.trigger);
  assert.equal(document.activeElement, m.item('a'));
  const escape = keydown(m.item('a'), 'Escape');
  assert.equal(escape.defaultPrevented, true);
  assert.equal(escape.stopped, true);
  assert.equal(isOpen(m), false);
  assert.equal(document.activeElement, m.trigger);
  assert.deepEqual(rec.log[1].detail, { value: null, source: 'keyboard' });
});

test('Tab 关闭（keyboard），不拦截 Tab 本身', t => {
  const rec = record(); t.after(rec.stop);
  const m = build();
  click(m.trigger);
  const tab = keydown(m.item('a'), 'Tab');
  assert.equal(tab.defaultPrevented, false);
  assert.equal(isOpen(m), false);
  assert.deepEqual(rec.log[1].detail, { value: null, source: 'keyboard' });
});

test('方向键在可用项之间移动焦点：跳过 disabled，循环；Home / End 到两端；都 preventDefault', () => {
  const m = build();
  click(m.trigger);
  assert.equal(document.activeElement, m.item('a'));
  assert.equal(keydown(m.item('a'), 'ArrowDown').defaultPrevented, true);
  assert.equal(document.activeElement, m.item('c'), '跳过 disabled 的 b');
  keydown(m.item('c'), 'ArrowDown');
  assert.equal(document.activeElement, m.item('a'), '向下循环');
  keydown(m.item('a'), 'ArrowUp');
  assert.equal(document.activeElement, m.item('c'), '向上循环');
  keydown(m.item('c'), 'Home');
  assert.equal(document.activeElement, m.item('a'));
  keydown(m.item('a'), 'End');
  assert.equal(document.activeElement, m.item('c'));
});

test('焦点还在触发按钮上时（菜单已开）：ArrowDown / Home 去第一项，ArrowUp / End 去最后一个可用项', () => {
  const m = build();
  click(m.trigger);
  m.trigger.focus();
  keydown(m.trigger, 'ArrowUp');
  assert.equal(document.activeElement, m.item('c'));
  m.trigger.focus();
  keydown(m.trigger, 'ArrowDown');
  assert.equal(document.activeElement, m.item('a'));
  m.trigger.focus();
  keydown(m.trigger, 'End');
  assert.equal(document.activeElement, m.item('c'));
  m.trigger.focus();
  keydown(m.trigger, 'Home');
  assert.equal(document.activeElement, m.item('a'));
});

test('选择一项：先 ui:select 再 ui:close（契约 E-10；value = 该项 data-value，没有 previousValue，不可取消），菜单关闭、焦点回触发按钮，菜单不保存值', t => {
  const rec = record(); t.after(rec.stop);
  const m = build();
  click(m.trigger);
  click(m.item('c'));
  assert.deepEqual(rec.types(), ['ui:open', 'ui:select', 'ui:close']);
  const select = rec.log[1];
  assert.deepEqual(rec.log[2].detail, { value: null, source: 'user' });
  assert.equal(rec.log[2].target, m.root);
  assert.equal(select.target, m.root);
  assert.deepEqual(select.detail, { value: 'c', source: 'user' });
  assert.equal(select.cancelable, false);
  assert.equal(isOpen(m), false);
  assert.equal(document.activeElement, m.trigger);
  assert.equal(m.root.querySelector('.dl-menubtn__text').textContent, '更多', '触发按钮文字不随选中项改变');
});

test('选择时 source 随触发动作：键盘激活（detail 0）→ keyboard，点击内部子元素也能选中', t => {
  const rec = record(); t.after(rec.stop);
  const m = build();
  click(m.trigger);
  keyboardClick(m.item('a'));
  assert.deepEqual(rec.log.slice(1).map(item => item.detail.source), ['keyboard', 'keyboard']);
  click(m.trigger);
  click(m.item('c').querySelector('.dl-menu__label'));
  assert.deepEqual(rec.log.at(-2).detail, { value: 'c', source: 'user' });
  assert.equal(rec.log.at(-2).type, 'ui:select');
  assert.equal(rec.log.at(-1).type, 'ui:close');
});

test('disabled 的菜单项点击无效：不派发、菜单仍然打开；点分隔线同样什么都不发生', t => {
  const rec = record(); t.after(rec.stop);
  const m = build();
  click(m.trigger);
  click(m.item('b'));
  click(m.list.querySelector('.dl-menu__divider'));
  assert.equal(isOpen(m), true);
  assert.deepEqual(rec.types(), ['ui:open']);
});

test('同时只开一个：打开第二个菜单会先关掉第一个（先 ui:close 第一个，再 ui:open 第二个）', t => {
  const rec = record(); t.after(rec.stop);
  const first = build(), second = build();
  click(first.trigger);
  click(second.trigger);
  assert.equal(isOpen(first), false);
  assert.equal(first.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(isOpen(second), true);
  assert.deepEqual(rec.log.map(item => [item.type, item.target]), [['ui:open', first.root], ['ui:close', first.root], ['ui:open', second.root]]);
});

test('closeMenus() 是程序化关闭：不派发 ui:close，状态完整复位；scope 限定只关该范围内的菜单', t => {
  const rec = record(); t.after(rec.stop);
  const m = build();
  click(m.trigger);
  rec.log.length = 0;
  const other = mount('<div class="elsewhere"></div>').el;
  closeMenus(other);
  assert.equal(isOpen(m), true, '范围之外的菜单不受影响');
  closeMenus(m.host);
  assert.equal(isOpen(m), false);
  assert.equal(m.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(m.root.hasAttribute('data-open'), false);
  assert.equal(rec.log.length, 0, '静默');
  click(m.trigger);
  closeMenus();
  assert.equal(isOpen(m), false);
  assert.deepEqual(rec.types(), ['ui:open'], '不带 scope 默认整个 document，同样静默');
});

test('disabled 的菜单：点击与 ArrowDown 都打不开，也不派发', t => {
  const rec = record(); t.after(rec.stop);
  const m = build({ disabled: true });
  click(m.trigger);
  keydown(m.trigger, 'ArrowDown');
  assert.equal(isOpen(m), false);
  assert.equal(m.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(rec.log.length, 0);
});

test('位置：下方放不下、上方更宽松时翻转（data-flip=1）；放得下不翻；向上的菜单反过来；关闭时清掉', () => {
  window.innerHeight = 100;
  const tight = build({ placement: 'down' });
  tight.root.rect = { top: 60, bottom: 80, left: 0, right: 0, width: 0, height: 20 };
  tight.list.rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 50 };
  click(tight.trigger);
  assert.equal(tight.root.getAttribute('data-flip'), '1', '下方 20px 放不下 58px，上方 60px 更宽松');
  click(tight.trigger);
  assert.equal(tight.root.hasAttribute('data-flip'), false, '关闭清掉 flip');
  const roomy = build({ placement: 'down' });
  roomy.root.rect = { top: 10, bottom: 30, left: 0, right: 0, width: 0, height: 20 };
  roomy.list.rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 50 };
  click(roomy.trigger);
  assert.equal(roomy.root.hasAttribute('data-flip'), false, '下方 70px 放得下');
  const cramped = build({ placement: 'up' });
  cramped.root.rect = { top: 10, bottom: 30, left: 0, right: 0, width: 0, height: 20 };
  cramped.list.rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 50 };
  click(cramped.trigger);
  assert.equal(cramped.root.getAttribute('data-flip'), '1', '上方只有 10px，下方 70px');
  const upOk = build({ placement: 'up-end' });
  upOk.root.rect = { top: 70, bottom: 90, left: 0, right: 0, width: 0, height: 20 };
  upOk.list.rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 50 };
  click(upOk.trigger);
  assert.equal(upOk.root.hasAttribute('data-flip'), false, '上方 70px 放得下');
  const bothTight = build({ placement: 'down' });
  bothTight.root.rect = { top: 20, bottom: 80, left: 0, right: 0, width: 0, height: 60 };
  bothTight.list.rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 90 };
  click(bothTight.trigger);
  assert.equal(bothTight.root.hasAttribute('data-flip'), false, '上方 20px 并不比下方 20px 宽松，不翻');
});

test('页面重绘（morph）不收起已展开的菜单，也不派发事件（data-ui-keep）', t => {
  const rec = record(); t.after(rec.stop);
  const m = build({ id: 'stable' });
  click(m.trigger);
  rec.log.length = 0;
  morph(m.host, menu({ name: 'more', label: '更多', options, id: 'stable' }));
  assert.equal(m.host.firstElementChild, m.root);
  assert.equal(isOpen(m), true);
  assert.equal(m.trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(m.root.dataset.open, '1');
  assert.equal(rec.log.length, 0);
});

test('标记：角色、aria 关联、data-name / data-placement、禁用项、danger / meta / 分隔线、trigger 文字与图标、variant；label 必填', () => {
  const m = build({ id: 'mk', variant: 'ghost', placement: 'sideways' });
  assert.equal(m.trigger.getAttribute('aria-haspopup'), 'menu');
  assert.equal(m.trigger.getAttribute('aria-controls'), 'mk-list');
  assert.equal(m.trigger.getAttribute('aria-label'), '更多');
  assert.equal(m.trigger.getAttribute('id'), 'mk');
  assert.equal(m.list.getAttribute('role'), 'menu');
  assert.equal(m.list.getAttribute('aria-labelledby'), 'mk');
  assert.equal(m.list.getAttribute('id'), 'mk-list');
  assert.equal(m.list.hidden, true);
  assert.ok(m.root.classList.contains('dl-menubtn--ghost'));
  assert.equal(m.root.getAttribute('data-name'), 'more');
  assert.equal(m.root.getAttribute('data-placement'), 'end', '非法 placement 回落到 end');
  assert.equal(build({ placement: 'up' }).root.getAttribute('data-placement'), 'up');
  assert.equal(m.item('a').getAttribute('role'), 'menuitem');
  assert.equal(m.item('a').getAttribute('tabindex'), '-1');
  assert.equal(m.item('a').disabled, false);
  assert.equal(m.item('b').disabled, true);
  assert.ok(m.item('c').classList.contains('is-danger'));
  assert.equal(m.item('a').classList.contains('is-danger'), false);
  assert.equal(m.item('c').querySelector('.dl-menu__meta').textContent, '⌘C');
  assert.equal(m.item('a').querySelector('.dl-menu__meta'), null);
  assert.equal(m.list.querySelector('.dl-menu__divider').getAttribute('role'), 'separator');
  assert.equal(m.root.querySelector('.dl-menubtn__text').textContent, '更多');
  assert.ok(m.trigger.querySelector('.dl-menubtn__chev'), '默认带下拉箭头');
  const custom = build({ trigger: { text: '操作', icon: 'gear' } });
  assert.equal(custom.root.querySelector('.dl-menubtn__text').textContent, '操作');
  assert.equal(custom.trigger.querySelector('.dl-menubtn__chev'), null, '有图标时没有下拉箭头');
  assert.throws(() => menu({ options }), TypeError);
});
