// checkbox / switch 的行为：乐观翻转、ui:change 的 detail 与 source、被取消后回滚、禁用、事件委托边界、受控重绘。
// 两个组件的行为一致，所以同一组断言对两者各跑一遍（任何一个组件单独改坏都会红）。
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, resetBody, mount, click, keyboardClick, record, preventAll } from './helpers/mini-dom.mjs';

installDom();
const { checkbox } = await import('../public/ui/components/checkbox/checkbox.js');
const { switchControl } = await import('../public/ui/components/switch/switch.js');
const { morph } = await import('../public/ui/core/morph.js');
beforeEach(resetBody);

const kinds = [
  { name: 'checkbox', make: checkbox, selector: '.dl-check', role: 'checkbox', inner: 'svg' },
  { name: 'switch', make: switchControl, selector: '.dl-switch', role: 'switch', inner: '.dl-switch__thumb' },
];
const checked = el => el.getAttribute('aria-checked');

for (const kind of kinds) {
  const render = (props = {}) => mount(kind.make({ name: 'flag', label: '标记', ...props }));

  test(`${kind.name}：点击先乐观翻转 aria-checked，并派发一次 ui:change（value / previousValue / source:user，可取消、冒泡）`, t => {
    const rec = record(); t.after(rec.stop);
    const { el } = render({ checked: false });
    click(el);
    assert.equal(checked(el), 'true');
    assert.equal(rec.log.length, 1);
    const [seen] = rec.log;
    assert.equal(seen.type, 'ui:change');
    assert.equal(seen.target, el, 'target 是控件本身');
    assert.deepEqual(seen.detail, { value: true, previousValue: false, source: 'user' });
    assert.equal(seen.cancelable, true);
    assert.equal(seen.bubbles, true);
    assert.equal(seen.composed, true);
  });

  test(`${kind.name}：已选中时点击翻回 false，detail 的 value / previousValue 对调`, t => {
    const rec = record(); t.after(rec.stop);
    const { el } = render({ checked: true });
    assert.equal(checked(el), 'true');
    click(el);
    assert.equal(checked(el), 'false');
    assert.deepEqual(rec.log[0].detail, { value: false, previousValue: true, source: 'user' });
    click(el);
    assert.equal(checked(el), 'true');
    assert.deepEqual(rec.log[1].detail, { value: true, previousValue: false, source: 'user' });
  });

  test(`${kind.name}：键盘激活（click.detail === 0，Enter / Space 或 el.click()）的 source 是 keyboard`, t => {
    const rec = record(); t.after(rec.stop);
    const { el } = render({ checked: false });
    keyboardClick(el);
    el.click();
    click(el);
    assert.deepEqual(rec.log.map(item => item.detail.source), ['keyboard', 'keyboard', 'user']);
    assert.deepEqual(rec.log.map(item => item.detail.value), [true, false, true]);
  });

  test(`${kind.name}：页面取消 ui:change → aria-checked 回到 previousValue（两个方向都回）`, t => {
    const rec = record(); t.after(rec.stop);
    const off = preventAll('ui:change'); t.after(off);
    const unchecked = render({ checked: false }).el, on = render({ checked: true }).el;
    click(unchecked);
    click(on);
    assert.equal(checked(unchecked), 'false', '从 false 翻过去又被取消');
    assert.equal(checked(on), 'true', '从 true 翻过去又被取消');
    assert.equal(rec.log.length, 2, '取消的是事件，不是第二次派发');
    assert.deepEqual(rec.log.map(item => item.detail.value), [true, false]);
  });

  test(`${kind.name}：监听器收到事件时 DOM 已经是乐观更新后的状态（取消才回滚）`, t => {
    const { el } = render({ checked: false });
    let during = null;
    const listen = () => { during = checked(el); };
    document.addEventListener('ui:change', listen);
    t.after(() => document.removeEventListener('ui:change', listen));
    click(el);
    assert.equal(during, 'true');
  });

  test(`${kind.name}：disabled 的控件点击不变、不派发`, t => {
    const rec = record(); t.after(rec.stop);
    const { el } = render({ checked: false, disabled: true });
    assert.equal(el.disabled, true);
    click(el);
    keyboardClick(el);
    assert.equal(checked(el), 'false');
    assert.equal(rec.log.length, 0);
  });

  test(`${kind.name}：点击控件内部的子元素同样触发，事件的 target 仍是控件`, t => {
    const rec = record(); t.after(rec.stop);
    const { el } = render({ checked: false });
    const child = el.querySelector(kind.inner);
    assert.ok(child, `${kind.inner} 在控件里`);
    click(child);
    assert.equal(checked(el), 'true');
    assert.equal(rec.log.length, 1);
    assert.equal(rec.log[0].target, el);
  });

  test(`${kind.name}：控件之外的点击不派发，也不碰其他实例`, t => {
    const rec = record(); t.after(rec.stop);
    const first = render({ checked: false }).el, second = render({ checked: false }).el;
    const { el: other } = mount('<button class="other" type="button">x</button>');
    click(other);
    click(document.body);
    assert.equal(rec.log.length, 0);
    click(first);
    assert.equal(checked(first), 'true');
    assert.equal(checked(second), 'false', '另一个实例不受影响');
    assert.equal(rec.log.length, 1);
    assert.equal(rec.log[0].target, first);
  });

  test(`${kind.name}：受控——页面用 props 重绘（update）以 checked 为准，且不派发任何事件；取消后的重绘把乐观值写回`, t => {
    const rec = record(); t.after(rec.stop);
    const { host, el } = render({ checked: false });
    morph(host, kind.make({ name: 'flag', label: '标记', checked: true }));
    assert.equal(host.firstElementChild, el, 'morph 复用同一个节点');
    assert.equal(checked(el), 'true');
    assert.equal(rec.log.length, 0, 'update 不回声');
    click(el);
    assert.equal(checked(el), 'false');
    morph(host, kind.make({ name: 'flag', label: '标记', checked: true }));
    assert.equal(checked(el), 'true', '保存失败：页面用未变的 state 重绘，写回真实值');
    assert.equal(rec.log.length, 1, '重绘本身不派发');
  });

  test(`${kind.name}：标记——role、aria-label、data-name、id、额外属性、disabled；label 必填`, () => {
    const { el } = render({ checked: true, id: 'the-id', attrs: { 'data-x': '1' } });
    assert.ok(el.matches(kind.selector));
    assert.equal(el.getAttribute('role'), kind.role);
    assert.equal(el.getAttribute('type'), 'button');
    assert.equal(el.getAttribute('aria-label'), '标记');
    assert.equal(el.getAttribute('aria-checked'), 'true');
    assert.equal(el.getAttribute('data-name'), 'flag');
    assert.equal(el.getAttribute('id'), 'the-id');
    assert.equal(el.getAttribute('data-x'), '1');
    assert.equal(el.hasAttribute('disabled'), false);
    assert.equal(mount(kind.make({ label: 'l', checked: false })).el.getAttribute('aria-checked'), 'false');
    assert.equal(mount(kind.make({ label: 'l' })).el.hasAttribute('data-name'), false, '没给 name 就没有 data-name');
    assert.equal(mount(kind.make({ label: 'l', disabled: true })).el.hasAttribute('disabled'), true);
    assert.throws(() => kind.make({ name: 'flag' }), TypeError);
    assert.throws(() => kind.make({ name: 'flag', label: '' }), /label/);
  });
}

test('switch：busy 写出 aria-busy="true"，不写就没有；checkbox 的 label 会被转义', () => {
  assert.equal(mount(switchControl({ label: 'l', busy: true })).el.getAttribute('aria-busy'), 'true');
  assert.equal(mount(switchControl({ label: 'l' })).el.hasAttribute('aria-busy'), false);
  assert.equal(mount(checkbox({ label: '"><b>x</b>' })).el.getAttribute('aria-label'), '"><b>x</b>', '属性值原样回到 DOM，没有逃逸出属性');
});
