import test from 'node:test';
import assert from 'node:assert/strict';
import { modelGroups, modelHeading, onTabReturn, pinToggle, regroupPins } from '../public/components/model-row.js';

const models = [{ id: 'a', enabled: true }, { id: 'b', enabled: false }, { id: 'c', enabled: true }];
const row = (m, i, state) => `<i data-id="${m.id}" data-pending="${state.pending}"></i>`;
const order = html => [...html.matchAll(/data-id="(\w+)"/g)].map(x => x[1]);

test('unpinned rows are grouped by enabled state', () => {
  const html = modelGroups(models, row);
  assert.deepEqual(order(html), ['a', 'c', 'b']);
  assert.match(html, /<details class="proxy-disabled-models" >/);
});

test('a pinned row keeps its previous group until the pin is cleared', () => {
  const pins = new Map();
  pinToggle(pins, 'c', true); // user disabled c: it was enabled before the click
  const toggled = models.map(m => (m.id === 'c' ? { ...m, enabled: false } : m));
  assert.deepEqual(order(modelGroups(toggled, row, { pins })), ['a', 'c', 'b']);
  assert.match(modelGroups(toggled, row, { pins }), /data-id="c" data-pending="true"/);
  pins.clear();
  assert.deepEqual(order(modelGroups(toggled, row, { pins })), ['a', 'b', 'c']);
});

test('toggling a pinned row back removes the pin (net no change)', () => {
  const pins = new Map();
  pinToggle(pins, 'a', true);
  pinToggle(pins, 'a', false);
  assert.equal(pins.size, 0);
});

test('pending heading names the new state and exposes an undo button', () => {
  const html = modelHeading({ id: 'a' }, '<input type="checkbox">', { pending: true, selected: false });
  assert.match(html, /已停用/);
  assert.match(html, /class="proxy-undo"/);
  assert.doesNotMatch(modelHeading({ id: 'a' }, ''), /proxy-undo/);
});

test('regroupPins clears every pin, repaints once, and reports whether anything moved', () => {
  const pins = new Map([['a', true]]);
  let paints = 0;
  assert.equal(regroupPins(pins, () => paints++), true);
  assert.equal(pins.size, 0);
  assert.equal(paints, 1);
  assert.equal(regroupPins(pins, () => paints++), false);
  assert.equal(paints, 1);
});

test('onTabReturn fires only when the browser tab becomes visible and can be unsubscribed', () => {
  const doc = Object.assign(new EventTarget(), { hidden: true });
  let calls = 0;
  const stop = onTabReturn(() => calls++, doc);
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 0);
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 1);
  stop();
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 1);
});

// Drives the real media list component against a minimal DOM stand-in.
function mediaHarness(initial) {
  const doc = Object.assign(new EventTarget(), { hidden: false, activeElement: null, scrollingElement: { scrollTop: 0 }, documentElement: { scrollTop: 0 } });
  globalThis.document = doc;
  globalThis.getComputedStyle = () => ({ overflowY: 'visible' });
  globalThis.CSS = { escape: String };
  const attrs = () => ({ setAttribute() {}, querySelector: () => ({ setAttribute() {} }) });
  const button = Object.assign(attrs(), { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
  const message = { textContent: '' };
  const list = Object.assign(attrs(), { innerHTML: '', parentElement: null, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, querySelector: () => null, querySelectorAll: () => [], replaceChildren() {} });
  const root = { hidden: true, innerHTML: '', addEventListener() {}, querySelector: selector => ({ '[data-refresh-media]': button, '[data-media-list]': list, '[data-media-message]': message })[selector] };
  doc.createElement = () => root;
  return { doc, list, button, root, rows: () => [...list.innerHTML.matchAll(/data-media-model="([^"]+)"/g)].map(m => m[1]), html: () => list.innerHTML,
    toggle: id => list.listeners.change({ target: { closest: () => ({ dataset: { mediaModel: id }, checked: false, isConnected: false, disabled: false }) } }) };
}

test('media list defers regrouping after a toggle until page entry, refresh or tab return', async () => {
  const { createMediaModels } = await import('../public/components/media-models.js');
  const base = [{ id: 'a', output: 'image', status: 'ready' }, { id: 'b', output: 'image', status: 'ready' }, { id: 'c', output: 'video', status: 'ready' }];
  let server = base.map(m => ({ ...m }));
  const make = () => mediaHarness();
  for (const reentry of ['page entry', 'refresh', 'tab return']) {
    server = base.map(m => ({ ...m }));
    const h = make();
    const component = createMediaModels({ source: 'x', load: async () => ({ models: server.map(m => ({ ...m })) }), save: async ({ id, value }) => { server = server.map(m => (m.id === id ? { ...m, enabled: value } : m)); return { models: server.map(m => ({ ...m })) }; } });
    component.setVisible(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.rows(), ['a', 'b', 'c'], `${reentry}: initial order`);
    await h.toggle('b');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.rows(), ['a', 'b', 'c'], `${reentry}: toggled row does not move`);
    assert.match(h.html(), /已停用/);
    assert.match(h.html(), /proxy-undo/);
    assert.doesNotMatch(h.html(), /proxy-disabled-models/);
    // A passive reload (e.g. the source revision bumps after our own save) must not regroup.
    await component.refresh();
    assert.deepEqual(h.rows(), ['a', 'b', 'c'], `${reentry}: passive reload keeps the row in place`);
    assert.match(h.html(), /proxy-undo/);
    if (reentry === 'page entry') { component.setVisible(false); component.setVisible(true); }
    else if (reentry === 'refresh') h.button.listeners.click();
    else { h.doc.hidden = true; h.doc.dispatchEvent(new Event('visibilitychange')); assert.deepEqual(h.rows(), ['a', 'b', 'c'], 'hiding the tab alone does not regroup'); h.doc.hidden = false; h.doc.dispatchEvent(new Event('visibilitychange')); }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.rows(), ['a', 'c', 'b'], `${reentry}: row regrouped under 未启用`);
    assert.match(h.html(), /proxy-disabled-models/);
    assert.doesNotMatch(h.html(), /proxy-undo/);
    component.dispose();
  }
});
