import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexProvider } from '../proxy/codex/provider.js';
import { GrokProvider } from '../proxy/grok/provider.js';
import { AgyProvider } from '../proxy/agy/provider.js';
import { parseModels as parseCodexModels } from '../proxy/codex/models.js';
import { parseModels as parseGrokModels } from '../proxy/grok/models.js';
import { discoverModels } from '../proxy/agy/models.js';
import { CODEX_IMAGE_CATALOG, codexImageId, codexMediaIds } from '../proxy/codex/media.js';
import { selectMedia } from '../proxy/shared/media.js';
import { agyMediaEntries, parseOpenAIImageModels, parseXaiMediaModels } from '../proxy/shared/published-models.js';

const enumSource = `
ImageModel: TypeAlias = Literal[
    "gpt-image-2.6-flare",
    "gpt-image-2.7-sunburst",
    "gpt-image-1",
    "dall-e-3",
    "gpt-image-2.5-flare",
]
"""Deprecated values:

- "gpt-image-1": shut down. Use "gpt-image-2.5-flare" instead.
- "dall-e-3": retired.
"""
`;

test('openai image enum keeps current models and drops only the deprecated ids', () => {
  assert.deepEqual(parseOpenAIImageModels(enumSource), ['gpt-image-2.6-flare', 'gpt-image-2.7-sunburst', 'gpt-image-2.5-flare']);
  assert.throws(() => parseOpenAIImageModels('{"data":[{"id":"gpt-image-2.6-flare"}]}'));
});

