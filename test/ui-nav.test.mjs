// nav：点击派发 ui:select（不自己改选中态）、方向键 / Home / End 移动焦点、updateNav 保住滚动位置、标记。
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, resetBody, mount, click, keyboardClick, keydown, record } from './helpers/mini-dom.mjs';

installDom();
const { nav, updateNav } = await import('../public/ui/components/nav/nav.js');
const { trusted } = await import('../public/ui/core/html.js');
beforeEach(resetBody);

const sections = [{
  title: '工作',
  items: [
    { value: 'home', label: '首页', icon: 'home', active: true },
    { value: 'tasks', label: '任务', count: 3 },
    { value: 'off', label: '停用', attrs: { disabled: true } },
  ],
}];
const footer = [{ value: 'settings', label: '设置', kbd: '⌘,' }];
function build(props = {}) {
  const { host, el } = mount(nav({ label: '主导航', name: 'main', sections, footer, ...props }));
  const item = value => el.querySelector(`.dl-nav__item[data-value="${value}"]`);
  return { host, el, item };
}

test('点导航项：在 .dl-nav 上派发一次 ui:select {value, source:user}，不可取消、冒泡；不改变 is-active（选中态由页面重绘）', t => {
  const rec = record(); t.after(rec.stop);
  const n = build();
  click(n.item('tasks'));
  assert.deepEqual(rec.types(), ['ui:select']);
  const [{ target, detail, cancelable, bubbles, composed }] = rec.log;
  assert.equal(target, n.el);
  assert.deepEqual(detail, { value: 'tasks', source: 'user' });
  assert.equal(cancelable, false);
  assert.equal(bubbles, true);
  assert.equal(composed, true);
  assert.equal(n.item('home').classList.contains('is-active'), true);
  assert.equal(n.item('tasks').classList.contains('is-active'), false);
});

test('点导航项里的子元素（标签 / 图标 / 计数）同样选中该项；页脚项也算；键盘激活（click.detail 0）source 是 keyboard', t => {
  const rec = record(); t.after(rec.stop);
  const n = build();
  click(n.item('tasks').querySelector('.dl-nav__label'));
  click(n.item('tasks').querySelector('.dl-nav__count'));
  click(n.item('home').querySelector('svg'));
  keyboardClick(n.item('settings'));
  assert.deepEqual(rec.log.map(item => item.detail), [
    { value: 'tasks', source: 'user' },
    { value: 'tasks', source: 'user' },
    { value: 'home', source: 'user' },
    { value: 'settings', source: 'keyboard' },
  ]);
  assert.ok(rec.log.every(item => item.target === n.el));
});

test('点导航项以外的位置（标题、分区、滚动区、导航本身、分区操作按钮）不派发事件；缺 data-value 的项 value 是空串', t => {
  const rec = record(); t.after(rec.stop);
  const n = build({ sections: [{ title: '工作', action: { label: '新建' }, items: [{ value: 'home', label: '首页' }] }] });
  click(n.el.querySelector('.dl-nav__title'));
  click(n.el.querySelector('.dl-nav__add'));
  click(n.el.querySelector('.dl-nav__section'));
  click(n.el.querySelector('.dl-nav__scroll'));
  click(n.el);
  assert.equal(rec.log.length, 0);
  const home = n.item('home');
  home.removeAttribute('data-value');
  click(home);
  assert.deepEqual(rec.log[0].detail, { value: '', source: 'user' });
});

test('游离在 .dl-nav 之外的 .dl-nav__item 被忽略', t => {
  const rec = record(); t.after(rec.stop);
  const { el } = mount('<button class="dl-nav__item" data-value="x">x</button>');
  click(el);
  assert.equal(rec.log.length, 0);
});

test('两个导航：事件各自在自己的 .dl-nav 上派发；方向键只在自己的导航内移动', t => {
  const rec = record(); t.after(rec.stop);
  const a = build({ name: 'a' }), b = build({ name: 'b', sections: [{ items: [{ value: 'only', label: '唯一' }] }], footer: [] });
  click(b.item('only'));
  assert.equal(rec.log[0].target, b.el);
  assert.equal(rec.log[0].target.dataset.name, 'b');
  click(a.item('home'));
  assert.equal(rec.log[1].target, a.el);
  b.item('only').focus();
  keydown(b.item('only'), 'ArrowDown');
  assert.equal(document.activeElement, b.item('only'), '只有一项：停在原处，不会跳到别的导航');
});

