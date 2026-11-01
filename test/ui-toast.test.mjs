// toast：区域与标记、自动消失 / 常驻规则、悬停与聚焦暂停、动作与关闭的 ui:select / ui:dismiss、hasToast / dropToastActions。
// 计时器用 fakeTimers 驱动（同步测试里装上、finally 还原，不影响 node:test 自己的计时）。
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, resetBody, fire, click, keyboardClick, record, preventAll, fakeTimers } from './helpers/mini-dom.mjs';

installDom();
const toastModule = await import('../public/ui/components/toast/toast.js');
const { showToast, toastMarkup, hasToast, dropToastActions, sticky, AUTO_DISMISS_MS } = toastModule;
beforeEach(resetBody);

function timed(fn) {
  const timers = fakeTimers();
  try { fn(timers); } finally { timers.restore(); }
}

test('常量与 sticky：错误和警告常驻，其余 tone 不常驻；默认 6.5 秒', () => {
  assert.equal(AUTO_DISMISS_MS, 6500);
  assert.equal(sticky('error'), true);
  assert.equal(sticky('warning'), true);
  for (const tone of ['success', 'info', undefined, '']) assert.equal(sticky(tone), false);
});

test('通知区域：第一次创建 .dl-toasts（role=region、aria-label=通知）挂到 body，之后复用同一个', () => {
  timed(() => {
    assert.equal(document.querySelector('.dl-toasts'), null);
    const a = showToast({ message: 'a' });
    const regionEl = document.querySelector('.dl-toasts');
    assert.equal(regionEl.parentNode, document.body);
    assert.equal(regionEl.getAttribute('role'), 'region');
    assert.equal(regionEl.getAttribute('aria-label'), '通知');
    const b = showToast({ message: 'b' });
    assert.equal(document.querySelectorAll('.dl-toasts').length, 1);
    assert.equal(a.el.parentNode, regionEl);
    assert.equal(b.el.parentNode, regionEl);
    assert.deepEqual(regionEl.querySelectorAll('.dl-toast').length, 2);
  });
});

test('标记：tone class 与 role（error / warning 是 alert，其余 status）、data-ui、文本与关闭按钮；默认 tone 是 info', () => {
  timed(() => {
    for (const [tone, role] of [['error', 'alert'], ['warning', 'alert'], ['success', 'status'], ['info', 'status']]) {
      const { el } = showToast({ message: 'm', tone });
      assert.ok(el.classList.contains('dl-toast'));
      assert.ok(el.classList.contains(`dl-toast--${tone}`), tone);
      assert.equal(el.getAttribute('role'), role, tone);
      assert.equal(el.getAttribute('data-ui'), 'toast');
      assert.equal(el.querySelector('.dl-toast__text').textContent, 'm');
      const close = el.querySelector('.dl-toast__close');
      assert.equal(close.getAttribute('aria-label'), '关闭通知');
      assert.equal(close.getAttribute('type'), 'button');
    }
    const plain = showToast({ message: 'x' }).el;
    assert.ok(plain.classList.contains('dl-toast--info'));
    assert.equal(plain.getAttribute('role'), 'status');
    assert.equal(plain.querySelectorAll('.dl-toast__action').length, 0);
  });
});

test('标记：消息与动作文案被转义，动作带 data-value 且按顺序渲染；message 缺省为空串', () => {
  timed(() => {
    const { el } = showToast({ message: '<b class="evil">x</b>', actions: [{ label: '撤销<i>', value: 'undo' }, { label: '重试', value: 'retry' }] });
    assert.equal(el.querySelector('.evil'), null);
    assert.equal(el.querySelector('.dl-toast__text').textContent, '<b class="evil">x</b>');
    const actions = el.querySelectorAll('.dl-toast__action');
    assert.equal(actions.length, 2);
    assert.equal(actions[0].textContent, '撤销<i>');
    assert.equal(actions[0].dataset.value, 'undo');
    assert.equal(actions[1].dataset.value, 'retry');
    assert.equal(showToast({}).el.querySelector('.dl-toast__text').textContent, '');
    assert.equal(String(toastMarkup({ message: 'm', tone: 'success' })).includes('dl-toast--success'), true);
  });
});

test('success / info：6.5 秒后自动收起；差一毫秒还在', () => {
  timed(({ tick }) => {
    const { el } = showToast({ message: 'm', tone: 'success' });
    tick(AUTO_DISMISS_MS - 1);
    assert.equal(el.isConnected, true);
    tick(1);
    assert.equal(el.isConnected, false);
  });
});