test('codex image catalog follows the enum, refreshes, and still forwards an id the page has not listed', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-codex-catalog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let fetches = 0;
  const calls = [];
  const provider = new CodexProvider({ dataDir: dir, auth: { read: async () => ({ token: 'codex', identity: 'c1', account: 'acct' }) }, fetchImpl: async (url, opts) => {
    if (url === CODEX_IMAGE_CATALOG) { fetches += 1; return new Response(enumSource); }
    calls.push(JSON.parse(opts.body));
    return Response.json({ data: [{ b64_json: 'abc' }] });
  } });
  assert.deepEqual((await provider.mediaModels()).map(row => row.id), ['gpt-image-2.6-flare', 'gpt-image-2.7-sunburst', 'gpt-image-2.5-flare']);
  await provider.mediaModels();
  assert.equal(fetches, 1);
  await provider.mediaModels({ refresh: true });
  assert.equal(fetches, 2);
  const offline = new CodexProvider({ dataDir: dir, auth: { read: async () => ({ token: 'codex', identity: 'c1' }) }, fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual((await offline.mediaModels()).map(row => row.id), codexMediaIds);
  await provider.executeMedia({ operation: 'image.generate', body: { model: 'gpt-image-2.6-flare', prompt: 'cat', quality: 'xhigh', background: 'transparent' }, model: 'gpt-image-2.6-flare' }, { signal: AbortSignal.timeout(1000), observe() {} });
  assert.equal(calls.at(-1).quality, 'xhigh');
  assert.equal(calls.at(-1).background, 'transparent');
  await assert.rejects(() => provider.executeMedia({ operation: 'image.generate', body: { model: 'gpt-image-2', prompt: 'cat', background: 'transparent' }, model: 'gpt-image-2' }, { signal: AbortSignal.timeout(1000), observe() {} }), { status: 400 });
  const selected = await selectMedia({ providers: { codex: { mediaModels: async () => [], mediaOwns: codexImageId, mediaLoginError: async () => null } } }, 'gpt-image-2.7-flare');
  assert.equal(selected.source, 'codex');
  await assert.rejects(() => selectMedia({ providers: {} }, 'gpt-image-2.6'), error => /gpt-image-2\.6-flare/.test(error.message) && /gpt-image-2\.6-sunburst/.test(error.message));
  await assert.rejects(() => selectMedia({ providers: { codex: provider } }, 'gpt-image-1'), error => /关闭/.test(error.message));
  assert.deepEqual(parseCodexModels({ models: [{ slug: 'gpt-image-2.6-flare', visibility: 'list' }, { slug: 'gpt-6', visibility: 'list' }] }).map(model => model.id), ['gpt-6']);
});

test('grok media catalog comes from api.x.ai and a newer video id uses the 1.5 limits', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-grok-catalog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sent = [];
  const provider = new GrokProvider({ dataDir: dir, auth: { credential: async () => ({ token: 't', identity: 'user-1', version: '1' }) }, fetchImpl: async (url, opts) => {
    if (url === 'https://api.x.ai/v1/models') return Response.json({ data: [{ id: 'grok-4.7', api_backend: 'responses' }, { id: 'grok-imagine-image-3.0' }, { id: 'grok-imagine-video-1.6' }, { id: 'grok-imagine-image-retired', hidden: true }] });
    sent.push(JSON.parse(opts.body));
    return Response.json({ request_id: 'req-1', data: [{ url: 'https://imgen.x.ai/a.jpeg' }] });
  } });
  assert.deepEqual((await provider.mediaModels()).map(row => row.id), ['grok-imagine-image-3.0', 'grok-imagine-video-1.6']);
  assert.deepEqual(parseXaiMediaModels({ data: [{ id: 'grok-imagine-image-3.0' }, { id: 'grok-4.7' }] }), ['grok-imagine-image-3.0']);
  assert.deepEqual(parseGrokModels({ data: [{ id: 'grok-imagine-image-3.0', api_backend: 'responses' }, { id: 'grok-4.7', api_backend: 'responses' }] }).map(model => model.id), ['grok-4.7']);
  const refs = Array.from({ length: 14 }, (_, index) => ({ url: `https://example.com/${index}.png` }));
  await provider.executeMedia({ operation: 'video.submit', body: { model: 'grok-imagine-video-1.6', prompt: 'wave', reference_images: refs }, model: 'grok-imagine-video-1.6' }, { signal: AbortSignal.timeout(1000), observe() {}, jobs: { create: async input => ({ id: 'vid_1', ...input }) } });
  assert.equal(sent.at(-1).reference_images.length, 14);
  await assert.rejects(() => provider.executeMedia({ operation: 'video.submit', body: { model: 'grok-imagine-video-1.6-lite', prompt: 'wave', reference_images: refs.slice(0, 1) }, model: 'grok-imagine-video-1.6-lite' }, { signal: AbortSignal.timeout(1000), observe() {}, jobs: { create: async () => ({}) } }), { status: 400 });
});

test('agy image rows come from the account catalog and stay out of chat', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-agy-catalog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalog = { models: { 'gemini-3.2-flash-image': { displayName: 'Newer Image' }, 'nano-banana': { displayName: 'Banana', outputModalities: ['IMAGE'] }, 'gemini-3.8-flash': { displayName: 'Flash', supportsImages: true } }, agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.2-flash-image', 'nano-banana', 'gemini-3.8-flash'] }] }] };
  assert.deepEqual(agyMediaEntries(catalog).map(row => row.id), ['gemini-3.2-flash-image', 'nano-banana']);
  assert.deepEqual(discoverModels(catalog).map(model => model.id), ['gemini-3.8-flash']);
  const provider = new AgyProvider({ dataDir: dir, auth: { identity: 'agy', epoch: 1, token: async () => 'token' }, fetchImpl: async () => { throw new Error('unused'); } });
  provider.catalog = async () => catalog;
  assert.deepEqual((await provider.mediaModels()).map(row => [row.id, row.displayName]), [['gemini-3.2-flash-image', 'Newer Image'], ['nano-banana', 'Banana']]);
  const selected = await selectMedia({ providers: { agy: provider } }, 'gemini-4-flash-image');
  assert.equal(selected.source, 'agy');
});
