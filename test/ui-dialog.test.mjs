// dialog：用户的关闭路径（Esc → cancel、点遮罩、[data-dialog-close]）派发 ui:dismiss / ui:close；
// 程序化 open / close / update / destroy 静默（E-7）；Cmd/Ctrl+Enter 提交；标记。
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, resetBody, mount, fire, click, keyboardClick, keydown, record, preventAll } from './helpers/mini-dom.mjs';

installDom();
const { dialog, mountDialog } = await import('../public/ui/components/dialog/dialog.js');
const { trusted } = await import('../public/ui/core/html.js');
beforeEach(resetBody);

const body = trusted('<p class="msg">hello</p><input class="field" type="text"><button class="submit" data-dialog-submit type="button">保存</button><button class="x" data-dialog-close type="button"><span>关闭</span></button>');
const opened = (props = {}) => {
  const m = mountDialog({ id: 'dlg', label: '测试', children: body, ...props });
  m.open();
  return m;
};
const cancel = el => fire(el, 'cancel', { bubbles: false });
const mouseAt = (el, clientX, clientY) => fire(el, 'mousedown', { clientX, clientY });

test('Esc（cancel 事件）：阻止原生关闭，先派发可取消的 ui:dismiss，没被取消就关闭并派发 ui:close；source 都是 keyboard，value 都是 null', t => {
  const rec = record(); t.after(rec.stop);
  const m = opened();
  const event = cancel(m.el);
  assert.equal(event.defaultPrevented, true, '原生 cancel 被拦住，关闭由组件接管');
  assert.deepEqual(rec.types(), ['ui:dismiss', 'ui:close']);
  assert.equal(rec.log[0].target, m.el);
  assert.equal(rec.log[0].cancelable, true);
  assert.deepEqual(rec.log[0].detail, { value: null, source: 'keyboard' });
  assert.equal(rec.log[1].cancelable, false);
  assert.deepEqual(rec.log[1].detail, { value: null, source: 'keyboard' });
  assert.equal(m.el.open, false);
});

test('页面取消 ui:dismiss：对话框保持打开，不派发 ui:close（原生 cancel 仍被拦住）', t => {
  const rec = record(); t.after(rec.stop);
  const off = preventAll('ui:dismiss'); t.after(off);
  const m = opened();
  const event = cancel(m.el);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(rec.types(), ['ui:dismiss']);
  assert.equal(m.el.open, true);
});

test('不是 .dl-dialog 的 cancel 事件被忽略', t => {
  const rec = record(); t.after(rec.stop);
  const { el } = mount('<div class="not-dialog"></div>');
  assert.equal(cancel(el).defaultPrevented, false);
  assert.equal(rec.log.length, 0);
});

test('点遮罩（mousedown 落在 dialog 自己、且在它的矩形之外）：ui:dismiss 后 ui:close，source:user；矩形边界上算在里面', t => {
  const rec = record(); t.after(rec.stop);
  const m = opened();
  m.el.rect = { left: 100, right: 300, top: 100, bottom: 300, width: 200, height: 200 };
  for (const [x, y] of [[100, 100], [300, 300], [100, 300], [300, 100], [200, 200]]) mouseAt(m.el, x, y);
  assert.equal(rec.log.length, 0, '边界与内部都不算遮罩');
  assert.equal(m.el.open, true);
  const outside = [[99, 200], [301, 200], [200, 99], [200, 301]];
  for (const [x, y] of outside) {
    rec.log.length = 0;
    m.open();
    mouseAt(m.el, x, y);
    assert.deepEqual(rec.types(), ['ui:dismiss', 'ui:close'], `${x},${y}`);
    assert.deepEqual(rec.log[1].detail, { value: null, source: 'user' });
    assert.equal(m.el.open, false);
  }
});

test('点遮罩被取消：保持打开；mousedown 落在对话框内部元素 / 已关闭的对话框上不处理', t => {
  const rec = record(); t.after(rec.stop);
  const m = opened();
  m.el.rect = { left: 100, right: 300, top: 100, bottom: 300, width: 200, height: 200 };
  mouseAt(m.el.querySelector('.dl-dialog__body'), 0, 0);
  mouseAt(m.el.querySelector('.field'), 0, 0);
  assert.equal(rec.log.length, 0);
  const off = preventAll('ui:dismiss');
  mouseAt(m.el, 0, 0);
  off();
  assert.deepEqual(rec.types(), ['ui:dismiss']);
  assert.equal(m.el.open, true);
  m.close();
  rec.log.length = 0;
  mouseAt(m.el, 0, 0);
  assert.equal(rec.log.length, 0);
});

