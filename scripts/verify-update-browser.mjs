// Acceptance for the 更新 page: switches real pages, compares shared layout anchors, drives every state with a mocked native updater.
// Usage: DAYLIGHT_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/verify-update-browser.mjs [output-dir]
// Runs its own isolated workbench on a temporary data directory; it never touches the user's live service.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server.mjs';
const { chromium } = await import(process.env.DAYLIGHT_PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'daylight-update-ui'));
await fs.mkdir(output, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'daylight-update-ui-data-'));
const server = await createWorkbench({ dataDir, appVersion: '0.6.0', releaseFetch: async () => new Response('{}', { status: 404 }), proxyOptions: { includeGateway: false, includeAgy: false, includeGrok: false } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const base = 'https://github.com/liki-0814/daylight-workbench/releases';
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const checks = [], errors = [];

let release, updater, checkCalls = 0, posts = [];
const reset = () => {
  checkCalls = 0; posts = [];
  release = { current: '0.6.0', status: 'available', checkedAt: new Date().toISOString(), latest: { version: '0.7.0', name: '0.7.0', publishedAt: '2026-10-29T00:00:00Z', htmlUrl: `${base}/tag/v0.7.0`, notes: '更新', body: '## 新增\n- 应用内更新\n\n<script>window.__xss=1</script>\n\n[发布页](https://github.com/liki-0814/daylight-workbench)\n\n<img src=x onerror="window.__xss=1">', asset: { name: 'Daylight-0.7.0-arm64.dmg', url: `${base}/download/v0.7.0/Daylight-0.7.0-arm64.dmg` }, install: { ok: true, size: 31457280, minOS: '13.0', date: '2026-10-29T00:00:00Z' } } };
  updater = { supported: true, phase: 'idle', mode: 'notify', history: [], backup: null, lastResult: null, current: { version: '0.6.0', signing: 'self-signed' } };
};
async function mock(page) {
  await page.route('**/api/app/update**', route => { if (route.request().url().includes('refresh=1')) checkCalls += 1; return json(route, release); });
  await page.route('**/api/app/updater', async route => {
    if (route.request().method() === 'GET') return json(route, updater);
    const body = JSON.parse(route.request().postData() || '{}'); posts.push(body);
    if (body.action === 'download') Object.assign(updater, { phase: 'downloading', target: '0.7.0', progress: { received: 0, total: 31457280 } });
    else if (body.action === 'cancel' || body.action === 'discard') Object.assign(updater, { phase: 'idle', progress: null, staged: null });
    else if (body.action === 'mode') updater.mode = body.value;
    else if (body.action === 'ack') Object.assign(updater, { lastResult: null, error: null });
    else if (body.action === 'install' || body.action === 'rollback') {
      if (updater.busy && !body.force) return json(route, { error: '有 1 个代理请求仍在进行', code: 'busy', proxyRequests: 1, aiConversations: 0 }, 409);
      updater.phase = 'installing';
    }
    return json(route, updater);
  });
}
const anchors = (page, selectors) => page.evaluate(list => Object.fromEntries(list.map(selector => { const element = document.querySelector(selector); if (!element) return [selector, null]; const { x, y, width, height } = element.getBoundingClientRect(); return [selector, { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, width: Math.round(width * 10) / 10, height: Math.round(height * 10) / 10 }]; })), selectors);
const navigation = page => page.evaluate(() => [...document.querySelectorAll('.page-navigation [data-view]')].map(button => { const { x, y, width, height } = button.getBoundingClientRect(); return [button.dataset.view, Math.round(x), Math.round(y), Math.round(width), Math.round(height)]; }));
const shot = (page, name) => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
const visible = page => page.locator('#update-page:not([hidden])');
const note = text => { checks.push(text); console.log('✓', text); };

const browser = await chromium.launch({ headless: true, ...(process.env.DAYLIGHT_CHROME_EXECUTABLE ? { executablePath: process.env.DAYLIGHT_CHROME_EXECUTABLE } : {}) });
try {
  for (const width of [760, 1240, 1440]) {
    reset();
    const context = await browser.newContext({ viewport: { width, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(`${width}: ${error.message}`));
    await mock(page);
    await page.goto(`${url}/#settings`);
    await page.locator('#settings-page:not([hidden])').waitFor();
    const settingsLayout = await anchors(page, ['.topbar', '#settings-page .page-heading h1', '#settings-page .settings-panel', '#settings-page .workspace-footer']);
    const settingsNav = await navigation(page);
    // 1) the badge and the nav entry live on 更新, not 设置
    await page.locator('[data-view="update"] [data-app-update]').waitFor();
    assert.equal(await page.locator('[data-view="settings"] [data-app-update]').count(), 0);
    assert.deepEqual(settingsNav.map(item => item[0]), ['all', 'focus', 'ai', 'proxy', 'cli', 'extensions', 'update', 'settings']);
    assert.equal(await page.locator('#settings-page').getByText('更新页面').count() > 0, true);
    assert.equal(await page.locator('#settings-page [data-app-update], #settings-page .app-update-actions').count(), 0, 'settings no longer holds the update panel');
    note(`${width}px 更新 sits before 设置, carries the badge; Settings only links to it`);

    // 2) click through to the update page and compare shared anchors
    await page.locator('[data-view="update"]').click();
    await visible(page).waitFor();
    await page.locator('#update-page .settings-facts').waitFor();
    assert.equal(await page.locator('#settings-page').isHidden(), true);
    assert.equal(await page.title(), 'Daylight · 更新');
    const updateLayout = await anchors(page, ['.topbar', '#update-page .page-heading h1', '#update-page .settings-panel', '#update-page .workspace-footer']);
    const pairs = [['.topbar', '.topbar'], ['#settings-page .page-heading h1', '#update-page .page-heading h1'], ['#settings-page .settings-panel', '#update-page .settings-panel']];
    for (const [a, b] of pairs) { assert.deepEqual({ x: settingsLayout[a].x, y: settingsLayout[a].y, width: settingsLayout[a].width }, { x: updateLayout[b].x, y: updateLayout[b].y, width: updateLayout[b].width }, `${width}px ${b} moved versus settings`); }
    assert.deepEqual(await navigation(page), settingsNav, `${width}px sidebar navigation jumped`);
    note(`${width}px switching 设置 → 更新 keeps topbar, heading, first panel and sidebar in place`);
    await page.locator('[data-view="settings"]').click();
    await page.locator('#settings-page:not([hidden])').waitFor();
    assert.deepEqual(await navigation(page), settingsNav);
    await page.locator('#settings-page a[href="#update"]').click();
    await visible(page).waitFor();
    note(`${width}px the Settings link opens the update page`);

    // 3) content: repo, versions, notes safety
    await page.locator('#update-page a[href="https://github.com/liki-0814/daylight-workbench"]').first().waitFor();
    assert.match(await page.locator('#update-page .settings-facts').innerText(), /0\.6\.0[\s\S]*0\.7\.0/);
    await page.locator('[data-update-notes] h2').waitFor();
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('[data-update-notes] script, [data-update-notes] img').count(), 0);
    assert.equal(await page.locator('[data-update-notes] a').first().getAttribute('target'), '_blank');
    await page.locator('[data-update-copy]').click();
    await page.getByText('已复制仓库地址').waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'https://github.com/liki-0814/daylight-workbench');
    note(`${width}px repository address opens/copies; release notes render sanitized`);
    if (width === 1240) await shot(page, 'available-1240');

    // 4) the manual check, then download → progress → ready → install
    const before = checkCalls;
    await page.locator('[data-update-check]').click();
    await page.waitForFunction(() => !document.querySelector('[data-update-check][disabled]'));
    assert.equal(checkCalls, before + 1);
    await page.locator('[data-update-download]').click();
    await page.locator('[data-update-cancel]').waitFor();
    assert.equal(await page.locator('[data-update-live]').getAttribute('aria-live'), 'polite');
    updater.progress = { received: 15728640, total: 31457280 };
    await page.waitForFunction(() => document.querySelector('[data-update-progress-text]')?.textContent.includes('50%'));
    assert.equal(Math.round(await page.locator('[data-update-progress] progress').evaluate(element => element.value * 100)), 50);
    if (width === 1240) await shot(page, 'downloading-1240');
    await page.locator('[data-update-cancel]').click();
    await page.locator('[data-update-download]').waitFor();
    await page.locator('[data-update-download]').click();
    Object.assign(updater, { phase: 'ready', staged: { version: '0.7.0', size: 31457280, credentialsReset: false } });
    await page.locator('[data-update-install]').waitFor({ timeout: 20000 });
    if (width === 1240) await shot(page, 'ready-1240');
    // busy → confirmation dialog, Escape keeps the old state and returns focus
    updater.busy = true;
    await page.locator('[data-update-install]').focus();
    await page.keyboard.press('Enter');
    await page.locator('dialog[open]').waitFor();
    assert.match(await page.locator('dialog[open]').innerText(), /仍然重启/);
    if (width === 1240) await shot(page, 'busy-confirm-1240');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.equal(updater.phase, 'ready');
    await page.locator('[data-update-install]').click();
    await page.locator('[data-update-confirm]').click();
    assert.equal(posts.at(-1).force, true);
    await page.locator('[data-update-check][disabled]').waitFor();
    assert.match(await page.locator('#update-page .app-update-actions').innerText(), /正在重启/);
    note(`${width}px check → download → progress → cancel → ready → busy confirm (Esc keeps state) → forced install`);

    // 5) mode control by keyboard
    Object.assign(updater, { phase: 'idle', busy: false, staged: null });
    await page.locator('[data-view="settings"]').click(); await page.locator('[data-view="update"]').click();
    await page.locator('[data-segment-value="notify"]').waitFor();
    await page.locator('[data-segment-value="notify"]').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('[data-segment-value="download-quit"]')?.getAttribute('aria-checked') === 'true');
    await page.waitForFunction(() => document.querySelector('[data-update-mode-note]')?.textContent.includes('退出 Daylight 时静默安装'));
    assert.deepEqual(posts.at(-1), { action: 'mode', value: 'download-quit' });
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.segmentValue), 'download-quit', 'focus survives the repaint');
    assert.match(await page.locator('[data-update-mode-note]').innerText(), /退出 Daylight 时静默安装/);
    note(`${width}px mode control works with the keyboard and keeps focus`);

    // 6) history, rollback and results
    Object.assign(updater, { backup: { version: '0.5.1', createdAt: '2026-10-28T00:00:00Z', sameSigner: true }, history: [{ status: 'success', kind: 'install', from: '0.5.1', to: '0.6.0', at: '2026-10-28T00:00:00Z' }, { status: 'rolled-back', kind: 'install', from: '0.6.0', to: '0.6.1', at: '2026-10-29T00:00:00Z' }], lastResult: { status: 'rolled-back', kind: 'install', from: '0.6.0', to: '0.6.1', at: '2026-10-29T00:00:00Z' }, error: { code: 'download', message: '下载中断' } });
    await page.locator('[data-view="settings"]').click(); await page.locator('[data-view="update"]').click();
    await page.locator('[data-update-history] li').first().waitFor();
    assert.equal(await page.locator('[data-update-history] li').count(), 2);
    assert.equal(await page.locator('[data-update-result]').count(), 1);
    assert.equal(await page.locator('[role="alert"]').count() >= 1, true);
    if (width === 1240) await shot(page, 'history-1240');
    await page.locator('[data-update-ack]').first().click();
    await page.waitForFunction(() => !document.querySelector('[data-update-result]'));
    await page.locator('[data-update-rollback]').click();
    await page.locator('dialog[open]').getByRole('button', { name: '回滚并重启' }).click();
    assert.equal(posts.at(-1).action, 'rollback');
    note(`${width}px history, notices, acknowledge and rollback confirmation work`);

    // 7) states: current, unavailable, web edition fallback, loading
    reset(); release = { current: '0.6.0', status: 'current', checkedAt: new Date().toISOString(), latest: { ...release.latest, version: '0.6.0', install: undefined } };
    await page.locator('[data-view="settings"]').click(); await page.locator('[data-view="update"]').click();
    await page.locator('[data-update-check]').click();
    await page.getByText('已是最新正式发布').first().waitFor();
    assert.equal(await page.locator('[data-update-download]').count(), 0);
    assert.equal(await page.locator('[data-view="update"] [data-app-update]').count(), 0, 'badge disappears when current');
    release = { current: '0.6.0', status: 'unavailable', latest: null, error: '暂时无法连接 GitHub 发布', checkedAt: new Date().toISOString() };
    await page.locator('[data-update-check]').click();
    await page.getByText('暂时无法连接 GitHub 发布').first().waitFor();
    assert.equal(await page.locator('[data-update-notes-empty]').count(), 1);
    reset(); updater = { ...updater, supported: false, reason: 'web', message: '网页版不支持应用内安装' };
    await page.locator('[data-update-check]').click();
    await page.locator('a', { hasText: '下载 Daylight-0.7.0-arm64.dmg' }).waitFor();
    assert.equal(await page.locator('[data-update-download]').count(), 0);
    assert.equal(await page.locator('[data-segment-value="download-quit"]').isDisabled(), true);
    if (width === 1240) await shot(page, 'web-fallback-1240');
    note(`${width}px current / unavailable / unsupported-edition states render and degrade to the DMG link`);

    // 8) overflow and the native menu route
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px horizontal overflow`);
    reset(); const calls = checkCalls;
    await page.goto(`${url}/#update&check=1`);
    await page.waitForFunction(() => location.hash === '#update' || location.hash === '');
    await visible(page).waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-update-check][disabled]'));
    assert.ok(checkCalls > calls, 'menu route triggers a check');
    assert.equal(await page.locator('[data-view="update"][aria-current="page"]').count(), 1);
    note(`${width}px #update&check=1 (menu 检查更新…) opens the page and checks`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ checks }, null, 2));
  console.log(`PASS ${checks.length} checks; screenshots in ${output}`);
} finally {
  await browser.close();
  await server.closeProxy();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await fs.rm(dataDir, { recursive: true, force: true });
}
