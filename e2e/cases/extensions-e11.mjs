// E-11 (MCP/Skill 接入冲突处理：对比差异 / 采用共享版本 / 保留软件内版本)。liki 2026-10-30 决定进入 0.7。
// 夹具冲突：共享 `api-design` 与 Qoder 的同名真实目录（fixture-v1 自带）。
//
//   ext-conflict-01  接口级（不依赖 UI）：compare 只读且不外泄凭据；keepLocal / reopen；adoptShared 后 operation.restore 还原。
//                    依赖后端分支 feat/0.7-e11-conflict-resolution；当前构建没有 `skill.resolveConflict` 时自动标为已知缺陷，
//                    后端合入后会「意外通过」，提醒维护者无需再改任何标记。
//   ext-sk-07        UI 桩：检查器里三个冲突动作可达，「对比差异」只读（test-plan ext-sk-07）。
//                    **需要新 UI**（Iris 的 0.7 前端）；在此之前固定标为已知缺陷。UI 合入后：按真实选择器修正，再移除 expectedFail。
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { extensionActions } from '../../core/extensions-contracts.js';
import { FIXTURE_SECRET } from '../fixture.mjs';

const hasBackend = extensionActions.includes('skill.resolveConflict');
const BACKEND_GATE = hasBackend ? {} : { expectedFail: 'E-11 后端未包含在此构建（需要 feat/0.7-e11-conflict-resolution）：合入后自动变为必须通过' };
const json = response => JSON.parse(response.text);
const rows = page => page.locator('.extension-row');

async function conflictTarget(fixture) {
  const state = json(await fixture.api('/api/extensions/state'));
  const skill = state.skills.find(item => item.name === 'api-design' && item.scope === 'shared');
  return { state, skill, qoder: skill.bindings.find(item => item.clientId === 'qoder') };
}
// prepare → apply with the plan's own expectedVersion / planId, like the web client.
async function applyAction(fixture, action) {
  const plan = await fixture.api('/api/extensions/prepare', { action });
  if (plan.status !== 200) return { plan, applied: null };
  const body = json(plan);
  const applied = await fixture.api('/api/extensions/actions', { requestId: crypto.randomUUID(), expectedVersion: body.expectedVersion, planId: body.planId, action: body.normalizedAction });
  return { plan, applied };
}

export default [
  { id: 'ext-conflict-01', priority: 'P0', widths: [1440], ...BACKEND_GATE, title: 'E-11 接口：对比只读不泄密；保留 / 重新打开；采用共享可恢复', async run({ fixture, assert: check }) {
    const dir = path.join(fixture.roots.qoder, 'skills/api-design');
    await fs.writeFile(path.join(dir, '.env'), 'TOKEN=' + FIXTURE_SECRET + '\n');
    await fs.appendFile(path.join(dir, 'SKILL.md'), 'api_key = ' + FIXTURE_SECRET + '\n');
    const { skill, qoder } = await conflictTarget(fixture);
    check.equal(qoder.state, 'conflict', '夹具应有 Qoder 冲突');
    const versionBefore = json(await fixture.api('/api/extensions/state')).version;
    // compare: read-only and redacted
    const compared = await fixture.api(`/api/extensions/compare?id=${skill.id}&clientId=qoder&expectedVersion=${versionBefore}`);
    check.equal(compared.status, 200, 'compare 状态码');
    check.ok(!compared.text.includes(FIXTURE_SECRET), 'compare 响应不得含凭据值');
    check.equal(json(compared).readOnly, true);
    check.equal(json(await fixture.api('/api/extensions/state')).version, versionBefore, 'compare 不得改变任何文件');
    check.equal((await fixture.api(`/api/extensions/compare?id=${skill.id}&clientId=qoder&expectedVersion=stale`)).status, 409, '过期 expectedVersion');
    // keepLocal clears the problem, reopen brings it back
    const kept = await applyAction(fixture, { type: 'skill.resolveConflict', id: skill.id, clientId: 'qoder', resolution: 'keepLocal' });
    check.equal(kept.applied.status, 200, 'keepLocal 提交');
    check.ok(!kept.plan.text.includes(FIXTURE_SECRET) && !kept.applied.text.includes(FIXTURE_SECRET), 'keepLocal 不回显凭据');
    let now = await conflictTarget(fixture);
    check.equal(now.qoder.resolution, 'keepLocal');
    check.ok(!now.state.diagnostics.some(item => item.code === 'BINDING_CONFLICT' && item.id === skill.id && item.clientId === 'qoder'), '已处理的冲突不再作为问题');
    check.equal((await applyAction(fixture, { type: 'skill.resolveConflict', id: skill.id, clientId: 'qoder', resolution: 'reopen' })).applied.status, 200);
    now = await conflictTarget(fixture); check.equal(now.qoder.resolution, null);
    // adoptShared + restore
    const adopted = await applyAction(fixture, { type: 'skill.resolveConflict', id: skill.id, clientId: 'qoder', resolution: 'adoptShared' });
    check.equal(adopted.applied.status, 200, 'adoptShared 提交');
    check.ok(!adopted.plan.text.includes(FIXTURE_SECRET) && !adopted.applied.text.includes(FIXTURE_SECRET), 'adoptShared 不回显凭据');
    check.equal((await conflictTarget(fixture)).qoder.state, 'managed');
    const restored = await applyAction(fixture, { type: 'operation.restore', operationId: json(adopted.applied).operationId });
    check.equal(restored.applied.status, 200, '恢复');
    check.equal((await conflictTarget(fixture)).qoder.state, 'conflict', '恢复后回到冲突');
    check.ok((await fs.readFile(path.join(dir, '.env'), 'utf8')).includes(FIXTURE_SECRET), '恢复应带回原文件');
  } },
  { id: 'ext-sk-07', priority: 'P0', widths: [1440], expectedFail: 'E-11 需要新 UI（Iris 的 0.7 前端未合入）：检查器冲突动作与禁用原因；UI 落地后按真实选择器修正并移除此标记', title: '冲突项：开关禁用并写明原因；三个冲突动作可达；「对比差异」只读（E-11）', async run({ page, url, fixture, assert: check }) {
    await page.goto(`${url}/#extensions&tab=skills`); await rows(page).first().waitFor({ timeout: 10000 });
    await rows(page).filter({ hasText: 'api-design' }).first().click();
    const inspector = page.locator('.extension-detail:not([hidden])');
    const versionBefore = json(await fixture.api('/api/extensions/state')).version;
    const toggle = inspector.getByRole('switch', { name: /Qoder/ });
    check.ok(await toggle.isDisabled(), '冲突位置的开关应禁用');
    check.ok(/已存在其他内容|冲突/.test(await inspector.textContent()), '禁用原因应以文字写明');
    for (const name of [/对比差异/, /采用共享版本/, /保留软件内版本/]) check.ok(await inspector.getByRole('button', { name }).count() > 0, `缺少动作：${name}`);
    await inspector.getByRole('button', { name: /对比差异/ }).click();
    await page.waitForTimeout(300);
    check.equal(json(await fixture.api('/api/extensions/state')).version, versionBefore, '「对比差异」必须只读');
    check.ok(!(await page.content()).includes(FIXTURE_SECRET), '页面不得出现凭据值');
  } },
];
