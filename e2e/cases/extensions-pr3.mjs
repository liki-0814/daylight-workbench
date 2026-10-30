// 0.7 PR-3 (frontend) cases: banner/toast with 「复制路径」, capability-gated 「在访达中显示」/「从备份恢复」 (api-contract §H), switch, search-field, sheet.
// The reveal / backups routes are not implemented by the backend yet, so the with-capability case injects state.capabilities and mocks those two routes.
import fs from 'node:fs/promises';
import path from 'node:path';

const rows = page => page.locator('.extension-row');
const open = async (page, url, tab) => { await page.goto(`${url}/#extensions&tab=${tab}`); await rows(page).first().waitFor({ timeout: 10000 }); };
const dialog = page => page.locator('dialog[open]');
const banner = page => page.locator('[data-config-banner="MCP_FORMAT"]');
const toasts = page => page.locator('.ui-toast-region[role="status"] .ui-toast');
const breakMcp = async (page, fixture) => {
  const file = path.join(fixture.agents, 'mcp/servers.json'), good = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, '{ "schemaVersion": 1, "servers": [ '); await page.getByRole('button', { name: '重新扫描扩展', exact: true }).click(); await banner(page).waitFor();
  return { file, restore: () => fs.writeFile(file, good) };
};
const withCapabilities = (page, capabilities) => page.route(/\/api\/extensions\/(state|refresh)(\?.*)?$/, async route => {
  const response = await route.fetch(), body = await response.json(); // inject both the nested shape (capabilities.extensions.*, what #36 serves and PR-5 reads) and the old flat one that the PR-3 page.js (#33) still reads
  body.capabilities = { ...(body.capabilities || {}), ...capabilities, extensions: { ...(body.capabilities?.extensions || {}), ...capabilities } };
  await route.fulfill({ response, json: body });
});

