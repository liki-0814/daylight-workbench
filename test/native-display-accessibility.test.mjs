import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// The Swift shell cannot run here, so the JavaScript it injects is extracted and executed against a stub DOM,
// and the Swift wiring is pinned by source checks.
const swift = await readFile(new URL('../native/DisplayAccessibility.swift', import.meta.url), 'utf8');
const template = /#"""\n([\s\S]*?)\n\s*"""#/.exec(swift)[1];
const script = reduce => template.replace('\\#(reduceTransparency ? "true" : "false")', String(reduce));

function page(initial = false) {
  const attributes = new Map(initial ? [['data-reduce-transparency', '']] : []), events = [];
  const context = { document: { documentElement: { hasAttribute: name => attributes.has(name), setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name) } }, window: { dispatchEvent: event => events.push(event) }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } } };
  return { attributes, events, run: source => vm.runInNewContext(source, context) };
}

test('injected script sets and clears data-reduce-transparency and announces only real changes', () => {
  const p = page();
  p.run(script(false)); assert.equal(p.attributes.has('data-reduce-transparency'), false); assert.equal(p.events.length, 0);
  p.run(script(true)); assert.equal(p.attributes.has('data-reduce-transparency'), true); assert.deepEqual(p.events.map(event => [event.type, event.detail.reduceTransparency]), [['daylight-display-accessibility', true]]);
  p.run(script(true)); assert.equal(p.events.length, 1);
  p.run(script(false)); assert.equal(p.attributes.has('data-reduce-transparency'), false); assert.equal(p.events.at(-1).detail.reduceTransparency, false);
});

test('script tolerates a document without a root element', () => {
  vm.runInNewContext(script(true), { document: { documentElement: null }, window: {}, CustomEvent: class {} });
});

test('shell wiring: observer, user script before first load, packaging list, no message handler', async () => {
  assert.match(swift, /accessibilityDisplayShouldReduceTransparency/); assert.match(swift, /accessibilityDisplayOptionsDidChangeNotification/);
  assert.match(swift, /injectionTime: \.atDocumentStart, forMainFrameOnly: true/); assert.doesNotMatch(swift, /\.add\(self, name:|WKScriptMessageHandler/);
  const main = await readFile(new URL('../native/main.swift', import.meta.url), 'utf8');
  assert.ok(main.indexOf('displayAccessibility.install') < main.indexOf('web = WKWebView'), 'install before the web view exists');
  assert.ok(main.indexOf('displayAccessibility.install') < main.indexOf('web.load('));
  assert.match(main, /displayAccessibility\?\.stop\(\)/);
  assert.match(await readFile(new URL('../scripts/build-native.py', import.meta.url), 'utf8'), /'DisplayAccessibility\.swift'/);
});
