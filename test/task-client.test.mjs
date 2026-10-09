import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskClient } from '../public/task-client.js';
import { initialState, change } from '../public/model.js';
import { prepareTaskWrite } from '../core/task-write.js';

function fixture() {
  const state = change(initialState(), { type: 'add', id: 'task-a', title: '原名称', notes: '', projectId: null, planDay: '2026-10-06' }, '2026-10-06');
  let record = { state, version: 1, receipts: [] }, previous, snapshot = structuredClone(record), serial = 0, failAfterWrite = false;
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    if (!options.method) return Response.json(record);
    let result;
    if (options.method === 'PUT') {
      if (Number(options.headers['If-Match']) !== record.version) return Response.json({ error: '版本冲突' }, { status: 409 });
      previous = structuredClone(record); record = { ...record, state: JSON.parse(options.body), version: record.version + 1 }; result = record;
    } else {
      const input = JSON.parse(options.body), decision = prepareTaskWrite(record, input, options.body, { previous });
      if (decision.code !== 200) return Response.json(decision.value, { status: decision.code });
      if (decision.state) { previous = structuredClone(record); record = { state: decision.state, version: decision.value.version, receipts: [...record.receipts, decision.receipt] }; }
      result = decision.value;
    }
    if (failAfterWrite) { failAfterWrite = false; throw new Error('response dropped'); }
    return Response.json(result);
  };
  const client = createTaskClient({ getSnapshot: () => snapshot, getToken: () => 'test-token', fetch, uuid: () => 'request-' + ++serial, onCommitted(result) { snapshot = structuredClone(result); } });
  return { client, requests, get snapshot() { return snapshot; }, get record() { return record; }, drop() { failAfterWrite = true; }, external() { record = { ...record, version: record.version + 1 }; snapshot = structuredClone(record); client.invalidateUndo(); } };
}
const reschedule = { type: 'plan.reschedule', id: 'task-a', fromDay: '2026-10-06', toDay: '2026-10-07' };

test('legacy title PUT then calendar action undo restores only the date', async () => {
  const f = fixture(), updated = structuredClone(f.snapshot.state); updated.tasks[0].title = '新名称';
  await f.client.saveState(updated); assert.equal(f.client.getUndo().kind, 'snapshot');
  await f.client.act(reschedule); assert.equal(f.client.getUndo().kind, 'server');
  await f.client.undo();
  assert.equal(f.snapshot.state.tasks[0].title, '新名称'); assert.deepEqual(f.snapshot.state.plans['2026-10-06'], ['task-a']); assert.equal(f.client.getUndo(), null);
});
test('calendar action then legacy PUT undo preserves calendar result', async () => {
  const f = fixture(); await f.client.act(reschedule);
  const updated = structuredClone(f.snapshot.state); updated.tasks[0].title = '新名称'; await f.client.saveState(updated); await f.client.undo();
  assert.equal(f.snapshot.state.tasks[0].title, '原名称'); assert.deepEqual(f.snapshot.state.plans['2026-10-07'], ['task-a']); assert.equal(f.client.getUndo(), null);
});
test('external version invalidation prevents a stale snapshot overwrite', async () => {
  const f = fixture(); await f.client.saveState(f.snapshot.state); f.external(); const writes = f.requests.length;
  await assert.rejects(f.client.undo(), /失效/); assert.equal(f.requests.length, writes);
});
test('unknown action replays the exact body and does not create a second write', async () => {
  const f = fixture(); f.drop(); await assert.rejects(f.client.act(reschedule), /结果待核对/);
  assert.equal(f.client.getUndo(), null); assert.equal(f.record.version, 2);
  await assert.rejects(f.client.saveState(f.snapshot.state), /先重试原请求/);
  await f.client.retry(); assert.equal(f.record.version, 2); assert.equal(f.client.getUndo().version, 2);
  const writes = f.requests.filter(request => request.method === 'POST'); assert.equal(writes[0].body, writes[1].body);
});
test('receipt replay after another write never grants undo over the latest write', async () => {
  const f = fixture(); f.drop(); await assert.rejects(f.client.act(reschedule)); f.external(); await f.client.retry();
  assert.equal(f.client.getUndo(), null); assert.equal(f.record.version, 3);
});
test('unknown legacy PUT reads back confirmed state and clears undo without replay', async () => {
  const f = fixture(); f.drop(); const updated = structuredClone(f.snapshot.state); updated.tasks[0].title = '已保存但丢响应';
  await assert.rejects(f.client.saveState(updated), /结果待核对/);
  assert.equal(f.snapshot.state.tasks[0].title, '已保存但丢响应'); assert.equal(f.client.getUndo(), null); assert.equal(f.client.getPending(), null);
});
test('calendar action during an in-flight PUT is rejected before creating pending state', async () => {
  const f = fixture(), updated = structuredClone(f.snapshot.state); updated.tasks[0].title = 'PUT 保存中';
  const saving = f.client.saveState(updated);
  await assert.rejects(f.client.act(reschedule), /正在保存/); await saving;
  assert.equal(f.client.getPending(), null); assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
  await f.client.act(reschedule); assert.equal(f.snapshot.state.tasks[0].title, 'PUT 保存中'); assert.deepEqual(f.snapshot.state.plans['2026-10-07'], ['task-a']);
});