test('自定义 timeout 生效；error / warning / persistent 不会装计时器，时间再长也不消失', () => {
  timed(timers => {
    const quick = showToast({ message: 'q', timeout: 1000 }).el;
    timers.tick(999);
    assert.equal(quick.isConnected, true);
    timers.tick(1);
    assert.equal(quick.isConnected, false);
    assert.equal(timers.pending, 0);
    const held = [showToast({ message: 'e', tone: 'error' }), showToast({ message: 'w', tone: 'warning' }), showToast({ message: 'p', persistent: true })];
    assert.equal(timers.pending, 0);
    timers.tick(AUTO_DISMISS_MS * 10);
    for (const toast of held) assert.equal(toast.el.isConnected, true);
  });
});

test('悬停 / 聚焦暂停：pointerenter、focusin 清掉计时器；pointerleave、focusout 重新计时', () => {
  timed(timers => {
    for (const [enter, leave] of [['pointerenter', 'pointerleave'], ['focusin', 'focusout']]) {
      const { el } = showToast({ message: enter });
      assert.equal(timers.pending, 1);
      fire(el, enter, { bubbles: false });
      assert.equal(timers.pending, 0, enter);
      timers.tick(AUTO_DISMISS_MS * 2);
      assert.equal(el.isConnected, true, `${enter} 期间不消失`);
      fire(el, leave, { bubbles: false });
      assert.equal(timers.pending, 1, leave);
      timers.tick(AUTO_DISMISS_MS - 1);
      assert.equal(el.isConnected, true);
      timers.tick(1);
      assert.equal(el.isConnected, false, `${leave} 后重新计时`);
    }
  });
});

test('离开后的重新计时对常驻通知不生效', () => {
  timed(timers => {
    const { el } = showToast({ message: 'e', tone: 'error' });
    fire(el, 'pointerleave', { bubbles: false });
    fire(el, 'focusout', { bubbles: false });
    assert.equal(timers.pending, 0);
    const persistent = showToast({ message: 'p', persistent: true }).el;
    fire(persistent, 'pointerleave', { bubbles: false });
    assert.equal(timers.pending, 0);
  });
});

test('dismiss()：移除节点并取消计时器；重复调用无副作用；不派发事件', t => {
  timed(timers => {
    const rec = record(); t.after(rec.stop);
    const toast = showToast({ message: 'm' });
    assert.equal(timers.pending, 1);
    toast.dismiss();
    assert.equal(toast.el.isConnected, false);
    assert.equal(timers.pending, 0);
    assert.doesNotThrow(() => toast.dismiss());
    assert.equal(rec.log.length, 0, '程序化 dismiss 静默（E-7）');
  });
});

test('点动作：在节点还在文档里时派发不可取消的 ui:select {value, source:user}，随后移除通知；只点中的那个动作的 value', () => {
  timed(() => {
    const rec = record();
    let probe = null;
    try {
      const { el } = showToast({ message: 'm', actions: [{ label: '撤销', value: 'undo' }, { label: '重试', value: 'retry' }] });
      let connectedDuring = null;
      probe = () => { connectedDuring = el.isConnected; };
      document.addEventListener('ui:select', probe);
      click(el.querySelectorAll('.dl-toast__action')[1]);
      assert.deepEqual(rec.types(), ['ui:select']);
      assert.equal(rec.log[0].target, el);
      assert.equal(rec.log[0].cancelable, false);
      assert.deepEqual(rec.log[0].detail, { value: 'retry', source: 'user' });
      assert.equal(connectedDuring, true, 'E-10：先派发事件，再移除节点');
      assert.equal(el.isConnected, false);
    } finally {
      if (probe) document.removeEventListener('ui:select', probe);
      rec.stop();
    }
  });
});

test('点动作：键盘激活（click.detail 0）的 source 是 keyboard', t => {
  timed(() => {
    const rec = record(); t.after(rec.stop);
    const { el } = showToast({ message: 'm', actions: [{ label: '撤销', value: 'undo' }] });
    keyboardClick(el.querySelector('.dl-toast__action'));
    assert.deepEqual(rec.log[0].detail, { value: 'undo', source: 'keyboard' });
  });
});

