// Acceptance is isolated from all user CLI/config directories.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.DAYLIGHT_PLAYWRIGHT_MODULE || 'playwright');
const fixture = path.resolve(process.argv[2] || '');
if (!path.basename(fixture).startsWith('daylight-extensions-browser-')) throw new Error('Requires isolated browser fixture');
const url = (await fs.readFile(path.join(fixture, 'url'), 'utf8')).trim();
const registration = path.join(fixture, 'agents/daylight/clients.json');
await fs.writeFile(registration, JSON.stringify({ schemaVersion: 1, clients: [], selectedClients: [] }));
await fs.mkdir(path.join(fixture, 'codex/skills/local-only'), { recursive: true });
await fs.writeFile(path.join(fixture, 'codex/skills/local-only/SKILL.md'), '---\nname: local-only\ndescription: 本地独立来源\n---\nLocal\n');
const native = '# keep\n[mcp_servers.native]\ncommand = "node"\n';
await fs.writeFile(path.join(fixture, 'codex/config.toml'), native);
await fs.mkdir(path.join(fixture, 'qoder/skills/review-code'), { recursive: true });
await fs.copyFile(path.join(fixture, 'agents/skills/review-code/SKILL.md'), path.join(fixture, 'qoder/skills/review-code/SKILL.md'));
await fs.writeFile(path.join(fixture, 'qoder/settings.json'), 'invalid untouched native config');
const browser = await chromium.launch({ headless: true, executablePath: process.env.DAYLIGHT_CHROME_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } }), errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const dialog = () => page.locator('dialog[open]');
const closed = () => page.waitForFunction(() => !document.querySelector('dialog[open]'));
const checkbox = () => page.getByRole('checkbox', { name: 'Codex · 接入扩展管理', exact: true });
const tab = name => page.getByRole('radio', { name, exact: true }).click();
try {
  await page.goto(url + '/#extensions&tab=clients'); await checkbox().waitFor();
  assert.equal(await page.locator('[data-cli-selection]:checked').count(), 0);
  assert.equal(await page.locator('.extension-static-diagnostics').count(), 0);
  await checkbox().focus(); await page.keyboard.press('Space'); await dialog().waitFor();
  assert.deepEqual(JSON.parse(await fs.readFile(registration)).selectedClients, []);
  await page.keyboard.press('Escape'); await closed(); assert.equal(await checkbox().isChecked(), false);
  await page.waitForFunction(() => document.activeElement?.matches('input[data-cli-selection][data-client=codex]'));
  checks.push('discovery is unchecked; keyboard preview cancellation is inert and restores focus');
  await checkbox().click(); await dialog().getByRole('button', { name: '应用变更', exact: true }).click(); await closed();
  assert.deepEqual(JSON.parse(await fs.readFile(registration)).selectedClients, ['codex']);
  assert.equal(await fs.readFile(path.join(fixture, 'codex/config.toml'), 'utf8'), native);
  await page.reload(); await checkbox().waitFor(); assert.equal(await checkbox().isChecked(), true);
  checks.push('reviewed client selection persists without changing native configuration');
  await tab('Skills'); await page.locator('[data-extension-id]').filter({ hasText: 'local-only' }).waitFor();
  assert.equal(await page.locator('[data-binding-toggle][data-client=qoder]').count(), 0);
  assert.equal(await page.locator('.extension-static-diagnostics').count(), 0);
  await page.locator('[data-binding-toggle][data-client=codex]').first().click(); await dialog().getByRole('button', { name: '应用变更', exact: true }).click(); await closed();
  const linked = await fs.readdir(path.join(fixture, 'codex/skills'));
  const links = []; for (const name of linked) { const file = path.join(fixture, 'codex/skills', name); if ((await fs.lstat(file)).isSymbolicLink()) links.push([file, await fs.readlink(file)]); }
  assert.equal(links.length, 1);
  await tab('MCP 服务'); await page.locator('[data-extension-id]').filter({ hasText: 'native' }).waitFor();
  await page.getByRole('button', { name: '新建 MCP 服务', exact: true }).click(); await dialog().getByRole('combobox', { name: '保存到', exact: true }).click();
  assert.equal(await page.getByRole('option', { name: 'Qoder · 本地配置', exact: true }).count(), 0);
  assert.equal(await page.getByRole('option', { name: 'Codex · 本地配置', exact: true }).count(), 1);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await closed();
  checks.push('Skills, native MCP and destination controls include only selected clients; inactive duplicates and invalid files are ignored');
  const layouts = [];
  for (const width of [1360, 800, 390]) {
    await page.setViewportSize({ width, height: 900 }); let reference;
    for (const name of ['Skills', 'MCP 服务', '接入软件']) {
      await tab(name);
      const anchors = await page.evaluate(() => Object.fromEntries(['.extension-tabs', '.extension-search', '.extension-software-filter', '.extension-category-action', '.extension-list-heading'].map(selector => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect(); return [selector, { x, y, width, height }];
      })));
      reference ||= anchors; assert.deepEqual(anchors, reference); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); layouts.push({ width, name, anchors });
    }
  }
  await page.screenshot({ path: path.join(fixture, 'cli-selection-390.png'), fullPage: true });
  await page.setViewportSize({ width: 1360, height: 900 }); await tab('接入软件');
  await page.screenshot({ path: path.join(fixture, 'cli-selection-1360.png'), fullPage: true });
  checks.push('shared tab layout and selection controls remain aligned at three widths');
  await checkbox().click(); await dialog().getByRole('button', { name: '应用变更', exact: true }).click(); await closed();
  await page.reload(); await checkbox().waitFor(); assert.equal(await checkbox().isChecked(), false);
  for (const [file, link] of links) assert.equal(await fs.readlink(file), link);
  assert.equal(await fs.readFile(path.join(fixture, 'codex/config.toml'), 'utf8'), native);
  assert.equal(await fs.readFile(path.join(fixture, 'qoder/settings.json'), 'utf8'), 'invalid untouched native config');
  await tab('Skills'); assert.equal(await page.locator('[data-extension-id]').filter({ hasText: 'local-only' }).count(), 0); assert.equal(await page.locator('[data-binding-toggle]').count(), 0);
  await page.locator('[data-extension-id]').first().click(); await page.locator('.extension-detail').getByText('中选择要管理的 CLI。', { exact: false }).waitFor();
  checks.push('deselection persists, hides local sources and preserves existing links/configuration');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(fixture, 'selection-report.json'), JSON.stringify({ checks, errors, layouts }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, errors }));
} finally { await browser.close(); }
