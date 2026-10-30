// Uses only the disposable extension acceptance server/config roots.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.DAYLIGHT_PLAYWRIGHT_MODULE || 'playwright');
const fixture = path.resolve(process.argv[2] || '');
if (!path.basename(fixture).startsWith('daylight-extensions-browser-')) throw new Error('Requires isolated browser fixture');
const url = (await fs.readFile(path.join(fixture, 'url'), 'utf8')).trim();
const grok = path.join(fixture, 'grok'), config = path.join(grok, 'config.toml');
await fs.mkdir(path.join(grok, 'skills/personal'), { recursive: true });
await fs.writeFile(path.join(grok, 'skills/personal/SKILL.md'), '---\nname: personal\ndescription: 软件本地 Skill\n---\nLocal\n');
const original = '# retained\nmodel = "local"\n[mcp_servers.local]\ncommand = "node" # launcher\nargs = []\n[mcp_servers.local.env]\nTOKEN = "private-fixture-secret" # credential\n';
await fs.writeFile(config, original);
await fs.mkdir(path.join(fixture, 'agents/daylight'), { recursive: true });
await fs.writeFile(path.join(fixture, 'agents/daylight/clients.json'), JSON.stringify({ schemaVersion: 1, clients: [{ id: 'client_grok', name: 'Grok', command: 'grok', root: grok, skillsDirectory: 'skills', mcpFormat: 'json' }] }));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DAYLIGHT_CHROME_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } }), errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const choose = async (name, label) => { await page.getByRole('combobox', { name, exact: true }).click(); await page.getByRole('option', { name: label, exact: true }).click(); };
const dialog = () => page.locator('dialog[open]');
const closed = () => page.waitForFunction(() => !document.querySelector('dialog[open]'));
try {
  await page.goto(url + '/#extensions&tab=clients'); await page.getByRole('heading', { name: '本地 CLI', exact: true }).waitFor();
  assert.equal(await page.locator('[data-extension-id]').filter({ hasText: 'Grok' }).count(), 1);
  await page.locator('[data-extension-id]').filter({ hasText: 'Grok' }).click(); await page.getByRole('button', { name: '删除旧登记，使用自动识别', exact: true }).click();
  await dialog().getByRole('button', { name: '应用变更', exact: true }).click(); await closed();
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(fixture, 'agents/daylight/clients.json'))).clients, []);
  assert.equal(await fs.readFile(config, 'utf8'), original); checks.push('automatic Grok replaces old registration without changing native configuration');
  await page.screenshot({ path: path.join(fixture, 'automatic-grok.png'), fullPage: true });
  await page.getByRole('button', { name: '添加 CLI', exact: true }).click();
  await choose('CLI 适配器', 'Grok'); assert.equal(await page.getByRole('option', { name: 'Gemini CLI', exact: true }).count(), 0); await page.keyboard.press('Escape'); await closed();
  await choose('按软件筛选', 'Grok');
  await page.getByRole('radio', { name: 'Skills', exact: true }).click(); await page.locator('[data-extension-id]').filter({ hasText: 'personal' }).click();
  await page.getByRole('button', { name: '编辑文件', exact: true }).click(); await dialog().locator('[name=content]').fill('---\nname: personal\ndescription: 软件本地 Skill\n---\nEdited\n');
  await dialog().getByRole('button', { name: '保存主来源', exact: true }).click(); await closed(); assert.match(await fs.readFile(path.join(grok, 'skills/personal/SKILL.md'), 'utf8'), /Edited/);
  checks.push('local Skill uses shared editor and writes its actual source');
  await page.getByRole('radio', { name: 'MCP 服务', exact: true }).click(); await page.locator('[data-extension-id]').filter({ hasText: 'local' }).click(); await page.getByRole('button', { name: '编辑配置', exact: true }).waitFor();
  assert.ok(!(await page.locator('.extension-detail').textContent()).includes('private-fixture-secret'));
  await page.getByRole('button', { name: '编辑配置', exact: true }).click(); await dialog().locator('[name=args]').fill('new.mjs');
  await dialog().getByRole('button', { name: '保存主来源', exact: true }).click(); await dialog().getByRole('button', { name: '确认保存配置', exact: true }).waitFor();
  assert.equal(await fs.readFile(config, 'utf8'), original); assert.ok(!(await dialog().textContent()).includes('private-fixture-secret'));
  await dialog().getByRole('button', { name: '确认保存配置', exact: true }).click(); await closed();
  assert.match(await fs.readFile(config, 'utf8'), /private-fixture-secret/); assert.match(await fs.readFile(config, 'utf8'), /# launcher/);
  await page.getByRole('button', { name: '禁用此服务', exact: true }).click(); await dialog().getByRole('button', { name: '应用变更', exact: true }).click(); await closed();
  await page.getByRole('button', { name: '启用此服务', exact: true }).waitFor(); checks.push('native MCP editing/toggle is reviewed and preserves opaque credentials and comments');
  await page.screenshot({ path: path.join(fixture, 'native-mcp-detail.png'), fullPage: true });
  await page.locator('[data-add-menu-button]').click(); await page.getByRole('menuitem', { name: '新建 MCP 服务…', exact: true }).click();   // 0.7 PR-8：新建 / 导入都在「添加 ▾」菜单里 await choose('保存到', 'Grok · 本地配置');
  await dialog().getByLabel('稳定 ID', { exact: true }).fill('new-server'); await dialog().getByLabel('服务名称', { exact: true }).fill('new-server'); await dialog().getByLabel('可执行命令', { exact: true }).fill('node');
  await dialog().getByRole('button', { name: '保存主来源', exact: true }).click(); await dialog().getByRole('button', { name: '确认保存配置', exact: true }).click(); await closed();
  assert.match(await fs.readFile(config, 'utf8'), /new-server/); checks.push('shared destination selector creates a native MCP');
  const layouts = [];
  for (const width of [1360, 800, 390]) {
    await page.setViewportSize({ width, height: 900 }); let reference;
    for (const tab of ['Skills', 'MCP 服务', '接入软件']) {
      await page.getByRole('radio', { name: tab, exact: true }).click();
      const anchors = await page.evaluate(() => Object.fromEntries(['.extension-tabs', '.extension-search', '.extension-software-filter', '.extension-category-action', '.extension-list-heading'].map(selector => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect(); return [selector, { x, y, width, height }];
      })));
      reference ||= anchors; assert.deepEqual(anchors, reference); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); layouts.push({ width, tab, anchors });
    }
  }
  await page.setViewportSize({ width: 1360, height: 900 }); await page.getByRole('radio', { name: 'Skills', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('radio', { name: 'MCP 服务', exact: true }).evaluate(element => document.activeElement === element), true);
  checks.push('shared tabs, software filter, layout anchors and keyboard at three widths');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(fixture, 'local-cli-report.json'), JSON.stringify({ checks, errors, layouts }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, errors }));
} finally { await browser.close(); }