export default [
  { id: 'ext-pr3-01', priority: 'P0', title: '后端没有 capabilities 时：不显示「在访达中显示」「从备份恢复」，改用「复制路径」；复制成功 / 失败都用 role=status 播报，失败时选中路径文字', async run({ page, url, assert: check, fixture }) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
    await open(page, url, 'mcp');
    const broken = await breakMcp(page, fixture);
    check.equal(await banner(page).getAttribute('role'), 'alert', '错误横幅是 role=alert');
    check.equal(await page.getByRole('button', { name: /在访达中显示/ }).count(), 0, '没有 capability 不应出现「在访达中显示」');
    check.equal(await page.getByRole('button', { name: /从备份恢复/ }).count(), 0, '没有 capability 不应出现「从备份恢复」');
    const path0 = (await banner(page).locator('[data-config-path]').innerText()).trim(), copy = banner(page).getByRole('button', { name: '复制路径', exact: true });
    check.ok(path0.endsWith('servers.json'), '横幅里有配置文件路径：' + path0);
    await copy.click(); await toasts(page).filter({ hasText: '已复制路径' }).waitFor();
    check.equal(await page.evaluate(() => navigator.clipboard.readText()), path0, '剪贴板里是该路径');
    check.equal(await page.locator('.ui-toast-region').getAttribute('aria-live'), 'polite');
    check.equal(await page.evaluate(() => document.activeElement?.textContent), '复制路径', 'toast 不抢焦点：焦点仍在按钮上');
    await toasts(page).first().waitFor({ state: 'detached', timeout: 7000 });   // 4 秒后自动消失
    // 剪贴板写入失败：路径文字被选中，播报提示按 ⌘C
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } }));
    await copy.click(); await toasts(page).filter({ hasText: '已选中' }).waitFor();
    check.equal(await page.evaluate(() => getSelection().toString().trim()), path0, '失败时路径文字被选中');
    await broken.restore(); await page.getByRole('button', { name: '重新扫描扩展', exact: true }).click(); await banner(page).waitFor({ state: 'detached' });
  } },
  { id: 'ext-pr3-02', priority: 'P0', title: '后端声明 capabilities.reveal / restoreBackup 后：显示「在访达中显示」「从备份恢复…」并隐藏「复制路径」；恢复点 sheet 可 Esc 关闭且焦点回位', async run({ page, url, assert: check, fixture }) {
    const posted = [];
    await withCapabilities(page, { reveal: true, restoreBackup: true });
    await page.route(/\/api\/extensions\/reveal$/, route => { posted.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); });
    await page.route(/\/api\/extensions\/backups\?kind=mcpConfig$/, route => route.fulfill({ json: { backups: [{ operationId: 'op-old', summary: '改用本地服务前', at: '2026-10-29 21:00', servers: 3 }, { operationId: 'op-older', summary: '首次接入前', at: '2026-10-28 09:30', servers: 2 }] } }));
    await open(page, url, 'mcp');
    const broken = await breakMcp(page, fixture);
    check.equal(await banner(page).getByRole('button', { name: '复制路径' }).count(), 0, '有 reveal 能力时用「在访达中显示」代替「复制路径」');
    await banner(page).getByRole('button', { name: '在访达中显示', exact: true }).click(); await toasts(page).filter({ hasText: '已在访达中显示' }).waitFor();
    check.deepEqual(posted, [{ kind: 'mcpConfig' }], 'reveal 请求体符合契约 §H');
    const restore = banner(page).getByRole('button', { name: '从备份恢复…', exact: true });
    await restore.click(); await dialog(page).waitFor();
    check.equal(await dialog(page).getByRole('radio').count(), 2); check.equal(await dialog(page).getByRole('radio', { name: /改用本地服务前/ }).isChecked(), true, '默认选中最近的恢复点');
    check.equal(await dialog(page).evaluate(el => el.classList.contains('ui-sheet')), true);
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await page.waitForFunction(() => document.activeElement?.textContent === '从备份恢复…', null, { timeout: 2000 }).catch(() => { throw new Error('Esc 关闭 sheet 后焦点没有回到「从备份恢复…」'); });
    await broken.restore(); await page.getByRole('button', { name: '重新扫描扩展', exact: true }).click(); await banner(page).waitFor({ state: 'detached' });
  } },
  { id: 'ext-pr3-03', priority: 'P0', title: '开关是 role=switch、38×22、命中区 ≥ 28px、可键盘切换；搜索框清除按钮是 SVG（名称「清除搜索」），Esc 也可清除并保持焦点', async run({ page, url, assert: check }) {
    await open(page, url, 'skills');
    const toggle = page.locator('.extension-list').getByRole('switch').first(), input = toggle;
    check.ok(await toggle.count(), '开关使用 role=switch');
    check.equal(await page.locator('.extension-list').getByRole('checkbox').count(), 0, '列表里不应再有 role=checkbox 的开关');
    const box = await input.boundingBox(), hit = await input.locator('xpath=ancestor::label[1]').boundingBox();
    check.equal(Math.round(box.width), 38); check.equal(Math.round(box.height), 22); check.ok(hit.height >= 28, '命中区高度 ' + hit.height);
    await input.focus(); check.equal(await input.evaluate(el => getComputedStyle(el).boxShadow !== 'none'), true, '键盘焦点可见');
    const search = page.getByRole('searchbox', { name: '搜索扩展' }), clear = page.getByRole('button', { name: '清除搜索', exact: true });
    check.equal(await clear.isVisible(), false, '空搜索时不显示清除按钮');
    await search.focus(); check.equal(await page.locator('.ui-search').evaluate(el => getComputedStyle(el).boxShadow !== 'none'), true, '搜索框聚焦时外框有可见焦点环（输入框自身 outline:none，由外框兜底）');
    await search.fill('review'); await clear.waitFor();
    check.equal(await clear.locator('svg').count(), 1); check.doesNotMatch(await clear.innerText(), /[✕×]/);
    const size = await clear.boundingBox(); check.ok(size.width >= 28 && size.height >= 28, '清除按钮 ≥ 28×28');
    await clear.click(); check.equal(await search.inputValue(), ''); check.equal(await page.evaluate(() => document.activeElement?.getAttribute('type')), 'search', '清除后焦点回到搜索框');
    check.equal(await page.evaluate(() => location.hash.includes('query=')), false, '路由里的 query 也被清除');
    await search.fill('api'); await page.keyboard.press('Escape'); check.equal(await search.inputValue(), '', 'Esc 清除'); check.equal(await clear.isVisible(), false);
  } },
];
