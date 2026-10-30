import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionsController } from '../public/extensions/controller.js';

const memory = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }; };
// 可控的假后端：每次读取返回一个挂起的 Promise，测试里手动放行；honourSignal=false 模拟不理会 abort 的请求。
function fake({ honourSignal = true } = {}) {
  const pending = [];
  const read = signal => new Promise((resolve, reject) => {
    const entry = { resolve, reject, signal }; pending.push(entry);
    if (honourSignal) signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  return { pending, client: { state: read, refresh: read, apply: async () => ({ version: 'v2', changedIds: [], operationId: 'op' }) } };
}
const collect = controller => { const seen = []; controller.subscribe(value => seen.push(value)); return seen; };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const data = version => ({ root: '/Users/li/.agents', version, skills: [] });

test('cancel while loading: no snapshot is written, cancelled is reported, nothing half-loaded', async () => {
  const { client, pending } = fake(), controller = createExtensionsController({ client, storage: memory() }), seen = collect(controller);
  const load = controller.refresh(true);
  assert.equal(seen.at(-1).loading, true); assert.equal(seen.at(-1).cancellable, true);
  assert.equal(controller.cancel(), true); await load;
  const last = seen.at(-1);
  assert.deepEqual([last.loading, last.cancelled, last.cancellable, last.snapshot, !!last.failure], [false, true, false, undefined, false]);
  assert.equal(controller.getSnapshot(), undefined);
  assert.equal(pending.length, 1);
});

test('cancel with existing data keeps that data (same object) and the previous failure state', async () => {
  const { client, pending } = fake(), controller = createExtensionsController({ client, storage: memory() }), seen = collect(controller);
  const first = controller.refresh(); pending[0].resolve(data('v1')); await first;
  const before = controller.getSnapshot(); assert.equal(before.version, 'v1');
  const second = controller.refresh(true); controller.cancel(); await second;
  assert.equal(controller.getSnapshot(), before, 'the very same snapshot object');
  assert.equal(seen.at(-1).cancelled, true); assert.equal(!!seen.at(-1).failure, false);
});

test('a response that arrives after cancel (request ignored abort) is discarded', async () => {
  const { client, pending } = fake({ honourSignal: false }), controller = createExtensionsController({ client, storage: memory() });
  const load = controller.refresh(true); controller.cancel(); pending[0].resolve(data('late')); await load;
  assert.equal(controller.getSnapshot(), undefined);
});

test('a failure before the cancelled load is restored, not replaced by null', async () => {
  const { client, pending } = fake(), controller = createExtensionsController({ client, storage: memory() }), seen = collect(controller);
  const first = controller.refresh(); pending[0].reject(Object.assign(new Error('boom'), { status: 500 })); await first;
  assert.equal(seen.at(-1).failure.message, 'boom');
  const second = controller.refresh(true); controller.cancel(); await second;
  assert.equal(seen.at(-1).failure.message, 'boom'); assert.equal(seen.at(-1).cancelled, true);
});

test('cancel is a no-op when nothing is loading, and after a normal finish', async () => {
  const { client, pending } = fake(), controller = createExtensionsController({ client, storage: memory() });
  assert.equal(controller.cancel(), false);
  const load = controller.refresh(); pending[0].resolve(data('v1')); await load;
  assert.equal(controller.cancel(), false); assert.equal(controller.getSnapshot().version, 'v1');
});

test('the next load clears cancelled; a normal load is never flagged cancelled', async () => {
  const { client, pending } = fake(), controller = createExtensionsController({ client, storage: memory() }), seen = collect(controller);
  const first = controller.refresh(); controller.cancel(); await first; assert.equal(seen.at(-1).cancelled, true);
  const second = controller.refresh(true); assert.equal(seen.at(-1).cancelled, false); pending[1].resolve(data('v2')); await second;
  assert.equal(seen.at(-1).cancelled, false); assert.equal(controller.getSnapshot().version, 'v2');
});

test('the refresh after a submit cannot be cancelled (the server already changed)', async () => {
  const { client, pending } = fake(), controller = createExtensionsController({ client, storage: memory() }), seen = collect(controller);
  const first = controller.refresh(); pending[0].resolve(data('v1')); await first;
  const submitted = controller.submit({ expectedVersion: 'v1', planId: 'p', normalizedAction: { type: 'skill.disable', id: 'a' } });
  await settle();   // apply 已完成，正在 refresh(true)
  assert.equal(seen.at(-1).loading, true); assert.equal(seen.at(-1).cancellable, false, 'no cancel offered');
  assert.equal(controller.cancel(), false);
  pending[1].resolve(data('v2')); await submitted;
  assert.equal(controller.getSnapshot().version, 'v2');
});

test('the 10s timer does not reload while cancelled; setVisible(true) starts a new load', async () => {
  const { client, pending } = fake(), controller = createExtensionsController({ client, storage: memory() });
  const realSetInterval = globalThis.setInterval, hadDocument = 'document' in globalThis; let tick;
  globalThis.setInterval = fn => { tick = fn; return 1; }; if (!hadDocument) globalThis.document = { hidden: false };
  try {
    controller.setVisible(true); assert.equal(pending.length, 1);
    controller.cancel(); await settle();
    tick(); assert.equal(pending.length, 1, 'cancelled: the timer skips');
    controller.setVisible(false); controller.setVisible(true); assert.equal(pending.length, 2, 'coming back starts a fresh load');
  } finally { globalThis.setInterval = realSetInterval; if (!hadDocument) delete globalThis.document; controller.dispose(); }
});