test('[data-dialog-close]：点击只派发 ui:close（不经过 ui:dismiss），关闭对话框；键盘激活 source 是 keyboard；点内部子元素同样有效', t => {
  const rec = record(); t.after(rec.stop);
  const m = opened();
  click(m.el.querySelector('.x span'));
  assert.deepEqual(rec.types(), ['ui:close']);
  assert.equal(rec.log[0].target, m.el);
  assert.deepEqual(rec.log[0].detail, { value: null, source: 'user' });
  assert.equal(m.el.open, false);
  m.open();
  keyboardClick(m.el.querySelector('.x'));
  assert.deepEqual(rec.log[1].detail, { value: null, source: 'keyboard' });
  assert.equal(m.el.open, false);
});

test('[data-dialog-close] 只在对话框内生效：对话框已关闭时不派发；点对话框里的普通元素不关闭；对话框之外的 [data-dialog-close] 被忽略', t => {
  const rec = record(); t.after(rec.stop);
  const m = opened();
  click(m.el.querySelector('.msg'));
  click(m.el.querySelector('.field'));
  click(m.el.querySelector('.submit'));
  assert.equal(m.el.open, true);
  m.close();
  click(m.el.querySelector('.x'));
  const { el: stray } = mount('<button data-dialog-close>x</button>');
  click(stray);
  assert.equal(rec.log.length, 0);
});

test('程序化 open / close / update / destroy 全部静默（含原生 close 事件）：页面自己关的对话框不会再收到 ui:close', t => {
  const rec = record(); t.after(rec.stop);
  const nativeClose = [];
  const onNativeClose = event => nativeClose.push(event);
  document.addEventListener('close', onNativeClose, true);
  t.after(() => document.removeEventListener('close', onNativeClose, true));
  const m = mountDialog({ id: 'quiet', label: '静默', children: body });
  m.open();
  assert.equal(m.el.open, true);
  m.update(trusted('<p class="msg">updated</p>'));
  m.close();
  assert.equal(m.el.open, false);
  assert.equal(nativeClose.length, 1, '原生 close 事件确实触发过');
  m.open();
  m.destroy();
  assert.equal(nativeClose.length, 2);
  assert.equal(rec.log.length, 0, '没有任何 ui:* 事件');
  assert.equal(m.el.isConnected, false, 'destroy 把节点移出文档');
});

test('open() / close() 有状态保护：已打开不重复 showModal，已关闭不重复 close；destroy 只在打开时 close', () => {
  const m = mountDialog({ label: 'x' });
  const proto = Object.getPrototypeOf(m.el);
  let shows = 0, closes = 0;
  m.el.showModal = () => { shows += 1; proto.showModal.call(m.el); };
  m.el.close = () => { closes += 1; proto.close.call(m.el); };
  m.close();
  assert.equal(closes, 0);
  m.open();
  m.open();
  assert.equal(shows, 1);
  m.close();
  m.close();
  assert.equal(closes, 1);
  m.destroy();
  assert.equal(closes, 1, '没打开就不 close');
  const second = mountDialog({ label: 'y' });
  let secondCloses = 0;
  const secondProto = Object.getPrototypeOf(second.el);
  second.el.close = () => { secondCloses += 1; secondProto.close.call(second.el); };
  second.open();
  second.destroy();
  assert.equal(secondCloses, 1);
  assert.equal(second.el.isConnected, false);
});

test('update(children)：原地更新内容（morph 复用节点），对话框保持打开，不派发事件', t => {
  const rec = record(); t.after(rec.stop);
  const m = opened();
  const message = m.el.querySelector('.msg');
  m.update(trusted('<p class="msg">changed</p><button class="again" data-dialog-close type="button">好</button>'));
  assert.equal(m.el.querySelector('.msg'), message);
  assert.equal(message.textContent, 'changed');
  assert.ok(m.el.querySelector('.again'));
  assert.equal(m.el.querySelector('.field'), null);
  assert.equal(m.el.open, true);
  assert.equal(rec.log.length, 0);
});

