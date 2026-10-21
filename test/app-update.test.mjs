import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { interpretRelease, latestReleaseURL, compareVersions } from '../core/app-update.js';
import { resolveRoute } from '../core/contracts.js';
import { appUpdateMarkup } from '../public/app-update.js';
import { createWorkbench } from '../server.mjs';

const page = 'https://github.com/liki-0814/daylight-workbench/releases/tag/v0.9.0';
const arm64 = 'https://github.com/liki-0814/daylight-workbench/releases/download/v0.9.0/Daylight-0.9.0-arm64.dmg';
const release = (tag, extra = {}) => ({
  tag_name: tag, name: tag.replace(/^v/, ''), draft: false, prerelease: false,
  html_url: `https://github.com/liki-0814/daylight-workbench/releases/tag/${tag}`,
  published_at: '2026-10-19T00:00:00Z', body: '说明', assets: [], ...extra,
});

test('release versions compare numerically and only accept three-part versions', () => {
  assert.equal(compareVersions('0.9.0', 'v0.10.0'), -1);
  assert.equal(compareVersions('v0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('0.5.1', '0.5.1'), 0);
  assert.equal(compareVersions('0.5', '0.5.1'), null);
  assert.equal(compareVersions('0.5.1-beta', '0.5.2'), null);
});

test('GitHub release payloads become an update report', () => {
  assert.equal(latestReleaseURL(), 'https://api.github.com/repos/liki-0814/daylight-workbench/releases/latest');
  const newer = interpretRelease('0.5.1', 200, release('v0.9.0', {
    body: '修复 <script>  登录\n\n' + '注'.repeat(300),
    assets: [
      { name: 'Daylight-0.9.0.dmg', browser_download_url: 'https://github.com/liki-0814/daylight-workbench/releases/download/v0.9.0/Daylight-0.9.0.dmg', size: 4 },
      { name: 'Daylight-0.9.0-arm64.dmg', browser_download_url: arm64, size: 8 },
      { name: 'Daylight-0.9.0-arm64.dmg', browser_download_url: 'https://evil.example/Daylight.dmg', size: 1 },
      { name: 'notes.txt', browser_download_url: page, size: 1 },
    ],
  }));
  assert.equal(newer.status, 'available');
  assert.equal(newer.latest.asset.url, arm64);
  assert.equal(newer.latest.asset.size, 8);
  assert.equal(newer.latest.notes.length, 280);
  assert.equal(newer.latest.notes.endsWith('…'), true);
  assert.equal(interpretRelease('0.9.0', 200, release('v0.9.0')).status, 'current');
  assert.equal(interpretRelease('0.10.0', 200, release('v0.9.0')).status, 'current');
  assert.equal(interpretRelease('0.5.1', 404, null).status, 'none');
  assert.equal(interpretRelease('0.5.1', 403, { message: 'rate limit' }).error, 'GitHub 发布接口暂时受限，请稍后再试');
  assert.equal(interpretRelease('0.5.1', 429, {}).status, 'unavailable');
  assert.equal(interpretRelease('0.5.1', 401, {}).error, 'GitHub 拒绝了未登录的发布读取');
  assert.equal(interpretRelease('0.5.1', 500, {}).status, 'unavailable');
  assert.equal(interpretRelease('0.5.1', 200, release('v0.9.0', { draft: true })).status, 'none');
  assert.equal(interpretRelease('0.5.1', 200, release('v0.9.0', { prerelease: true })).status, 'none');
  const odd = interpretRelease('0.5.1', 200, release('nightly', { html_url: 'https://example.com/release' }));
  assert.equal(odd.status, 'unrecognized');
  assert.equal(odd.latest.htmlUrl, undefined);
  assert.equal(interpretRelease('0.5.1', 200, release('v0.9.0', { html_url: 'https://user:pass@github.com/liki-0814/daylight-workbench/releases/tag/v0.9.0' })).latest.htmlUrl, undefined);
  assert.equal(interpretRelease('0.5.1', 200, release('v0.9.0', { html_url: 'https://github.com/liki-0814/daylight-workbench/releases/../secret' })).latest.htmlUrl, undefined);
  assert.equal(interpretRelease('0.5.1', 200, release('v0.9.0', { html_url: 'https://github.com/liki-0814/daylight-workbench/releases/%2e%2e/secret' })).latest.htmlUrl, undefined);
  const savedURL = globalThis.URL;
  globalThis.URL = function URL() { throw new Error('JavaScriptCore has no URL'); };
  try {
    const linked = interpretRelease('0.5.1', 200, release('v0.9.0', { assets: [{ name: 'Daylight-0.9.0-arm64.dmg', browser_download_url: arm64, size: 8 }] }));
    assert.equal(linked.latest.htmlUrl, page);
    assert.equal(linked.latest.asset.url, arm64);
  } finally {
    globalThis.URL = savedURL;
  }
  assert.equal(interpretRelease('0.5.1', 200, []).status, 'unavailable');
  assert.deepEqual(resolveRoute('/api/app/update', 'GET'), { auth: 'web', handler: 'appUpdate' });
  assert.equal(resolveRoute('/api/app/update', 'POST').handler, 'missing');
});

test('update markup keeps release links on GitHub and escapes notes', () => {
  const html = appUpdateMarkup({
    current: '0.5.1', status: 'available', checkedAt: '2026-10-19T00:00:00Z',
    latest: { version: '0.9.0', publishedAt: '2026-10-19T00:00:00Z', htmlUrl: page, notes: '修复 <script>', asset: { name: 'Daylight-0.9.0-arm64.dmg', url: arm64 } },
  });
  assert.match(html, new RegExp(`href="${page}"`));
  assert.match(html, /下载 Daylight-0\.9\.0-arm64\.dmg/);
  assert.match(html, /修复 &lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /data-state="available"/);
  const blocked = appUpdateMarkup({ current: '0.5.1', status: 'available', latest: { version: '0.9.0', htmlUrl: 'https://evil.example/release', asset: { name: 'x.dmg', url: 'javascript:alert(1)' } } });
  assert.doesNotMatch(blocked, /evil\.example|javascript:/);
  assert.match(appUpdateMarkup(null), /正在检查…/);
  assert.match(appUpdateMarkup({ current: '0.5.1', status: 'current', latest: null }, { busy: true }), /disabled/);
});

test('the update endpoint caches GitHub releases and requires the local session', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'daylight-update-'));
  let calls = 0;
  const releaseFetch = async (url, init) => {
    calls += 1;
    assert.equal(url, latestReleaseURL());
    assert.equal(init.headers['User-Agent'], 'Daylight/0.5.1');
    if (calls === 1) throw new Error('offline');
    return new Response(JSON.stringify(release('v0.9.0', { assets: [{ name: 'Daylight-0.9.0-arm64.dmg', browser_download_url: arm64, size: 8 }] })), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const server = await createWorkbench({ dataDir, appVersion: '0.5.1', releaseFetch, proxyOptions: { includeGateway: false, includeAgy: false, includeGrok: false } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const state = await (await fetch(`${url}/api/state`)).json();
    const headers = { 'x-workbench-token': state.token };
    assert.equal((await fetch(`${url}/api/app/update`)).status, 403);
    assert.equal(calls, 0);
    assert.equal((await fetch(`${url}/api/app/update`, { method: 'POST', headers })).status, 404);
    const failed = await (await fetch(`${url}/api/app/update`, { headers })).json();
    assert.equal(failed.status, 'unavailable');
    assert.equal(failed.error, '暂时无法连接 GitHub 发布');
    assert.equal((await (await fetch(`${url}/api/app/update`, { headers })).json()).error, failed.error);
    assert.equal(calls, 1);
    const fresh = await (await fetch(`${url}/api/app/update?refresh=1`, { headers })).json();
    assert.equal(fresh.status, 'available');
    assert.equal(fresh.current, '0.5.1');
    assert.equal(fresh.latest.version, '0.9.0');
    assert.equal(fresh.latest.asset.url, arm64);
    assert.match(fresh.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(calls, 2);
    assert.equal((await (await fetch(`${url}/api/app/update`, { headers })).json()).latest.version, '0.9.0');
    assert.equal(calls, 2);
  } finally {
    await server.closeProxy();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true });
  }
});
