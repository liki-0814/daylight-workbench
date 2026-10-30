// PR-12 (MCP 同 ID 冲突处理：对比 / adoptNew / keepExisting)。liki 2026-10-30 决定进入 0.7。
// 夹具冲突：共享 MCP `missing-env-mcp`（凭据引用未设置）与 `github-remote`（头部引用已设置，其值即 FIXTURE_SECRET，绝不能出现在任何响应里）。
//
//   ext-mcpc-01  接口级（不依赖 UI）：mcp-compare 只读且不外泄；未选择仍冲突；keepExisting 空计划；adoptNew 替换；operation.restore 还原。
//                依赖后端分支 feat/0.7-pr12-mcp-conflict；当前构建没有 `mcpConflictCompare` 能力时自动标为已知缺陷，
//                后端合入后会「意外通过」，提醒维护者无需再改任何标记。
//   ext-mcpc-02  UI 桩：导入 JSON 遇到同 ID 时可对比、可逐项选择「用导入的替换 / 保留现有」。**需要新 UI**（Iris 的 0.7 前端）；
//                UI 落地后按真实选择器修正，再移除 expectedFail。
import { extensionsCapability } from '../../core/extensions-contracts.js';
import { FIXTURE_SECRET } from '../fixture.mjs';

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
  { id: 'ext-mcpc-02', priority: 'P1', widths: [1440], expectedFail: 'PR-12 需要新 UI（Iris 的 0.7 前端未合入）：导入 JSON 的同 ID 对比与逐项选择；UI 落地后按真实选择器修正并移除此标记', title: '导入 JSON 遇到同 ID：可对比，逐项选择「用导入的替换 / 保留现有」，对比不泄密', async run({ page, url, fixture, assert: check }) {
    await page.goto(`${url}/#extensions&tab=mcp`); await page.locator('.extension-row').first().waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /导入.*JSON/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill(mcp({ 'missing-env-mcp': { command: 'npx', args: ['-y', 'replacement'] } }));
    await dialog.getByRole('button', { name: /预览|下一步/ }).click();
    const versionBefore = json(await fixture.api('/api/extensions/state')).version;
    check.ok(/已存在|冲突/.test(await dialog.textContent()), '应写明同 ID 冲突');
    await dialog.getByRole('button', { name: /对比/ }).click();
    await page.waitForTimeout(300);
    check.equal(json(await fixture.api('/api/extensions/state')).version, versionBefore, '「对比」必须只读');
    for (const name of [/用导入的替换/, /保留现有/]) check.ok(await dialog.getByRole('radio', { name }).count() > 0, `缺少选项：${name}`);
    check.ok(!(await page.content()).includes(FIXTURE_SECRET), '页面不得出现凭据值');
  } },
];
