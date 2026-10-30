// PR-12 (MCP 同 ID 冲突处理：对比 / adoptNew / keepExisting)。liki 2026-10-30 决定进入 0.7。
// 夹具冲突：共享 MCP `missing-env-mcp`（凭据引用未设置）与 `github-remote`（头部引用已设置，其值即 FIXTURE_SECRET，绝不能出现在任何响应里）。
//
//   ext-mcpc-01  接口级（不依赖 UI）：mcp-compare 只读且不外泄；未选择仍冲突；keepExisting 空计划；adoptNew 替换；operation.restore 还原。
//                依赖后端分支 feat/0.7-pr12-mcp-conflict；当前构建没有 `mcpConflictCompare` 能力时自动标为已知缺陷，
//                后端合入后会「意外通过」，提醒维护者无需再改任何标记。
//   ext-mcpc-02  UI 桩：导入 JSON 遇到同 ID 时可对比、可逐项选择「用导入的替换 / 保留现有」。**需要新 UI**（Iris 的 0.7 前端）；
//                UI 落地后按真实选择器修正，再移除 expectedFail。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extensionsCapability } from '../../core/extensions-contracts.js';
import { FIXTURE_SECRET } from '../fixture.mjs';
import { clickAdd, addDisabled, addItemVisible } from '../add-menu.mjs';

// UI 用例（ext-mcpc-02、ext-pr12-*）自门控：构建里没有 PR-12 前端（public/extensions/mcp-conflict.js），或后端没有把
// capabilities.extensions.mcpConflictCompare:true 镜像进 /api/extensions/state（extensions/service.mjs），就标 expectedFail；
// 两者都有后自动变为必须通过，不需要手动改标记。
const built = file => { try { return fs.readFileSync(fileURLToPath(new URL('../../' + file, import.meta.url)), 'utf8'); } catch { return ''; } };
const HAS_UI = built('public/extensions/mcp-conflict.js') !== '', HAS_MIRROR = /mcpConflictCompare:\s*true/.test(built('extensions/service.mjs')) || /extensionsMirrorKeys\s*=[^;]*mcpConflictCompare/.test(built('core/extensions-contracts.js'));   // #34 5cca619 起镜像键由 extensionsMirrorKeys 一份清单生成
const UI_GATE = HAS_UI && HAS_MIRROR ? {} : { expectedFail: !HAS_UI ? 'PR-12 需要新 UI（public/extensions/mcp-conflict.js 未合入）：导入 JSON 的同 ID 对比与逐项选择，合入后自动变为必须通过' : '后端 /api/extensions/state 的 capabilities 镜像没有 extensions.mcpConflictCompare:true（#34 缺一行）：补上后自动变为必须通过' };

const hasBackend = typeof extensionsCapability.mcpConflictCompare === 'string';
const BACKEND_GATE = hasBackend ? {} : { expectedFail: 'PR-12 后端未包含在此构建（需要 feat/0.7-pr12-mcp-conflict）：合入后自动变为必须通过' };
const json = response => JSON.parse(response.text);
const mcp = servers => JSON.stringify({ mcpServers: servers });
const servers = async fixture => json(await fixture.api('/api/extensions/state')).servers.filter(item => item.scope !== 'client');
async function applyAction(fixture, action) {
  const plan = await fixture.api('/api/extensions/prepare', { action });
  if (plan.status !== 200) return { plan, applied: null };
  const body = json(plan);
  const applied = await fixture.api('/api/extensions/actions', { requestId: crypto.randomUUID(), expectedVersion: body.expectedVersion, planId: body.planId, action: body.normalizedAction });
  return { plan, body, applied };
}

