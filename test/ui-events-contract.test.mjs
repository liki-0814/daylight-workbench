// ui:* 事件契约 v1（events-contract-v1.md，E-1 … E-10）里能在 core/events.js 这一层断言的部分。
// 本文件刻意隔离：不装假 DOM，不 import 任何组件，只用 Node 自带的 EventTarget / CustomEvent，
// 所以 events.js 的任何改动（动词表、detail 校验、冒泡 / composed、取消语义、sourceOf 判定）都只会在这里红。
// 组件层的 E-4 … E-7、E-10（谁在什么时候派发什么）在 test/ui-contract-components.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit, sourceOf, detailErrors, eventName, VERBS, SOURCES } from '../public/ui/core/events.js';
import { lintDeps } from '../scripts/lint-deps.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const collect = (target, type) => { const seen = []; target.addEventListener(type, event => seen.push(event)); return seen; };
const base = { value: 'v', source: 'user' };

// ---- E-1 名称 -----------------------------------------------------------------------------------------------
test('E-1 正例：change / select / open / close / dismiss 各自派发 ui:<verb>，动词表恰好这五个且不可改', () => {
  assert.deepEqual([...VERBS], ['change', 'select', 'open', 'close', 'dismiss']);
  assert.ok(Object.isFrozen(VERBS) && Object.isFrozen(SOURCES));
  for (const verb of VERBS) {
    const target = new EventTarget(), seen = collect(target, `ui:${verb}`);
    emit(target, verb, base);
    assert.equal(seen.length, 1, `ui:${verb} dispatched once`);
    assert.equal(seen[0].type, `ui:${verb}`);
    assert.equal(eventName(verb), `ui:${verb}`);
  }
});
test('E-1 反例：其他 verb（含带 ui: 前缀、大小写不同、空、null、undefined）抛 TypeError，且什么都不派发', () => {
  for (const bad of ['toggle', 'click', 'ui:change', 'CHANGE', '', null, undefined]) {
    const target = new EventTarget();
    let dispatched = 0;
    for (const type of [`ui:${bad}`, 'ui:change', 'ui:select', 'ui:open', 'ui:close', 'ui:dismiss']) target.addEventListener(type, () => { dispatched += 1; });
    assert.throws(() => emit(target, bad, base), TypeError, `verb ${String(bad)}`);
    assert.throws(() => emit(target, bad, base), /ui event contract/);
    assert.equal(dispatched, 0, `verb ${String(bad)} dispatched nothing`);
  }
});

// ---- E-2 传播 -----------------------------------------------------------------------------------------------
test('E-2 正例：bubbles 与 composed 都是 true，不论事件是否可取消', () => {
  for (const options of [undefined, {}, { cancelable: true }]) {
    const target = new EventTarget(), seen = collect(target, 'ui:dismiss');
    emit(target, 'dismiss', { value: null, source: 'user' }, options);
    assert.equal(seen[0].bubbles, true);
    assert.equal(seen[0].composed, true);
  }
});
test('E-2 正例 / 反例：detail 是拷贝——监听器改 detail 不影响调用方对象，调用方之后改对象也不影响监听器拿到的 detail', () => {
  const original = { value: 'a', previousValue: 'b', source: 'user' };
  const target = new EventTarget(), snapshots = [];
  target.addEventListener('ui:change', event => { snapshots.push(event.detail); event.detail.value = 'mutated-by-listener'; });
  emit(target, 'change', original);
  assert.equal(original.value, 'a', '监听器改 detail 不回写调用方的对象');
  assert.notEqual(snapshots[0], original, 'detail 不是同一个对象');
  original.previousValue = 'changed-after-emit';
  assert.equal(snapshots[0].previousValue, 'b', '调用方之后改对象，不影响已派发事件的 detail');
  const second = [];
  const other = new EventTarget();
  other.addEventListener('ui:change', event => second.push(event.detail));
  emit(other, 'change', { value: 1, previousValue: 0, source: 'keyboard' });
  assert.deepEqual(second[0], { value: 1, previousValue: 0, source: 'keyboard' }, '拷贝的内容与原对象一致');
});

