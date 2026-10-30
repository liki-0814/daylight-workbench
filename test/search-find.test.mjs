import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 没有 DOM 库：用最小的假节点覆盖 focusVisibleSearchField 的判定；真实布局由 e2e（ext-pr6-find）验证。
const input = ({ shown = true, hiddenAncestor = false, disabled = false, name = 'x' } = {}) => ({
  name, disabled, isConnected: true, calls: [],
  closest(selector) { return hiddenAncestor && /hidden|inert/.test(selector) ? {} : null; },
  getClientRects() { return shown ? [{}] : []; },
  focus() { this.calls.push('focus'); }, select() { this.calls.push('select'); },
});
const scope = inputs => ({ querySelectorAll: () => inputs, querySelector: () => null });
globalThis.getComputedStyle = () => ({ visibility: 'visible' });
const events = new Map();
const captures = new Map();
const fakeWindow = { addEventListener: (name, fn, capture) => { events.set(name, fn); captures.set(name, capture); }, removeEventListener: name => events.delete(name) };
const { focusVisibleSearchField, installFindListener, findEventName } = await import('../public/components/search-field.js');

test('focuses and selects the first visible search field in DOM order', () => {
  const [hidden, covered, off, first, second] = [input({ shown: false }), input({ hiddenAncestor: true }), input({ disabled: true }), input({ name: 'first' }), input({ name: 'second' })];
  assert.equal(focusVisibleSearchField(scope([hidden, covered, off, first, second])), true);
  assert.deepEqual(first.calls, ['focus', 'select']);
  for (const skipped of [hidden, covered, off, second]) assert.deepEqual(skipped.calls, [], skipped.name);
});

test('no visible search field: returns false and touches nothing', () => {
  const [a, b] = [input({ shown: false }), input({ hiddenAncestor: true })];
  assert.equal(focusVisibleSearchField(scope([a, b])), false);
  assert.equal(focusVisibleSearchField(scope([])), false);
  assert.deepEqual([a.calls, b.calls], [[], []]);
  assert.equal(focusVisibleSearchField(null), false);
});

test('an open dialog restricts the search to the dialog (the page behind is inert)', () => {
  const behind = input({ name: 'behind' }), inside = input({ name: 'inside' });
  const dialog = scope([]);
  globalThis.document = { querySelector: selector => selector === 'dialog[open]' ? dialog : null };
  try {
    assert.equal(focusVisibleSearchField(scope([behind])), false, 'dialog has no search box: do nothing');
    assert.deepEqual(behind.calls, []);
    dialog.querySelectorAll = () => [inside];
    assert.equal(focusVisibleSearchField(scope([behind])), true);
    assert.deepEqual([behind.calls, inside.calls], [[], ['focus', 'select']]);
  } finally { delete globalThis.document; }
});

test('the daylight-find listener is installed once, handles the event, and can be removed', () => {
  assert.equal(findEventName, 'daylight-find');
  const remove = installFindListener(fakeWindow);
  assert.equal(events.has('daylight-find'), true);
  assert.equal(captures.get('daylight-find'), true, 'capture phase on window: also sees events dispatched on document that do not bubble');
  assert.equal(installFindListener(fakeWindow), remove, 'second install is a no-op');
  remove(); assert.equal(events.has('daylight-find'), false);
  assert.equal(installFindListener(fakeWindow) === remove, false, 'can be installed again after removal'); events.clear();
  assert.doesNotThrow(() => installFindListener(undefined));
});

test('page.js ⌘F shares the same function; the extension page has no private copy of the focus logic', () => {
  const page = readFileSync(new URL('../public/extensions/page.js', import.meta.url), 'utf8');
  assert.match(page, /focusVisibleSearchField/);
  assert.doesNotMatch(page, /\$\('\.extension-search input'\);\s*input\.focus\(\); input\.select\(\)/);
});
