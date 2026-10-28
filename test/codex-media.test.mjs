import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexProvider } from '../proxy/codex/provider.js';
import { codexMediaIds } from '../proxy/codex/media.js';
import { selectMedia } from '../proxy/shared/media.js';

test('codex forwards every image id and accepts size only after codex is selected', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-codex-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const provider = new CodexProvider({ dataDir: dir, auth: { read: async () => ({ token: 'codex', identity: 'c1', account: 'acct-1' }) }, fetchImpl: async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return Response.json({ data: [{ url: 'https://example.com/out.png', b64_json: 'aaa' }] });
  } });
  assert.deepEqual((await provider.mediaModels()).map(row => row.id), codexMediaIds);
  for (const id of codexMediaIds) {
    const result = await provider.executeMedia({ operation: 'image.generate', body: { model: id, prompt: 'cat', response_format: 'b64_json' }, model: id }, { signal: AbortSignal.timeout(1000), observe() {} });
    assert.equal(result.data[0].b64_json, 'aaa');
    assert.equal(calls.at(-1).body.model, id);
    assert.match(calls.at(-1).url, /^https:\/\/chatgpt\.com\/backend-api\/codex\/images\/generations$/);
  }
  const sized = await provider.executeMedia({ operation: 'image.generate', body: { model: 'gpt-image-2', prompt: 'cat', size: '1024x1024' }, model: 'gpt-image-2' }, { signal: AbortSignal.timeout(1000), observe() {} });
  assert.equal(sized.data[0].url, 'https://example.com/out.png');
  assert.equal(calls.at(-1).body.size, '1024x1024');
  const grok = { mediaModels: async () => [{ id: 'grok-imagine-image-2.0', source: 'grok', status: 'ready', output: 'image' }], executeMedia: async () => { throw Object.assign(new Error('不支持的字段：size'), { status: 400 }); } };
  await assert.rejects(() => selectMedia({ providers: { grok, codex: provider } }, 'grok-imagine-image-2.0').then(selected => grok.executeMedia({ operation: 'image.generate', body: { size: '1024x1024' }, model: selected.id })), { status: 400 });
  const loggedOut = new CodexProvider({ dataDir: dir, auth: { read: async () => { throw Object.assign(new Error('请在 Daylight 中网页登录 Codex'), { status: 401 }); } }, fetchImpl: async () => { throw new Error('network'); } });
  assert.deepEqual(await loggedOut.mediaModels(), []);
});

test('codex image falls back to the local CLI login after the subscription token is rejected', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-codex-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const idToken = `h.${Buffer.from(JSON.stringify({ email: 'same@example.com' })).toString('base64url')}.s`;
  const authFile = path.join(dir, 'auth.json');
  await writeFile(authFile, JSON.stringify({ tokens: { access_token: 'cli-token', account_id: 'acct-cli', id_token: idToken }, OPENAI_API_KEY: 'do-not-send' }));
  const calls = [];
  const provider = new CodexProvider({ dataDir: dir, auth: { read: async () => ({ token: 'daylight', identity: 'c1', account: 'not-a-uuid' }), readSession: async () => ({ id_token: idToken }) }, fetchImpl: async (url, opts) => {
    calls.push({ url, account: opts.headers['chatgpt-account-id'], token: opts.headers.Authorization });
    if (!opts.headers.Authorization.includes('cli-token')) return Response.json({ error: { code: 'no_matching_rule' } }, { status: 401 });
    return Response.json({ data: [{ b64_json: 'abc' }] });
  } });
  provider.imageAuthFile = authFile;
  const result = await provider.executeMedia({ operation: 'image.generate', body: { model: 'gpt-image-2', prompt: 'cat', response_format: 'b64_json' }, model: 'gpt-image-2' }, { signal: AbortSignal.timeout(1000), observe() {} });
  assert.equal(result.data[0].b64_json, 'abc');
  assert.equal(calls.at(-1).account, 'acct-cli');
  assert.equal(calls.at(-1).token, 'Bearer cli-token');
  assert.equal(calls.some(call => call.token.includes('do-not-send')), false);
});
