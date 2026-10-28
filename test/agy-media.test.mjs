import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgyProvider } from '../proxy/agy/provider.js';
import { agyMediaIds } from '../proxy/agy/media.js';

test('agy forwards every gemini image id and defaults to bytes', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-agy-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const provider = new AgyProvider({ dataDir: dir, auth: { identity: 'agy-user', epoch: 1, token: async () => 'agy-token' }, fetchImpl: async (url, opts) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : undefined });
    return Response.json({ response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'abc' } }] } }] } });
  } });
  provider.catalog = async () => ({ project: 'project-1' });
  assert.deepEqual((await provider.mediaModels()).map(row => row.id), agyMediaIds);
  for (const id of agyMediaIds) {
    const result = await provider.executeMedia({ operation: 'image.generate', body: { model: id, prompt: 'lake' }, model: id }, { signal: AbortSignal.timeout(1000), observe() {} });
    assert.equal(result.data[0].b64_json, 'abc');
    assert.equal(calls.at(-1).body.model, id);
    assert.equal(calls.at(-1).url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent');
    assert.deepEqual(calls.at(-1).body.request.generationConfig.responseModalities, ['IMAGE']);
  }
  await assert.rejects(() => provider.executeMedia({ operation: 'image.generate', body: { model: agyMediaIds[0], prompt: 'lake', response_format: 'url' }, model: agyMediaIds[0] }, { signal: AbortSignal.timeout(1000), observe() {} }), { code: 'response_format_unavailable' });
  const loggedOut = new AgyProvider({ dataDir: dir, auth: { token: async () => { throw new Error('logged out'); } }, fetchImpl: async () => { throw new Error('network'); } });
  assert.deepEqual(await loggedOut.mediaModels(), []);
});