test('Cmd / Ctrl + Enter 点击 [data-dialog-submit]（preventDefault）；单独 Enter、其他组合、禁用的提交按钮、对话框之外都不触发', () => {
  const m = opened();
  const submit = m.el.querySelector('.submit');
  let clicks = 0;
  submit.addEventListener('click', () => { clicks += 1; });
  assert.equal(keydown(m.el.querySelector('.field'), 'Enter', { metaKey: true }).defaultPrevented, true);
  assert.equal(clicks, 1);
  keydown(m.el.querySelector('.field'), 'Enter', { ctrlKey: true });
  assert.equal(clicks, 2);
  assert.equal(keydown(m.el.querySelector('.field'), 'Enter').defaultPrevented, false);
  keydown(m.el.querySelector('.field'), 'a', { metaKey: true });
  keydown(m.el.querySelector('.field'), 'Enter', { shiftKey: true });
  const { el: outside } = mount('<input class="outside">');
  keydown(outside, 'Enter', { metaKey: true });
  assert.equal(clicks, 2);
  submit.disabled = true;
  keydown(m.el.querySelector('.field'), 'Enter', { metaKey: true });
  assert.equal(clicks, 2, '禁用的提交按钮不触发');
});

test('Cmd / Ctrl + Enter 触发的提交 click 是程序化点击（detail 0）；对话框没有提交按钮时不报错', () => {
  const m = opened();
  const details = [];
  m.el.querySelector('.submit').addEventListener('click', event => details.push(event.detail));
  keydown(m.el.querySelector('.field'), 'Enter', { metaKey: true });
  assert.deepEqual(details, [0]);
  const bare = mountDialog({ label: 'bare', children: trusted('<input class="f">') });
  bare.open();
  assert.doesNotThrow(() => keydown(bare.el.querySelector('.f'), 'Enter', { ctrlKey: true }));
});

test('多个对话框互不影响：cancel 只关闭它自己', t => {
  const rec = record(); t.after(rec.stop);
  const first = opened({ id: 'one' }), second = opened({ id: 'two' });
  cancel(first.el);
  assert.equal(first.el.open, false);
  assert.equal(second.el.open, true);
  assert.ok(rec.log.every(item => item.target === first.el));
});

test('标记：dialog class、id、aria-label、data-width（默认 680，非法回落）、className 追加、body 容器；children 只有 trusted 才按标记，裸字符串转义；label 必填', () => {
  const { el } = mount(dialog({ id: 'd1', label: '设置', width: 480, className: 'extra wide', children: trusted('<b class="bold">x</b>') }));
  assert.equal(el.nodeName, 'DIALOG');
  assert.ok(el.classList.contains('dl-dialog'));
  assert.ok(el.classList.contains('extra'));
  assert.ok(el.classList.contains('wide'));
  assert.equal(el.getAttribute('id'), 'd1');
  assert.equal(el.getAttribute('aria-label'), '设置');
  assert.equal(el.getAttribute('data-width'), '480');
  assert.equal(el.open, false);
  assert.ok(el.querySelector('.dl-dialog__body > .bold'));
  assert.equal(mount(dialog({ label: 'x' })).el.getAttribute('data-width'), '680');
  assert.equal(mount(dialog({ label: 'x', width: 'abc' })).el.getAttribute('data-width'), '680');
  assert.equal(mount(dialog({ label: 'x' })).el.hasAttribute('id'), false);
  assert.equal(mount(dialog({ label: 'x' })).el.classList.contains('undefined'), false);
  const escaped = mount(dialog({ label: 'x', children: '<i class="evil">raw</i>' })).el;
  assert.equal(escaped.querySelector('.evil'), null);
  assert.equal(escaped.querySelector('.dl-dialog__body').textContent, '<i class="evil">raw</i>');
  assert.throws(() => dialog({}), TypeError);
  assert.throws(() => mountDialog({}), TypeError);
});

test('mountDialog：挂到 body（或 parent），el 是 <dialog>，默认未打开', () => {
  const m = mountDialog({ label: 'x' });
  assert.equal(m.el.parentNode, document.body);
  assert.equal(m.el.nodeName, 'DIALOG');
  assert.equal(m.el.open, false);
  const { el: holder } = mount('<div class="holder"></div>');
  const inner = mountDialog({ label: 'y', parent: holder });
  assert.equal(inner.el.parentNode, holder);
});