test('ArrowDown / ArrowUp：在可用项之间移动焦点（跳过 disabled，含页脚项，首尾循环），preventDefault，不派发 ui:select', t => {
  const rec = record(); t.after(rec.stop);
  const n = build();
  n.item('home').focus();
  assert.equal(keydown(n.item('home'), 'ArrowDown').defaultPrevented, true);
  assert.equal(document.activeElement, n.item('tasks'));
  keydown(n.item('tasks'), 'ArrowDown');
  assert.equal(document.activeElement, n.item('settings'), '跳过 disabled 的 off');
  keydown(n.item('settings'), 'ArrowDown');
  assert.equal(document.activeElement, n.item('home'), '到底后循环到第一项');
  keydown(n.item('home'), 'ArrowUp');
  assert.equal(document.activeElement, n.item('settings'), '到顶后循环到最后一项');
  keydown(n.item('settings'), 'ArrowUp');
  assert.equal(document.activeElement, n.item('tasks'), '向上同样跳过 disabled');
  assert.equal(rec.log.length, 0);
});

test('Home / End：直接到第一个 / 最后一个可用项；其他按键不处理、不阻止默认行为', () => {
  const n = build();
  n.item('tasks').focus();
  assert.equal(keydown(n.item('tasks'), 'End').defaultPrevented, true);
  assert.equal(document.activeElement, n.item('settings'));
  assert.equal(keydown(n.item('settings'), 'Home').defaultPrevented, true);
  assert.equal(document.activeElement, n.item('home'));
  for (const key of ['ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Tab', 'a']) {
    assert.equal(keydown(n.item('home'), key).defaultPrevented, false, key);
  }
  assert.equal(document.activeElement, n.item('home'));
});

test('导航之外的元素按方向键不处理', () => {
  build();
  const { el } = mount('<button class="plain">p</button>');
  assert.equal(keydown(el, 'ArrowDown').defaultPrevented, false);
});

test('updateNav：就地更新（复用节点、改文字与选中态），返回 host，不派发事件', t => {
  const rec = record(); t.after(rec.stop);
  const n = build();
  const homeNode = n.item('home');
  const result = updateNav(n.host, nav({ label: '主导航', name: 'main', sections: [{ title: '工作', items: [{ value: 'home', label: '首页2' }, { value: 'tasks', label: '任务', active: true, count: 4 }] }], footer }));
  assert.equal(result, n.host);
  assert.equal(n.item('home'), homeNode, '带 data-key 的项被复用');
  assert.equal(homeNode.querySelector('.dl-nav__label').textContent, '首页2');
  assert.equal(homeNode.classList.contains('is-active'), false);
  assert.equal(homeNode.hasAttribute('aria-current'), false);
  assert.equal(n.item('tasks').classList.contains('is-active'), true);
  assert.equal(n.item('tasks').getAttribute('aria-current'), 'page');
  assert.equal(n.item('tasks').querySelector('.dl-nav__count').textContent, '4');
  assert.equal(n.item('off'), null);
  assert.equal(rec.log.length, 0);
});

test('updateNav 保住滚动区的 scrollTop：重绘后新出现的滚动容器恢复到原位置（morph 按标签复用节点，会把旧滚动容器改成别的）', () => {
  const n = build({ header: undefined });
  const old = n.el.querySelector('.dl-nav__scroll');
  old.scrollTop = 120;
  updateNav(n.host, nav({ label: '主导航', name: 'main', header: trusted('<b>品牌</b>'), sections, footer }));
  const next = n.el.querySelector('.dl-nav__scroll');
  assert.notEqual(next, old, '前提：旧的滚动容器被复用成了 header');
  assert.equal(n.el.querySelector('.dl-nav__header'), old);
  assert.equal(next.scrollTop, 120);
});

test('updateNav：滚动区原位保留时 scrollTop 不变；原本没有滚动区也不报错', () => {
  const n = build();
  const scroller = n.el.querySelector('.dl-nav__scroll');
  scroller.scrollTop = 40;
  updateNav(n.host, nav({ label: '主导航', name: 'main', sections, footer }));
  assert.equal(n.el.querySelector('.dl-nav__scroll'), scroller);
  assert.equal(scroller.scrollTop, 40);
  const { el: empty } = mount('<div class="empty-host"></div>');
  assert.doesNotThrow(() => updateNav(empty, nav({ label: '主导航', sections })));
  assert.equal(empty.querySelector('.dl-nav__scroll').scrollTop, 0);
});