export default [
  { id: 'ext-mcpc-01', priority: 'P0', widths: [1440], ...BACKEND_GATE, title: 'PR-12 接口：同 ID 对比只读不泄密；keepExisting；adoptNew 后 operation.restore 还原', async run({ fixture, assert: check }) {
    const before = await servers(fixture), original = before.find(item => item.id === 'missing-env-mcp');
    const version = json(await fixture.api('/api/extensions/state')).version;
    const incoming = { 'missing-env-mcp': { command: 'npx', args: ['-y', 'replacement'], env: { E2E_OTHER_TOKEN: '${E2E_OTHER_TOKEN}' } }, 'github-remote': { url: 'http://127.0.0.1:9/mcp', headers: { Authorization: '${E2E_GITHUB_AUTH}' } }, 'brand-new': { command: 'node' } };
    // compare: read-only, redacted, refs and refStatus only
    const compared = await fixture.api('/api/extensions/mcp-compare', { scope: 'shared', json: mcp(incoming), expectedVersion: version });
    check.equal(compared.status, 200, 'mcp-compare 状态码');
    check.ok(!compared.text.includes(FIXTURE_SECRET), '对比响应不得含凭据值');
    const result = json(compared); check.equal(result.readOnly, true); check.deepEqual(result.newIds, ['brand-new']);
    const item = result.items.find(entry => entry.id === 'missing-env-mcp');
    check.equal(item.identical, false); check.deepEqual(item.existing.refs.map(ref => [ref.key, ref.set]), [['E2E_MISSING_TOKEN', false]], '现有引用未设置');
    const remote = result.items.find(entry => entry.id === 'github-remote'); check.deepEqual(remote.existing.refs.map(ref => ref.set), [true], '已设置的引用只给 set:true');
    check.equal(json(await fixture.api('/api/extensions/state')).version, version, '对比不得改变任何文件');
    check.equal((await fixture.api('/api/extensions/mcp-compare', { scope: 'shared', json: mcp(incoming), expectedVersion: 'stale' })).status, 409, '过期 expectedVersion');
    check.equal((await fixture.api('/api/extensions/mcp-compare', { scope: 'shared', json: mcp({ x: { command: 'node', env: { TOKEN: FIXTURE_SECRET } } }) })).status, 400, '明文凭据照旧被拒绝');
    // unresolved ids stay conflicts
    const unresolved = await applyAction(fixture, { type: 'mcp.importJson', scope: 'shared', json: mcp(incoming) });
    check.ok(unresolved.body.conflicts.length >= 2, '未选择处理方式仍是冲突'); check.equal(unresolved.applied.status, 409);
    // keepExisting + keepExisting: new id imported, nothing replaced
    const kept = await applyAction(fixture, { type: 'mcp.importJson', scope: 'shared', json: mcp({ 'missing-env-mcp': incoming['missing-env-mcp'] }), resolutions: { 'missing-env-mcp': 'keepExisting' } });
    check.equal(kept.applied.status, 200, 'keepExisting 可提交（空计划）'); check.equal(kept.body.files.length, 0);
    check.equal((await servers(fixture)).find(entry => entry.id === 'missing-env-mcp').command, original.command, 'keepExisting 不改配置');
    // adoptNew + restore
    const adopted = await applyAction(fixture, { type: 'mcp.importJson', scope: 'shared', json: mcp(incoming), resolutions: { 'missing-env-mcp': 'adoptNew', 'github-remote': 'keepExisting' } });
    check.equal(adopted.applied.status, 200, 'adoptNew 提交');
    check.ok(!adopted.plan.text.includes(FIXTURE_SECRET) && !adopted.applied.text.includes(FIXTURE_SECRET), 'adoptNew 不回显凭据');
    let now = await servers(fixture);
    check.equal(now.find(entry => entry.id === 'missing-env-mcp').command, 'npx'); check.ok(now.some(entry => entry.id === 'brand-new'), '新 ID 一并导入');
    const restored = await applyAction(fixture, { type: 'operation.restore', operationId: json(adopted.applied).operationId });
    check.equal(restored.applied.status, 200, '恢复');
    now = await servers(fixture);
    check.equal(now.find(entry => entry.id === 'missing-env-mcp').command, original.command, '恢复后回到原配置'); check.ok(!now.some(entry => entry.id === 'brand-new'), '恢复同时撤销本次新增');
  } },
  { id: 'ext-mcpc-02', priority: 'P1', widths: [1440], ...UI_GATE, title: '导入 JSON 遇到同 ID：可对比，逐项选择「用导入的替换 / 保留现有」，对比只读且不泄密', async run({ page, url, fixture, assert: check }) {
    await page.goto(`${url}/#extensions&tab=mcp`); await page.locator('.extension-row').first().waitFor({ timeout: 10000 });
    await clickAdd(page, '导入 JSON');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill(mcp({ 'missing-env-mcp': { command: 'npx', args: ['-y', 'replacement'] } }));
    await dialog.getByRole('button', { name: /预览|下一步/ }).click();
    await dialog.getByRole('button', { name: /对比/ }).waitFor();
    check.ok(/已存在|冲突/.test(await dialog.textContent()), '应写明同 ID 冲突');
    check.equal(await dialog.getByRole('button', { name: /应用导入/ }).isDisabled(), true, '没有选择前不能应用');
    const versionBefore = json(await fixture.api('/api/extensions/state')).version;
    await dialog.getByRole('button', { name: /对比/ }).click();
    await dialog.locator('[data-mcp-compare-item]').waitFor();
    check.equal(json(await fixture.api('/api/extensions/state')).version, versionBefore, '「对比」必须只读');
    check.ok(/npx/.test(await dialog.locator('[data-mcp-compare-item]').textContent()), '对比里有导入的命令');
    for (const name of [/用导入的替换/, /保留现有/]) check.ok(await dialog.getByRole('radio', { name }).count() > 0, `缺少选项：${name}`);
    check.equal(await dialog.getByRole('radio', { checked: true }).count(), 0, '默认不选');
    check.ok(!(await page.content()).includes(FIXTURE_SECRET), '页面不得出现凭据值');
  } },
  { id: 'ext-pr12-01', priority: 'P0', widths: [1440], ...UI_GATE, title: '导入 JSON：逐项选择（替换 + 保留）→ 替换二次确认（返回不改动）→ 应用 → toast「撤销」还原', async run({ page, url, fixture, assert: check }) {
    const incoming = { 'missing-env-mcp': { command: 'npx', args: ['-y', 'replacement'], env: { E2E_OTHER_TOKEN: '${E2E_OTHER_TOKEN}' } }, 'github-remote': { url: 'http://127.0.0.1:9/mcp', headers: { Authorization: '${E2E_GITHUB_AUTH}' } }, 'brand-new': { command: 'node' } };
    const original = (await servers(fixture)).find(item => item.id === 'missing-env-mcp'), remoteBefore = (await servers(fixture)).find(item => item.id === 'github-remote');
    await page.goto(`${url}/#extensions`); await page.locator('.extension-row').first().waitFor({ timeout: 10000 });
    check.equal(await addItemVisible(page, '导入 JSON'), false, 'Skill 页签不显示「导入 JSON…」');
    await page.goto(`${url}/#extensions&tab=mcp`); await page.locator('.extension-row').first().waitFor({ timeout: 10000 });
    check.equal(await addItemVisible(page, '导入 JSON'), true, 'MCP 页签显示「导入 JSON…」');
    await clickAdd(page, '导入 JSON');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill(mcp(incoming)); await dialog.getByRole('button', { name: /预览|下一步/ }).click();
    await dialog.getByRole('button', { name: /应用导入/ }).waitFor();
    const apply = dialog.getByRole('button', { name: /应用导入/ });
    check.equal(await apply.isDisabled(), true, '一个都没选');
    const group = id => dialog.locator('fieldset').filter({ hasText: id });
    await group('missing-env-mcp').getByRole('radio', { name: /用导入的替换/ }).check();
    check.equal(await apply.isDisabled(), true, '还差 github-remote 没选');
    await group('github-remote').getByRole('radio', { name: /保留现有/ }).check();
    await page.waitForFunction(() => !document.querySelector('[data-import-apply]')?.disabled, null, { timeout: 8000 }).catch(() => {});
    check.equal(await apply.isDisabled(), false, '都选了才能应用');
    await group('github-remote').getByRole('button', { name: /对比/ }).click();
    await dialog.locator('[data-mcp-compare-item]').first().waitFor();
    const compared = await dialog.textContent(); check.ok(!compared.includes(FIXTURE_SECRET), '对比里没有凭据值'); check.ok(/已设置/.test(compared), '引用只写已设置 / 未设置');
    await apply.click();
    await dialog.getByRole('button', { name: /确认替换/ }).waitFor();
    check.ok(/可经操作历史撤销/.test(await dialog.textContent()), '确认里写明可撤销');
    check.equal((await servers(fixture)).find(item => item.id === 'missing-env-mcp').command, original.command, '确认前不改配置');
    await dialog.getByRole('button', { name: '返回' }).click();
    check.equal((await servers(fixture)).find(item => item.id === 'missing-env-mcp').command, original.command, '返回不改配置');
    await apply.click(); await dialog.getByRole('button', { name: /确认替换/ }).click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 8000 });
    let now = await servers(fixture);
    check.equal(now.find(item => item.id === 'missing-env-mcp').command, 'npx', '已替换'); check.ok(now.some(item => item.id === 'brand-new'), '新 ID 一并导入');
    check.deepEqual(now.find(item => item.id === 'github-remote').url, remoteBefore.url, '保留现有不改');
    await page.locator('.ui-toast').getByRole('button', { name: '撤销' }).click();
    await page.locator('dialog[open]').getByRole('button', { name: /撤销变更/ }).click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 8000 });
    now = await servers(fixture);
    check.equal(now.find(item => item.id === 'missing-env-mcp').command, original.command, '撤销后回到原配置'); check.ok(!now.some(item => item.id === 'brand-new'), '撤销同时去掉新增');
    check.ok(!(await page.content()).includes(FIXTURE_SECRET), '页面不得出现凭据值');
  } },
  { id: 'ext-pr12-02', priority: 'P1', widths: [1440], ...UI_GATE, title: '导入 JSON：全部选「保留现有」不需要二次确认，不改任何文件', async run({ page, url, fixture, assert: check }) {
    const before = JSON.stringify(await servers(fixture));
    await page.goto(`${url}/#extensions&tab=mcp`); await page.locator('.extension-row').first().waitFor({ timeout: 10000 });
    await clickAdd(page, '导入 JSON');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill(mcp({ 'missing-env-mcp': { command: 'npx', args: ['-y', 'keep-me-out'] } })); await dialog.getByRole('button', { name: /预览|下一步/ }).click();
    await dialog.getByRole('radio', { name: /保留现有/ }).check();
    await dialog.getByRole('button', { name: /应用导入/ }).click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 8000 });
    check.equal(JSON.stringify(await servers(fixture)), before, '保留现有不改任何配置');
  } },
  { id: 'ext-pr12-03', priority: 'P0', widths: [1440], ...UI_GATE, title: '后端没有 mcpConflictCompare 能力：只显示文字冲突，没有「对比」和选择，不能应用', async run({ page, url, fixture, assert: check }) {
    await page.route(/\/api\/extensions\/(state|refresh)(\?.*)?$/, async route => { const response = await route.fetch(); const body = await response.json(); if (body.capabilities?.extensions) delete body.capabilities.extensions.mcpConflictCompare; await route.fulfill({ response, json: body }); });
    await page.goto(`${url}/#extensions&tab=mcp`); await page.locator('.extension-row').first().waitFor({ timeout: 10000 });
    await clickAdd(page, '导入 JSON');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill(mcp({ 'missing-env-mcp': { command: 'npx' } })); await dialog.getByRole('button', { name: /预览|下一步/ }).click();
    await dialog.getByText(/已存在/).first().waitFor();
    check.equal(await dialog.getByRole('button', { name: /对比/ }).count(), 0, '没有「对比」'); check.equal(await dialog.getByRole('radio').count(), 0, '没有选择');
    check.equal(await dialog.getByRole('button', { name: /应用导入/ }).count() === 0 || await dialog.getByRole('button', { name: /应用导入/ }).isDisabled(), true, '不能应用');
  } },
  { id: 'ext-pr12-04', priority: 'P0', widths: [1440], ...UI_GATE, title: '新建 MCP 同 ID：服务端 409 后出现对比与选择；保留现有不改，用新填写的替换需二次确认且可撤销', async run({ page, url, fixture, assert: check }) {
    const dialog = page.locator('dialog[open]'), original = (await servers(fixture)).find(item => item.id === 'missing-env-mcp');
    await page.goto(`${url}/#extensions&tab=mcp`); await page.locator('.extension-row').first().waitFor({ timeout: 10000 });
    // 新建表单：有警告时会出预览（点应用），没有就直接应用；两种都接受。
    const finish = async () => { await page.waitForFunction(() => !document.querySelector('dialog[open]') || document.querySelector('dialog[open] [data-preview-apply], dialog[open] [data-batch-apply]'), null, { timeout: 8000 }); const apply = dialog.locator('[data-preview-apply], [data-batch-apply]').first(); if (await apply.count()) await apply.click(); await page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 8000 }); };
    const fill = async () => { await clickAdd(page, '新建 MCP 服务'); await dialog.getByLabel('稳定 ID', { exact: true }).fill('missing-env-mcp'); await dialog.getByLabel('服务名称', { exact: true }).fill('替换用'); await dialog.getByLabel('可执行命令', { exact: true }).fill('npx'); await dialog.locator('form button[type="submit"]').first().click(); };
    await fill(); await dialog.locator('[data-duplicate-panel] input[type="radio"]').first().waitFor();
    check.ok(await dialog.getByRole('radio', { name: /用新填写的替换/ }).count() > 0 && await dialog.getByRole('radio', { name: /保留现有/ }).count() > 0, '有两个选择');
    check.equal(await dialog.getByRole('button', { name: /按所选继续/ }).isDisabled(), true, '没选不能继续');
    check.equal((await servers(fixture)).find(item => item.id === 'missing-env-mcp').command, original.command, '服务端 409 不写盘');
    await dialog.getByRole('radio', { name: /保留现有/ }).check(); await dialog.getByRole('button', { name: /按所选继续/ }).click();
    await finish();
    check.equal((await servers(fixture)).find(item => item.id === 'missing-env-mcp').command, original.command, '保留现有不改配置');
    const keptToast = page.locator('.ui-toast').filter({ hasText: /已保留现有配置/ });
    check.match(await keptToast.innerText(), /missing-env-mcp/, '回执写现有那条的 ID'); check.equal(await keptToast.getByRole('button', { name: '撤销' }).count(), 0, '没改任何文件，不给撤销');
    await fill(); await dialog.locator('[data-duplicate-panel] input[type="radio"]').first().waitFor();
    await dialog.getByRole('radio', { name: /用新填写的替换/ }).check(); await dialog.getByRole('button', { name: /按所选继续/ }).click();
    await dialog.getByRole('button', { name: /确认替换/ }).waitFor();
    check.ok(/可经操作历史撤销/.test(await dialog.textContent()), '确认里写明可撤销');
    check.equal((await servers(fixture)).find(item => item.id === 'missing-env-mcp').command, original.command, '确认前不改配置');
    await dialog.getByRole('button', { name: /确认替换/ }).click();
    await finish();
    check.equal((await servers(fixture)).find(item => item.id === 'missing-env-mcp').command, 'npx', '已替换');
    await page.locator('.ui-toast').filter({ hasText: /已替换/ }).getByRole('button', { name: '撤销' }).click(); await dialog.getByRole('button', { name: /撤销变更/ }).click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 8000 });
    check.equal((await servers(fixture)).find(item => item.id === 'missing-env-mcp').command, original.command, '撤销后回到原配置');
  } },
];
