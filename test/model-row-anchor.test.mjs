import test from 'node:test';
import assert from 'node:assert/strict';
import { repaintKeepingControl } from '../public/components/model-row.js';

function stage({ overflowY = 'visible', scrollable = false } = {}) {
  const scroller = { parentElement: null, scrollTop: 0, scrollHeight: scrollable ? 2000 : 100, clientHeight: 500, style: { overflowY } };
  const root = { scrollTop: 0 };
  const list = { parentElement: scroller };
  let focused = null;
  const control = (top) => ({ parentElement: list, top, getBoundingClientRect() { return { top: this.top }; }, focus(options) { focused = { control: this, options }; } });
  globalThis.document = { activeElement: null, scrollingElement: root, documentElement: root };
  globalThis.getComputedStyle = node => ({ overflowY: node.style?.overflowY || 'visible' });
  return { scroller, root, list, control, focused: () => focused };
}

test('repaintKeepingControl compensates the scroll position when the toggled row moves', () => {
  const s = stage({ overflowY: 'auto', scrollable: true });
  const before = s.control(300), after = s.control(900);
  s.list.querySelector = () => current;
  let current = before;
  document.activeElement = before;
  repaintKeepingControl(s.list, '[data-x]', () => { current = after; });
  assert.equal(s.scroller.scrollTop, 600);
  assert.equal(s.root.scrollTop, 0);
  assert.equal(s.focused().control, after);
  assert.deepEqual(s.focused().options, { preventScroll: true });
});

test('repaintKeepingControl scrolls the document when no ancestor scrolls and restores focus on request', () => {
  const s = stage();
  const before = s.control(500), after = s.control(120);
  let current = before;
  s.list.querySelector = () => current;
  repaintKeepingControl(s.list, '[data-x]', () => { current = after; }, { focus: true });
  assert.equal(s.root.scrollTop, -380);
  assert.equal(s.focused().control, after);
});

test('repaintKeepingControl does not steal focus or scroll when nothing moved', () => {
  const s = stage();
  const before = s.control(200), after = s.control(200);
  let current = before;
  s.list.querySelector = () => current;
  repaintKeepingControl(s.list, '[data-x]', () => { current = after; });
  assert.equal(s.root.scrollTop, 0);
  assert.equal(s.focused(), null);
});

test('repaintKeepingControl still repaints when the control is missing', () => {
  const s = stage();
  let painted = 0;
  s.list.querySelector = () => null;
  repaintKeepingControl(s.list, '[data-x]', () => { painted++; });
  assert.equal(painted, 1);
});