// ---- E-3 detail 形状 ----------------------------------------------------------------------------------------
test('E-3 正例：只含 value / previousValue? / source 且 source ∈ user | keyboard 时没有错误', () => {
  assert.deepEqual(detailErrors({ value: 'x', source: 'user' }), []);
  assert.deepEqual(detailErrors({ value: false, previousValue: true, source: 'keyboard' }), []);
  assert.deepEqual(detailErrors({ value: null, source: 'user' }), []);
  assert.deepEqual([...SOURCES], ['user', 'keyboard']);
});
test('E-3 反例：多余字段、缺 value、source 非法、detail 不是对象——错误信息逐条报出', () => {
  assert.deepEqual(detailErrors({ value: 'x', source: 'user', foo: 1 }), ['unexpected detail.foo']);
  assert.deepEqual(detailErrors({ value: 1, source: 'user', a: 1, b: 2 }), ['unexpected detail.a', 'unexpected detail.b']);
  assert.deepEqual(detailErrors({ source: 'user' }), ['detail.value is required']);
  assert.deepEqual(detailErrors({ value: 1 }), ['detail.source must be one of user | keyboard']);
  for (const source of ['mouse', 'USER', '', null, 1]) assert.deepEqual(detailErrors({ value: 1, source }), ['detail.source must be one of user | keyboard'], `source ${String(source)}`);
  assert.deepEqual(detailErrors({}), ['detail.value is required', 'detail.source must be one of user | keyboard']);
  for (const bad of [null, undefined, [], 'x', 3, true]) assert.deepEqual(detailErrors(bad), ['detail must be an object'], `detail ${JSON.stringify(bad)}`);
});
test('E-3 反例：emit 对非法 detail 抛 TypeError 并且不派发', () => {
  const target = new EventTarget(), seen = collect(target, 'ui:select');
  assert.throws(() => emit(target, 'select', { value: 'x', source: 'user', foo: 1 }), { name: 'TypeError', message: /ui:select detail invalid.*unexpected detail\.foo/ });
  assert.throws(() => emit(target, 'select', { source: 'user' }), { name: 'TypeError', message: /detail\.value is required/ });
  assert.throws(() => emit(target, 'select', { value: 'x', source: 'mouse' }), { name: 'TypeError', message: /detail\.source must be one of/ });
  assert.throws(() => emit(target, 'select', null), TypeError);
  assert.equal(seen.length, 0);
});

// ---- E-4 / E-5 value 与 previousValue 原样透传（组件层的 null / 必带 previousValue 见 ui-contract-components） ----------------
test('E-4 正例：value 的 string / boolean / null（含空串、false）原样到达监听器，不被转换', () => {
  for (const value of ['', 'x', true, false, null]) {
    const target = new EventTarget(), seen = collect(target, 'ui:change');
    emit(target, 'change', { value, previousValue: 'p', source: 'user' });
    assert.ok(Object.is(seen[0].detail.value, value), `value ${String(value)}`);
  }
  for (const verb of ['open', 'close', 'dismiss']) {
    const target = new EventTarget(), seen = collect(target, `ui:${verb}`);
    emit(target, verb, { value: null, source: 'user' });
    assert.equal(seen[0].detail.value, null, `ui:${verb} 的 value 是 null`);
  }
});
test('E-5 正例 / 反例：给了 previousValue 原样带上；没给就没有这个键（emit 不替调用方编造）', () => {
  const target = new EventTarget(), seen = collect(target, 'ui:change');
  emit(target, 'change', { value: true, previousValue: false, source: 'user' });
  emit(target, 'change', { value: true, source: 'user' });
  assert.ok(Object.is(seen[0].detail.previousValue, false));
  assert.equal('previousValue' in seen[1].detail, false);
});