test('标记：nav 的 aria-label、data-ui、data-name、kind class（未知 kind 回落 sidebar）、额外属性；没有 name 就没有 data-name', () => {
  const n = build({ kind: 'list', attrs: { 'data-extra': 'x' } });
  assert.equal(n.el.nodeName, 'NAV');
  assert.equal(n.el.getAttribute('aria-label'), '主导航');
  assert.equal(n.el.getAttribute('data-ui'), 'nav');
  assert.equal(n.el.getAttribute('data-name'), 'main');
  assert.equal(n.el.getAttribute('data-extra'), 'x');
  assert.ok(n.el.classList.contains('dl-nav--list'));
  assert.equal(n.el.classList.contains('dl-nav--sidebar'), false);
  assert.ok(mount(nav({ label: 'x', kind: 'weird' })).el.classList.contains('dl-nav--sidebar'));
  assert.ok(mount(nav({ label: 'x' })).el.classList.contains('dl-nav--sidebar'));
  assert.equal(mount(nav({ label: 'x' })).el.hasAttribute('data-name'), false);
});

test('标记：导航项（data-value / data-key、选中项 aria-current、图标 / 圆点、计数 0 也显示、kbd）与分区（标题、操作按钮、空态、key 回落）', () => {
  const n = build({
    sections: [
      { title: '工作', action: { label: '新建任务', attrs: { 'data-action': 'create' } }, items: [{ value: 'home', label: '首页', icon: 'home', active: true }, { value: 'dotted', label: '圆点', dot: 'green' }, { value: 'zero', label: '零', count: 0 }, { value: 'blank', label: '空计数', count: '' }] },
      { items: [], empty: '暂无' },
    ],
  });
  const home = n.item('home');
  assert.equal(home.getAttribute('data-key'), 'home');
  assert.equal(home.getAttribute('aria-current'), 'page');
  assert.ok(home.classList.contains('is-active'));
  assert.equal(home.getAttribute('type'), 'button');
  assert.ok(home.querySelector('svg'));
  assert.equal(n.item('tasks'), null);
  assert.ok(n.item('dotted').querySelector('.dl-dot--green'));
  assert.equal(n.item('dotted').querySelector('svg'), null);
  assert.equal(n.item('zero').querySelector('.dl-nav__count').textContent, '0');
  assert.equal(n.item('blank').querySelector('.dl-nav__count'), null);
  assert.equal(n.item('dotted').hasAttribute('aria-current'), false);
  assert.equal(n.item('settings').querySelector('kbd').textContent, '⌘,');
  assert.equal(n.el.querySelector('.dl-nav__title').textContent.startsWith('工作'), true);
  const add = n.el.querySelector('.dl-nav__add');
  assert.equal(add.getAttribute('aria-label'), '新建任务');
  assert.equal(add.getAttribute('data-action'), 'create');
  const sectionsEls = n.el.querySelectorAll('.dl-nav__section');
  assert.equal(sectionsEls[0].getAttribute('data-key'), '工作');
  assert.equal(sectionsEls[1].getAttribute('data-key'), 'main');
  assert.equal(sectionsEls[1].querySelector('.dl-nav__title'), null);
  assert.equal(sectionsEls[1].querySelector('.dl-nav__empty').textContent, '暂无');
  assert.equal(n.el.querySelector('.dl-nav__footer .dl-nav__item').dataset.value, 'settings');
});

test('标记：header 渲染在滚动区之前（需要 trusted），没有 header / footer 时对应容器不存在；label 必填；文案被转义', () => {
  const withHeader = mount(nav({ label: 'x', header: trusted('<b class="brand">品牌</b>'), sections })).el;
  assert.equal(withHeader.firstElementChild.className, 'dl-nav__header');
  assert.ok(withHeader.querySelector('.dl-nav__header > .brand'));
  const bare = mount(nav({ label: 'x', sections })).el;
  assert.equal(bare.querySelector('.dl-nav__header'), null);
  assert.equal(bare.querySelector('.dl-nav__footer'), null);
  assert.ok(bare.querySelector('.dl-nav__scroll'));
  const nasty = mount(nav({ label: 'x', sections: [{ items: [{ value: 'v"><i class="evil">', label: '<b class="evil">l</b>' }] }] })).el;
  assert.equal(nasty.querySelector('.evil'), null);
  assert.equal(nasty.querySelector('.dl-nav__item').dataset.value, 'v"><i class="evil">');
  assert.equal(nasty.querySelector('.dl-nav__label').textContent, '<b class="evil">l</b>');
  assert.throws(() => nav({}), TypeError);
  assert.throws(() => nav({ label: '' }), TypeError);
});
