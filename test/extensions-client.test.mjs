import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionsClient } from '../public/extensions/client.js';

function fake(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); const next = responses.shift(); return { ok: next.status < 400, status: next.status, json: async () => next.body }; };
  return { calls, client: createExtensionsClient({ getToken: () => 'tok', fetchImpl }) };
}

test('probeAll posts ids and expectedVersion to /probes with the token, and returns probes + skipped', async () => {
  const { client, calls } = fake([{ status: 200, body: { probes: [{ id: 'p1', status: 'running' }, { id: 'p2', status: 'queued', startedAt: null }], skipped: [{ id: 'x', reason: 'disabled' }] } }]);
  const value = await client.probeAll(['a', 'b'], 'v1');
  assert.equal(calls[0].url, '/api/extensions/probes'); assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.headers['X-Workbench-Token'], 'tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ids: ['a', 'b'], expectedVersion: 'v1' });
  assert.deepEqual(value.skipped, [{ id: 'x', reason: 'disabled' }]); assert.equal(value.probes[1].status, 'queued');
});
test('409 and 400 keep status and code on the error (the page maps them to wording and decides whether to refresh)', async () => {
  const busy = fake([{ status: 409, body: { error: '检测队列已满，请等待现有检测完成', code: 'EXTENSIONS_PROBE_BUSY' } }]);
  await assert.rejects(busy.client.probeAll(['a'], 'v'), error => error.status === 409 && error.code === 'EXTENSIONS_PROBE_BUSY' && error.message.includes('队列已满'));
  const disabled = fake([{ status: 400, body: { error: '服务已禁用', code: 'EXTENSIONS_IO' } }]);
  await assert.rejects(disabled.client.probeAll(['a'], 'v'), error => error.status === 400);
});
test('cancelProbe is DELETE /probes/:id (queued and running), probe is GET', async () => {
  const { client, calls } = fake([{ status: 200, body: { status: 'cancelled' } }, { status: 200, body: { status: 'running' } }]);
  await client.cancelProbe('a/b'); await client.probe('p1');
  assert.equal(calls[0].init.method, 'DELETE'); assert.equal(calls[0].url, '/api/extensions/probes/a%2Fb');
  assert.equal(calls[1].init.method, 'GET'); assert.equal(calls[1].init.body, undefined);
});
