import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { interpretRelease, latestReleaseURL, compareVersions } from '../core/app-update.js';
import { resolveRoute } from '../core/contracts.js';
import { updateMarkup, progressFraction, progressText } from '../public/update-page.js';
import { createWorkbench } from '../server.mjs';

const page = 'https://github.com/liki-0814/daylight-workbench/releases/tag/v0.9.0';
const arm64 = 'https://github.com/liki-0814/daylight-workbench/releases/download/v0.9.0/Daylight-0.9.0-arm64.dmg';
const release = (tag, extra = {}) => ({
  tag_name: tag, name: tag.replace(/^v/, ''), draft: false, prerelease: false,
  html_url: `https://github.com/liki-0814/daylight-workbench/releases/tag/${tag}`,
  published_at: '2026-10-19T00:00:00Z', body: '说明', assets: [], ...extra,
});

test('release versions compare numerically and only accept three-part versions (a prerelease suffix is ordered below its release, see prerelease-version.test.mjs)', () => {
  assert.equal(compareVersions('0.9.0', 'v0.10.0'), -1);
  assert.equal(compareVersions('v0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('0.5.1', '0.5.1'), 0);
  assert.equal(compareVersions('0.5', '0.5.1'), null);
  assert.equal(compareVersions('0.5.1-beta', '0.5.2'), -1);
  assert.equal(compareVersions('0.5.1-beta', '0.5.1'), -1);
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

const available = (extra = {}) => ({
  current: '0.5.1', status: 'available', checkedAt: '2026-10-19T00:00:00Z',
  latest: { version: '0.9.0', name: '0.9.0', publishedAt: '2026-10-19T00:00:00Z', htmlUrl: page, notes: '修复 <script>', body: '## 修复\n- 登录', asset: { name: 'Daylight-0.9.0-arm64.dmg', url: arm64 }, install: { ok: true, size: 5242880, minOS: '13.0', date: '2026-10-19T00:00:00Z' }, ...extra },
});
const native = (extra = {}) => ({ supported: true, phase: 'idle', mode: 'notify', history: [], backup: null, lastResult: null, current: { version: '0.5.1', signing: 'self-signed' }, ...extra });

test('update page markup shows the repository, versions and one primary action per state', () => {
  const idle = updateMarkup({ release: available(), updater: native() });
  assert.match(idle, /href="https:\/\/github\.com\/liki-0814\/daylight-workbench"/);
  assert.match(idle, /data-update-copy/);
  assert.match(idle, /data-update-check/);
  assert.match(idle, /data-update-download[^>]*>[\s\S]*下载更新 0\.9\.0 · 5\.0 MB/);
  assert.doesNotMatch(idle, /data-update-install|data-update-cancel/);
  assert.match(idle, /data-state="available"/);
  assert.match(idle, /href="[^"]*releases\/tag\/v0\.9\.0"/);
  const downloading = updateMarkup({ release: available(), updater: native({ phase: 'downloading', target: '0.9.0', progress: { received: 1048576, total: 5242880 } }) });
  assert.match(downloading, /data-update-cancel/);
  assert.match(downloading, /aria-live="polite"/);
  assert.match(downloading, /正在下载 0\.9\.0 · 20% \(1\.0 MB \/ 5\.0 MB\)/);
  assert.doesNotMatch(downloading, /data-update-download/);
  const ready = updateMarkup({ release: available(), updater: native({ phase: 'ready', staged: { version: '0.9.0', size: 5242880, credentialsReset: true } }) });
  assert.match(ready, /data-update-install[^>]*>[\s\S]*重启并安装 0\.9\.0/);
  assert.match(ready, /data-update-discard/);
  assert.match(ready, /钥匙串辅助程序/);
  const installing = updateMarkup({ release: available(), updater: native({ phase: 'installing' }) });
  assert.match(installing, /正在重启…/);
  assert.match(installing, /data-update-check[^>]*disabled/);
  assert.equal(progressFraction(native({ progress: { received: 5, total: 0 } })), 0);
  assert.equal(progressFraction(native({ progress: { received: 9, total: 4 } })), 1);
  assert.equal(progressText(native({ phase: 'verifying', target: '0.9.0' })), '正在校验 0.9.0');
});

test('update page markup falls back to the DMG when in-app install is unavailable', () => {
  const web = updateMarkup({ release: available(), updater: native({ supported: false, reason: 'web', message: '网页版不支持应用内安装' }) });
  assert.doesNotMatch(web, /data-update-download/);
  assert.match(web, /下载 Daylight-0\.9\.0-arm64\.dmg/);
  assert.match(web, /网页版不支持应用内安装/);
  assert.match(web, /data-segment-value="download-quit"[^>]*disabled/);
  const blocked = updateMarkup({ release: available({ install: { ok: false, code: 'os-too-old', message: '需要 macOS 15.0 或更高版本' } }), updater: native() });
  assert.doesNotMatch(blocked, /data-update-download/);
  assert.match(blocked, /需要 macOS 15\.0 或更高版本/);
  const reauth = updateMarkup({ release: available(), updater: native({ needsReauth: { message: '签名身份变了，需要手动安装一次 DMG' } }) });
  assert.match(reauth, /签名身份变了/);
});

test('update page markup covers loading, error, empty and history states', () => {
  assert.match(updateMarkup({}), /正在检查…/);
  assert.match(updateMarkup({ loadError: '无法读取更新状态' }), /无法读取更新状态/);
  assert.match(updateMarkup({ release: { current: '0.5.1', status: 'current', latest: null }, updater: native() }), /已是最新正式发布/);
  assert.match(updateMarkup({ release: { current: '0.5.1', status: 'unavailable', latest: null, error: '暂时无法连接 GitHub 发布' }, updater: native() }), /暂时无法连接 GitHub 发布/);
  assert.match(updateMarkup({ release: available(), updater: native() }), /data-update-history-empty/);
  assert.match(updateMarkup({ release: available({ body: '' }), updater: native() }), /data-update-notes-empty/);
  const history = updateMarkup({
    release: available(),
    updater: native({
      backup: { version: '0.5.0', createdAt: '2026-10-18T00:00:00Z', sameSigner: false },
      history: [{ status: 'rolled-back', from: '0.5.0', to: '0.5.1', at: '2026-10-18T00:00:00Z' }, { status: 'success', kind: 'install', from: '0.4.0', to: '0.5.0' }],
      lastResult: { status: 'failed', kind: 'install', from: '0.5.1', to: '0.9.0', message: '磁盘已满' },
      error: { code: 'download', message: '下载中断 <b>' },
    }),
  });
  assert.match(history, /data-update-rollback/);
  assert.match(history, /回滚到 0\.5\.0/);
  assert.match(history, /签名与当前不同/);
  assert.match(history, /0\.9\.0 启动后|0\.5\.1 启动后未通过健康检查，已自动回滚到 0\.5\.0/);
  assert.match(history, /更新失败，已保持原版本：磁盘已满/);
  assert.match(history, /下载中断 &lt;b&gt;/);
  assert.match(history, /role="alert"/);
  assert.match(history, /data-update-ack/);
});

test('update page markup keeps release links on GitHub and escapes notes', () => {
  const html = updateMarkup({ release: available(), updater: native(), notesHtml: '<h2>修复</h2>' });
  assert.match(html, /<h2>修复<\/h2>/);
  assert.doesNotMatch(html, /<script>/);
  const fallbackNotes = updateMarkup({ release: available({ body: '正文' }), updater: native() });
  assert.match(fallbackNotes, /修复 &lt;script&gt;/);
  const blocked = updateMarkup({ release: { current: '0.5.1', status: 'available', latest: { version: '0.9.0', htmlUrl: 'https://evil.example/release', asset: { name: 'x.dmg', url: 'javascript:alert(1)' }, install: { ok: false, message: 'x' } } }, updater: native({ supported: false }) });
  assert.doesNotMatch(blocked, /evil\.example|javascript:/);
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