test('点动作：即使 ui:select 被 preventDefault（本来就不可取消），通知照样移除', t => {
  timed(() => {
    const rec = record(); t.after(rec.stop);
    const off = preventAll('ui:select'); t.after(off);
    const { el } = showToast({ message: 'm', actions: [{ label: '撤销', value: 'undo' }] });
    click(el.querySelector('.dl-toast__action'));
    assert.equal(el.isConnected, false);
  });
});

test('点 ×：派发可取消的 ui:dismiss {value:null, source}，没被取消就移除；键盘 source 是 keyboard', t => {
  timed(() => {
    const rec = record(); t.after(rec.stop);
    const { el } = showToast({ message: 'm' });
    click(el.querySelector('.dl-toast__close'));
    assert.deepEqual(rec.types(), ['ui:dismiss']);
    assert.equal(rec.log[0].target, el);
    assert.equal(rec.log[0].cancelable, true);
    assert.deepEqual(rec.log[0].detail, { value: null, source: 'user' });
    assert.equal(el.isConnected, false);
    const second = showToast({ message: 'n' }).el;
    keyboardClick(second.querySelector('.dl-toast__close'));
    assert.deepEqual(rec.log[1].detail, { value: null, source: 'keyboard' });
  });
});

test('点 × 时页面取消 ui:dismiss：通知留着', t => {
  timed(() => {
    const rec = record(); t.after(rec.stop);
    const off = preventAll('ui:dismiss'); t.after(off);
    const { el } = showToast({ message: 'e', tone: 'error' });
    click(el.querySelector('.dl-toast__close'));
    assert.deepEqual(rec.types(), ['ui:dismiss']);
    assert.equal(el.isConnected, true);
  });
});

test('点通知的其他位置（文本）、点通知之外：不派发事件，通知不动', t => {
  timed(() => {
    const rec = record(); t.after(rec.stop);
    const { el } = showToast({ message: 'm', actions: [{ label: '撤销', value: 'undo' }] });
    click(el.querySelector('.dl-toast__text'));
    click(el);
    click(document.querySelector('.dl-toasts'));
    click(document.body);
    assert.equal(rec.log.length, 0);
    assert.equal(el.isConnected, true);
  });
});

test('多条通知互不影响：点其中一条的动作只移除那一条', t => {
  timed(() => {
    const rec = record(); t.after(rec.stop);
    const a = showToast({ message: 'a', actions: [{ label: 'x', value: 'one' }] }).el;
    const b = showToast({ message: 'b', actions: [{ label: 'y', value: 'two' }] }).el;
    click(b.querySelector('.dl-toast__action'));
    assert.equal(a.isConnected, true);
    assert.equal(b.isConnected, false);
    assert.equal(rec.log[0].target, b);
  });
});

test('hasToast：消息与 tone 都相同才算有；默认的 info 要显式传；移除后不再有', () => {
  timed(() => {
    const { dismiss } = showToast({ message: '已保存', tone: 'success' });
    assert.equal(hasToast({ message: '已保存', tone: 'success' }), true);
    assert.equal(hasToast({ message: '已保存', tone: 'error' }), false);
    assert.equal(hasToast({ message: '别的', tone: 'success' }), false);
    assert.equal(hasToast({ message: '已保', tone: 'success' }), false);
    showToast({ message: 'hi' });
    assert.equal(hasToast({ message: 'hi', tone: 'info' }), true);
    dismiss();
    assert.equal(hasToast({ message: '已保存', tone: 'success' }), false);
  });
});

test('hasToast：数字消息按字符串比较', () => {
  timed(() => {
    showToast({ message: 42 });
    assert.equal(hasToast({ message: 42, tone: 'info' }), true);
    assert.equal(hasToast({ message: '42', tone: 'info' }), true);
  });
});

test('dropToastActions(value)：只移除 value 相同的动作按钮，通知本身和其他动作保留', () => {
  timed(() => {
    const first = showToast({ message: 'a', actions: [{ label: '撤销', value: 'undo' }, { label: '重试', value: 'retry' }] }).el;
    const second = showToast({ message: 'b', actions: [{ label: '撤销', value: 'undo' }] }).el;
    dropToastActions('undo');
    assert.equal(first.querySelectorAll('.dl-toast__action').length, 1);
    assert.equal(first.querySelector('.dl-toast__action').dataset.value, 'retry');
    assert.equal(second.querySelectorAll('.dl-toast__action').length, 0);
    assert.equal(first.isConnected, true);
    assert.equal(second.isConnected, true);
    dropToastActions('nothing');
    assert.equal(first.querySelectorAll('.dl-toast__action').length, 1);
  });
});