// ---- E-6 可取消 ---------------------------------------------------------------------------------------------
test('E-6 正例：cancelable 事件被 preventDefault → emit 返回 false；没人取消 → true；多个监听器里有一个取消就是 false', () => {
  const target = new EventTarget();
  assert.equal(emit(target, 'change', { value: 1, source: 'user' }, { cancelable: true }), true);
  target.addEventListener('ui:change', () => {});
  target.addEventListener('ui:change', event => event.preventDefault());
  target.addEventListener('ui:change', () => {});
  const seen = collect(target, 'ui:change');
  assert.equal(emit(target, 'change', { value: 1, source: 'user' }, { cancelable: true }), false);
  assert.equal(seen[0].defaultPrevented, true);
  assert.equal(seen[0].cancelable, true);
});
test('E-6 反例：不可取消的事件（默认）preventDefault 无效，emit 仍返回 true，事件本身 cancelable === false', () => {
  const target = new EventTarget(), seen = collect(target, 'ui:open');
  target.addEventListener('ui:open', event => event.preventDefault());
  assert.equal(emit(target, 'open', { value: null, source: 'user' }), true);
  assert.equal(seen[0].cancelable, false);
  assert.equal(seen[0].defaultPrevented, false);
  assert.equal(emit(target, 'open', { value: null, source: 'user' }, { cancelable: false }), true);
});

// ---- E-7 时机（emit 自身）：同步派发，返回时监听器已经执行完 ---------------------------------------------------------
test('E-7 正例：emit 同步——返回前监听器已执行，且 emit 不安排任何延后的二次派发', async () => {
  const target = new EventTarget(), order = [];
  target.addEventListener('ui:select', () => order.push('listener'));
  emit(target, 'select', base);
  order.push('after-emit');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['listener', 'after-emit']);
});
test('E-7 反例：没有调用 emit 就不会有事件（动词表之外的 detail 校验失败也不会残留派发）', () => {
  const target = new EventTarget(), seen = [];
  for (const verb of VERBS) target.addEventListener(`ui:${verb}`, event => seen.push(event));
  assert.throws(() => emit(target, 'change', { value: 1 }), TypeError);
  assert.equal(seen.length, 0);
});

// ---- E-8 source ---------------------------------------------------------------------------------------------
test('E-8 正例：keydown、keyup、detail === 0 的 click 都是 keyboard', () => {
  assert.equal(sourceOf({ type: 'keydown' }), 'keyboard');
  assert.equal(sourceOf({ type: 'keyup' }), 'keyboard');
  assert.equal(sourceOf({ type: 'click', detail: 0 }), 'keyboard');
  assert.equal(sourceOf({ type: 'keydown', key: 'Enter', pointerType: 'mouse' }), 'keyboard');
});
test('E-8 反例：鼠标点击（detail ≥ 1）、缺 detail 的 click、其他事件类型、没有事件，都是 user', () => {
  assert.equal(sourceOf({ type: 'click', detail: 1 }), 'user');
  assert.equal(sourceOf({ type: 'click', detail: 2 }), 'user');
  assert.equal(sourceOf({ type: 'click' }), 'user');
  assert.equal(sourceOf({ type: 'click', detail: '0' }), 'user', 'detail 严格等于数字 0');
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'input', 'change', 'focusin']) assert.equal(sourceOf({ type, detail: 0 }), 'user', `${type} 即使 detail 为 0 也是 user`);
  assert.equal(sourceOf(null), 'user');
  assert.equal(sourceOf(undefined), 'user');
});
test('E-8 不依赖 pointerType（Safari 16 的 click 是没有 pointerType 的 MouseEvent）', () => {
  assert.equal(sourceOf({ type: 'click', detail: 0 }), 'keyboard', 'WebKit：没有 pointerType 的键盘激活');
  assert.equal(sourceOf({ type: 'click', detail: 0, pointerType: '' }), 'keyboard');
  assert.equal(sourceOf({ type: 'click', detail: 0, pointerType: 'mouse' }), 'keyboard', 'pointerType 不改变键盘判定');
  assert.equal(sourceOf({ type: 'click', detail: 1, pointerType: '' }), 'user', '旧判定会把 pointerType 为空的鼠标点击算作键盘');
  assert.equal(sourceOf({ type: 'click', detail: 1 }), 'user', '没有 pointerType 的鼠标点击');
});
test('E-8：sourceOf 的结果总能通过 detail schema', () => {
  for (const event of [{ type: 'keydown' }, { type: 'click', detail: 0 }, { type: 'click', detail: 1 }, null]) {
    assert.ok(SOURCES.includes(sourceOf(event)));
    assert.deepEqual(detailErrors({ value: 1, source: sourceOf(event) }), []);
  }
});

// ---- E-9 派发出口（lint 守卫；这里确认守卫对真实仓库干净、对违规夹具会报） ---------------------------------------------
function fixture(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'events-contract-'));
  for (const [name, text] of Object.entries(files)) { const file = path.join(dir, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); }
  return dir;
}
const emitRules = dir => lintDeps({ root: dir }).violations.filter(item => item.rule === 'emit-only' || item.rule === 'event-verb').map(item => `${item.rule}:${item.file}`);
test('E-9 正例：真实仓库里组件 / pattern 只经 emit() 派发，且动词都在契约内', () => {
  assert.deepEqual(emitRules(root), []);
  const dir = fixture({ 'public/ui/components/chip/chip.js': "import { emit } from '../../core/events.js';\nexport const go = el => emit(el, 'select', { value: 1, source: 'user' });\n" });
  try { assert.deepEqual(emitRules(dir), []); } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('E-9 反例：组件里直接 dispatchEvent / new CustomEvent / new Event，或 emit 契约外的动词，都被守卫拦下', () => {
  const cases = {
    'dispatchEvent': ['export const go = el => el.dispatchEvent(x);\n', ['emit-only']],
    'new CustomEvent': ["export const go = () => new CustomEvent('ui:change');\n", ['emit-only']],
    'new Event': ["export const go = () => new Event('ui:change');\n", ['emit-only']],
    'emit 未知动词': ["import { emit } from '../../core/events.js';\nexport const go = el => emit(el, 'toggle', {});\n", ['event-verb']],
  };
  for (const [label, [text, expected]] of Object.entries(cases)) {
    const dir = fixture({ 'public/ui/components/chip/chip.js': text });
    try { assert.deepEqual(emitRules(dir), expected.map(rule => `${rule}:ui/components/chip/chip.js`), label); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

// ---- E-10 顺序（emit 自身）：监听器按注册顺序同步执行，返回值反映全部监听器之后的结果 ---------------------------------------
test('E-10 正例：同一目标连续 emit 的事件按调用顺序到达（select 先于随后的 change）', () => {
  const target = new EventTarget(), order = [];
  for (const verb of ['select', 'change']) target.addEventListener(`ui:${verb}`, () => order.push(verb));
  emit(target, 'select', base);
  emit(target, 'change', { ...base, previousValue: 'p' });
  assert.deepEqual(order, ['select', 'change']);
});
test('E-10 反例：先注册的监听器取消了事件，后注册的监听器仍然被调用，emit 的返回值反映最终结果', () => {
  const target = new EventTarget(), order = [];
  target.addEventListener('ui:dismiss', event => { order.push('first'); event.preventDefault(); });
  target.addEventListener('ui:dismiss', event => order.push(`second:${event.defaultPrevented}`));
  assert.equal(emit(target, 'dismiss', { value: null, source: 'user' }, { cancelable: true }), false);
  assert.deepEqual(order, ['first', 'second:true']);
});
