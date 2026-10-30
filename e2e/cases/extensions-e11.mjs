// E-11 (MCP/Skill 接入冲突处理：对比差异 / 采用共享版本 / 保留软件内版本)。liki 2026-10-30 决定进入 0.7。
// 夹具冲突：共享 `api-design` 与 Qoder 的同名真实目录（fixture-v1 自带）。
//
//   ext-conflict-01  接口级（不依赖 UI）：compare 只读且不外泄凭据；keepLocal / reopen；adoptShared 后 operation.restore 还原。
//                    依赖后端分支 feat/0.7-e11-conflict-resolution；当前构建没有 `skill.resolveConflict` 时自动标为已知缺陷，
//                    后端合入后会「意外通过」，提醒维护者无需再改任何标记。
//   ext-sk-07        UI：冲突位置的开关禁用并写明原因；检查器里三个冲突动作可达；「对比差异」只读；冲突处理不进暂存模型（PR-6：开关只暂存，底栏批量应用）。
//                    需要 0.7 扩展页 E-11 前端（public/extensions/conflict.js）：构建里没有它时自动标为已知缺陷，有它时必须通过。
//   ext-pr11-01..08  E-11 前端用例（对比视图、保留 / 重新处理、采用共享 + 撤销、与暂存的关系、已变化、前端脱敏、窄屏、禁用原因）。同样自门控。
import path from 'node:path';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extensionActions } from '../../core/extensions-contracts.js';
import { FIXTURE_SECRET } from '../fixture.mjs';
import { horizontalOverflow } from '../a11y.mjs';

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

const apiCases = [
  { id: 'ext-conflict-01', priority: 'P0', widths: [1440], ...BACKEND_GATE, title: 'E-11 接口：对比只读不泄密；保留 / 重新打开；采用共享可恢复', async run({ fixture, assert: check }) {
    const dir = path.join(fixture.roots.qoder, 'skills/api-design');
    await fsp.writeFile(path.join(dir, '.env'), 'TOKEN=' + FIXTURE_SECRET + '\n');
    await fsp.appendFile(path.join(dir, 'SKILL.md'), 'api_key = ' + FIXTURE_SECRET + '\n');
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
    check.ok((await fsp.readFile(path.join(dir, '.env'), 'utf8')).includes(FIXTURE_SECRET), '恢复应带回原文件');
  } },
];

// ---- UI（E-11 前端，public/extensions/conflict.js）。自门控：构建里没有该文件就标 expectedFail，有就必须通过；本补丁只改这一个文件，与 index.mjs / extensions-p0.mjs 的其他补丁无冲突。----
const PRESENT = (() => { try { return fs.existsSync(fileURLToPath(new URL('../../public/extensions/conflict.js', import.meta.url))); } catch { return false; } })();
const REASON = '需要 0.7 扩展页 E-11 前端（public/extensions/conflict.js：对比 / 采用 / 保留 / 重新处理）：该前端合入后此标记自动消失';
const SENTINEL = 'sk-SENTINEL1234567890abcdefXYZ';
const dialog = page => page.locator('dialog[open]');
const bar = page => page.locator('[data-staging-bar]');
const toast = page => page.locator('.ui-toast').last();
const inspector = page => page.locator('.extension-detail:not([hidden])');
const panel = page => inspector(page).locator('[data-conflict]');
const gone = page => page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 8000 }).catch(async () => { throw new Error('对话框没有关闭：' + (await page.locator('dialog[open]').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)); });
const confirm = async page => { const button = dialog(page).locator('[data-batch-apply], [data-preview-apply]').first(); await button.waitFor(); await button.click(); };
const rowOf = (page, name) => page.locator('.extension-row').filter({ hasText: name + ' 的示例' });   // 共享那一行（软件内同名目录的行描述不同）
const toList = async page => { const back = page.locator('[data-close-detail]'); if (await back.isVisible().catch(() => false)) await back.click(); };
const sw = (page, name) => page.locator('.extension-list').getByRole('switch', { name, exact: true });
async function open(page, url) { await page.goto(`${url}/#extensions&tab=skills`); await page.locator('.extension-row').first().waitFor({ timeout: 10000 }); }
async function select(page, name) { await toList(page); await rowOf(page, name).locator('[data-extension-id]').first().click(); await inspector(page).locator('h2, h3').first().waitFor(); }
async function need(page) { await panel(page).first().waitFor({ timeout: 8000 }).catch(() => { throw new Error('前置条件：检查器里没有冲突块（需要 E-11 前端）'); }); }
const pressUi = async (page, selector) => { await panel(page).locator(selector).click(); };
const stateOf = (page, state) => inspector(page).locator(`[data-conflict][data-conflict-state="${state}"]`);
const policyText = page => page.evaluate(() => document.body.innerText + document.documentElement.outerHTML);
async function plant(fixture) {   // 共享与软件内各放一份 .env（内容不同，软件内的带凭据），软件内 SKILL.md 带凭据行
  const { skill } = await conflictTarget(fixture), local = path.join(fixture.roots.qoder, 'skills/api-design');
  await fsp.writeFile(path.join(local, '.env'), 'TOKEN=' + FIXTURE_SECRET + '\n'); await fsp.writeFile(path.join(skill.sourcePath, '.env'), 'TOKEN=other-value\n');
  await fsp.appendFile(path.join(local, 'SKILL.md'), 'local only line\napi_key = ' + FIXTURE_SECRET + '\n'); await fsp.writeFile(path.join(local, 'extra.md'), '# extra\nLOCAL-ONLY-MARK\n');
  await fixture.api('/api/extensions/refresh', {});   // 扩展状态有缓存：手动改文件后要重新扫描，页面的版本号才和对比一致
  return { skill, local };
}
const unit = (id, title, run, extra = {}) => ({ id, priority: 'P0', widths: [1440], title, run, ...extra });

const uiCases = [
  unit('ext-sk-07', '冲突项：开关禁用并写明原因；三个冲突动作可达；「对比差异」只读且不进暂存（E-11 + PR-6 暂存模型）', async ({ page, url, fixture, assert: check }) => {
    await open(page, url); await select(page, 'api-design'); await need(page);
    const versionBefore = json(await fixture.api('/api/extensions/state')).version;
    const toggle = inspector(page).getByRole('switch', { name: /Qoder/ });
    check.ok(await toggle.isDisabled(), '检查器里冲突位置的开关应禁用');
    check.ok(/冲突/.test(await panel(page).innerText()), '禁用原因以文字写明');
    check.ok(await sw(page, 'api-design · Qoder').isDisabled(), '清单行里冲突位置的开关也禁用');
    for (const name of [/对比差异/, /采用共享版本/, /保留软件内版本/]) check.equal(await panel(page).getByRole('button', { name }).count(), 1, `动作：${name}`);
    check.ok(await panel(page).getByRole('button', { name: /采用共享版本/ }).isEnabled(), '无暂存、Skill 已启用时可点');
    await toggle.click({ force: true, trial: false }).catch(() => {});
    check.ok(!(await bar(page).isVisible()), '点冲突开关不得进暂存（底栏保持隐藏）');
    await panel(page).getByRole('button', { name: /对比差异/ }).click(); await dialog(page).locator('[data-compare-summary]').waitFor();
    check.equal(json(await fixture.api('/api/extensions/state')).version, versionBefore, '「对比差异」必须只读');
    check.ok(!(await bar(page).isVisible()), '对比不进暂存');
    check.ok(!(await policyText(page)).includes(FIXTURE_SECRET), '页面不得出现凭据值');
  }),
  unit('ext-pr11-01', '对比视图：只读、汇总、差异行带符号、被隐藏的文件写原因、凭据不进页面、Esc 关闭且焦点回到触发按钮（E-11 G.1）', async ({ page, url, fixture, assert: check }) => {
    await plant(fixture);
    await open(page, url); await select(page, 'api-design'); await need(page);
    const versionBefore = json(await fixture.api('/api/extensions/state')).version;
    const requests = []; page.on('request', request => { if (request.url().includes('/api/extensions/')) requests.push(request.method() + ' ' + new URL(request.url()).pathname); });
    const trigger = panel(page).getByRole('button', { name: /对比差异/ }); await trigger.focus(); await trigger.click();
    const view = dialog(page); await view.locator('[data-compare-summary]').waitFor();
    const text = await view.innerText();
    check.match(text, /只读对比/); check.match(text, /个文件不同/); check.match(text, /疑似凭据/); check.match(text, /LOCAL-ONLY-MARK|仅软件内有/);
    check.ok(await view.locator('[data-compare-withheld]').count() >= 1, '.env 被标为内容未显示');
    check.ok(await view.locator('[data-op="shared"]').count() && await view.locator('[data-op="local"]').count(), '差异行有 − / +');
    check.equal(await view.locator('[data-op="local"] .extension-compare-sign').first().textContent(), '+', '符号不只靠颜色');
    check.ok(!text.includes(FIXTURE_SECRET) && !text.includes('other-value'), '对比弹窗不含任何凭据值');
    check.ok(!(await policyText(page)).includes(FIXTURE_SECRET), '页面不含凭据值');
    check.deepEqual(requests.filter(item => !item.startsWith('GET')), [], '对比只发 GET');
    check.equal(requests.filter(item => item.includes('/compare')).length, 1, '一次对比一次请求');
    check.equal(json(await fixture.api('/api/extensions/state')).version, versionBefore, '没有任何文件被改');
    check.ok(!(await bar(page).isVisible()), '不进暂存');
    await page.keyboard.press('Escape'); await gone(page);
    check.ok(await trigger.evaluate(element => element === document.activeElement), 'Esc 后焦点回到「对比差异」按钮');
  }),
  unit('ext-pr11-02', '保留软件内版本 → 已保留（行与检查器）→「仅看问题」不再含它 → 重新处理回到未处理；每步有预览确认与回执（E-11 G.2）', async ({ page, url, fixture, assert: check }) => {
    await open(page, url); await select(page, 'api-design'); await need(page);
    await page.locator('[data-problems]').check(); check.ok(await rowOf(page, 'api-design').count(), '未处理的冲突算问题');
    await select(page, 'api-design');
    await pressUi(page, '[data-conflict-keep]'); await dialog(page).waitFor();
    check.match(await dialog(page).innerText(), /不会改动任何文件/); check.match(await dialog(page).innerText(), /保留软件内版本/);
    await dialog(page).locator('[data-preview-cancel]').click(); await gone(page);
    check.equal((await conflictTarget(fixture)).qoder.resolution, null, '取消不改记录');
    await pressUi(page, '[data-conflict-keep]'); await dialog(page).waitFor(); await confirm(page); await gone(page);
    check.match(await toast(page).innerText(), /已保留软件内版本「api-design」/);
    check.equal((await conflictTarget(fixture)).qoder.resolution, 'keepLocal');
    await stateOf(page, 'kept').waitFor();
    check.ok(await panel(page).locator('[data-conflict-reopen]').count() === 1 && await panel(page).locator('[data-conflict-adopt]').count() === 0, '已保留：只剩对比与重新处理');
    check.equal(await rowOf(page, 'api-design').count(), 0, '已保留的冲突不再算问题');
    check.match(await panel(page).innerText(), /已保留/);
    await page.locator('[data-problems]').uncheck(); check.match(await rowOf(page, 'api-design').innerText(), /已保留/, '清单行写出已保留');
    await select(page, 'api-design'); await pressUi(page, '[data-conflict-reopen]'); await dialog(page).waitFor(); check.match(await dialog(page).innerText(), /重新作为冲突提示/); await confirm(page); await gone(page);
    check.match(await toast(page).innerText(), /已重新标记为待处理/);
    check.equal((await conflictTarget(fixture)).qoder.resolution, null); await stateOf(page, 'open').waitFor();
    await toast(page).getByRole('button', { name: '撤销', exact: true }).click(); await dialog(page).waitFor(); await confirm(page); await gone(page);
    check.equal((await conflictTarget(fixture)).qoder.resolution, 'keepLocal', '撤销「重新处理」回到已保留');
  }),
  unit('ext-pr11-03', '采用共享版本：二次确认（取消不改）→ 已接入 → 回执「撤销」走 operation.restore → 回到冲突且带回原文件；凭据不进页面与操作详情（E-11 G.2）', async ({ page, url, fixture, assert: check }) => {
    const { skill, local } = await plant(fixture);
    await open(page, url); await select(page, 'api-design'); await need(page);
    await pressUi(page, '[data-conflict-adopt]'); await dialog(page).waitFor();
    const text = await dialog(page).innerText();
    check.match(text, /替换/); check.match(text, /撤销/); check.ok(!text.includes(FIXTURE_SECRET), '预览不含凭据');
    check.ok(await dialog(page).locator('[data-preview-apply].ui-button-danger').count() === 1, '确认按钮是破坏性样式');
    await dialog(page).locator('[data-preview-cancel]').click(); await gone(page);
    check.equal((await conflictTarget(fixture)).qoder.state, 'conflict', '取消后文件不变');
    await pressUi(page, '[data-conflict-adopt]'); await dialog(page).waitFor(); await confirm(page); await gone(page);
    check.match(await toast(page).innerText(), /已采用共享版本「api-design」/);
    const { qoder } = await conflictTarget(fixture); check.equal(qoder.state, 'managed', '采用后是 Daylight 管理的链接');
    await page.waitForFunction(() => !document.querySelector('[data-conflict]'), null, { timeout: 8000 });
    const operation = (await policyText(page)); check.ok(!operation.includes(FIXTURE_SECRET), '页面不含凭据');
    await page.locator('[data-extension-refresh]').first().click().catch(() => {});
    await toast(page).getByRole('button', { name: '撤销', exact: true }).click(); await dialog(page).waitFor();
    check.match(await dialog(page).innerText(), /撤销/); check.ok(!(await dialog(page).innerText()).includes(FIXTURE_SECRET), '撤销预览不含凭据'); await confirm(page); await gone(page);
    check.equal((await conflictTarget(fixture)).qoder.state, 'conflict', '撤销后回到冲突');
    check.ok((await fsp.readFile(path.join(local, '.env'), 'utf8')).includes(FIXTURE_SECRET), '原 .env 带回');
    check.ok((await fsp.readFile(path.join(local, 'extra.md'), 'utf8')).includes('LOCAL-ONLY-MARK'), '原文件带回');
    await panel(page).first().waitFor();
    check.ok(!(await policyText(page)).includes(FIXTURE_SECRET), '撤销后页面仍不含凭据');
  }),
  unit('ext-pr11-04', '与暂存互不干扰：冲突处理不清暂存；总开关有暂存时采用 / 保留置灰并写原因（E-11 × PR-6）', async ({ page, url, fixture, assert: check }) => {
    await open(page, url);
    await sw(page, 'review-code · Codex').click(); await bar(page).waitFor(); check.match(await bar(page).innerText(), /1 项待应用的变更/);
    await select(page, 'api-design'); await need(page);
    check.ok(await bar(page).isVisible(), '选中另一项后暂存仍在');
    await pressUi(page, '[data-conflict-keep]'); await dialog(page).waitFor(); await confirm(page); await gone(page);
    check.equal((await conflictTarget(fixture)).qoder.resolution, 'keepLocal');
    check.match(await bar(page).innerText(), /1 项待应用的变更/, '冲突处理不清暂存');
    check.equal(await sw(page, 'review-code · Codex').isChecked(), true, '暂存的开关值保留');
    check.equal(json(await fixture.api('/api/extensions/state')).skills.find(item => item.name === 'review-code').bindings.find(item => item.clientId === 'codex').state, 'not_connected', '暂存项没有被偷偷应用');
    await pressUi(page, '[data-conflict-reopen]'); await dialog(page).waitFor(); await confirm(page); await gone(page);
    // 总开关暂存 → 采用 / 保留置灰
    await bar(page).getByRole('button', { name: /还原/ }).click().catch(() => {}); await page.waitForTimeout(200);
    await sw(page, 'api-design · 启用').click(); await bar(page).waitFor();
    await select(page, 'api-design'); await panel(page).first().waitFor();
    check.ok(await panel(page).locator('[data-conflict-adopt]').isDisabled() && await panel(page).locator('[data-conflict-keep]').isDisabled(), '总开关有暂存：采用 / 保留置灰');
    check.match(await panel(page).innerText(), /已暂存总开关变更/, '原因写在块里');
    check.ok(await panel(page).locator('[data-conflict-compare]').isEnabled(), '对比不受限');
  }),
  unit('ext-pr11-05', '已变化：保留后软件内版本又变了 → 重新扫描显示「已变化」，算问题，可再处理（E-11 G.3）', async ({ page, url, fixture, assert: check }) => {
    const { skill } = await conflictTarget(fixture);
    const kept = await applyAction(fixture, { type: 'skill.resolveConflict', id: skill.id, clientId: 'qoder', resolution: 'keepLocal' }); check.equal(kept.applied.status, 200);
    await open(page, url); await select(page, 'api-design'); await stateOf(page, 'kept').waitFor();
    await fsp.appendFile(path.join(fixture.roots.qoder, 'skills/api-design/SKILL.md'), 'changed after keeping\n');
    await page.locator('[data-extension-refresh]').first().click(); await stateOf(page, 'stale').waitFor({ timeout: 10000 });
    check.match(await panel(page).innerText(), /已经变了|已变化/); check.equal(await panel(page).locator('[data-conflict-adopt]').count(), 1, '可再次处理');
    await page.locator('[data-problems]').check(); check.ok(await rowOf(page, 'api-design').count(), '已变化算问题'); await page.locator('[data-problems]').uncheck();
    await select(page, 'api-design'); await pressUi(page, '[data-conflict-keep]'); await dialog(page).waitFor(); await confirm(page); await gone(page);
    await stateOf(page, 'kept').waitFor();
  }),
  unit('ext-pr11-06', '前端再脱敏：响应里漏出的凭据行、被隐藏文件带的 diff、恶意文本都不进 DOM；409 给人话并刷新（G.1 不泄露）', async ({ page, url, fixture, assert: check }) => {
    await open(page, url); await select(page, 'api-design'); await need(page);
    const { skill } = await conflictTarget(fixture);
    const reply = { id: skill.id, clientId: 'qoder', clientName: 'Qoder', version: 'x', shared: { path: skill.sourcePath }, local: { path: '/tmp/qoder/skills/api-design', kind: 'directory' }, readOnly: true, compared: true, localKind: 'directory', summary: { same: 0, different: 2, onlyShared: 0, onlyLocal: 0, typeDiffers: 0, unknown: 0, withheld: 1, redactedLines: 0 }, truncated: false, ignored: 0, identical: false,
      files: [{ path: 'SKILL.md', status: 'different', diff: [{ sharedStart: 1, localStart: 1, lines: [{ op: 'local', text: 'api_key = ' + SENTINEL }, { op: 'local', text: '<img src=x onerror="window.__pwned=1">' }, { op: 'same', text: 'ok line' }] }] },
        { path: '.env', status: 'different', withheld: 'sensitive', diff: [{ sharedStart: 1, localStart: 1, lines: [{ op: 'local', text: 'BOGUS-BODY-LINE' }] }] }] };
    let mode = 'ok';
    await page.route(/\/api\/extensions\/compare\?/, route => mode === 'ok' ? route.fulfill({ status: 200, json: reply }) : route.fulfill({ status: 409, json: { error: '该位置没有冲突，不需要对比。', code: 'EXTENSIONS_NOT_CONFLICT' } }));
    await panel(page).getByRole('button', { name: /对比差异/ }).click(); await dialog(page).locator('[data-compare-summary]').waitFor();
    const text = await dialog(page).innerText(), html = await dialog(page).innerHTML();
    check.ok(!text.includes(SENTINEL) && !html.includes(SENTINEL), '漏出的凭据行不渲染'); check.match(text, /已隐藏：疑似凭据/);
    check.ok(!text.includes('BOGUS-BODY-LINE') && !html.includes('BOGUS-BODY-LINE'), '被隐藏的文件不渲染正文（含折叠起来的 DOM）'); check.ok(!html.includes('<img'), 'HTML 被转义'); check.equal(await page.evaluate(() => window.__pwned), undefined);
    check.match(text, /ok line/);
    await dialog(page).locator('[data-compare-close]').click(); await gone(page);
    mode = 'conflict'; await panel(page).getByRole('button', { name: /对比差异/ }).click(); await dialog(page).locator('[data-compare-error]').waitFor();
    check.match(await dialog(page).innerText(), /已经没有冲突/); check.equal(await dialog(page).locator('[data-compare-error]').getAttribute('role'), 'alert');
  }),
  unit('ext-pr11-07', '窄屏 760：检查器盖住清单时，冲突块、对比弹窗与采用确认都不横向溢出；关闭后焦点回到按钮', async ({ page, url, fixture, assert: check }) => {
    await plant(fixture); await open(page, url); await select(page, 'api-design'); await need(page);
    await panel(page).scrollIntoViewIfNeeded();
    const trigger = panel(page).getByRole('button', { name: /对比差异/ }); await trigger.click(); await dialog(page).locator('[data-compare-summary]').waitFor();
    const box = await dialog(page).boundingBox(); check.ok(box.x >= 0 && box.x + box.width <= 760, '对比弹窗在视口内');
    check.ok(!(await dialog(page).evaluate(element => element.scrollWidth > element.clientWidth + 1)), '对比弹窗无横向滚动');
    check.ok(!(await horizontalOverflow(page)).overflow, '页面无横向溢出');
    await page.keyboard.press('Escape'); await gone(page);
    check.ok(await trigger.evaluate(element => element === document.activeElement), '焦点回到按钮');
    await pressUi(page, '[data-conflict-adopt]'); await dialog(page).waitFor();
    const adopt = await dialog(page).boundingBox(); check.ok(adopt.x >= 0 && adopt.x + adopt.width <= 760, '采用确认在视口内');
    await dialog(page).locator('[data-preview-cancel]').click(); await gone(page);
  }, { widths: [760] }),
  unit('ext-pr11-08', '禁用原因：Skill 已停用时只挡「采用」（写明原因），「保留」「对比」仍可用；后端 EXTENSIONS_SKILL_DISABLED 也有人话', async ({ page, url, fixture, assert: check }) => {
    const { skill } = await conflictTarget(fixture);
    const off = await applyAction(fixture, { type: 'skill.disable', id: skill.id }); check.equal(off.applied.status, 200, '停用 api-design');
    await open(page, url); await select(page, 'api-design'); await need(page);
    check.ok(await panel(page).locator('[data-conflict-adopt]').isDisabled(), '已停用时采用置灰');
    check.match(await panel(page).innerText(), /已停用，启用后才能采用共享版本/);
    check.ok(await panel(page).locator('[data-conflict-keep]').isEnabled() && await panel(page).locator('[data-conflict-compare]').isEnabled(), '保留与对比可用');
    const refused = await applyAction(fixture, { type: 'skill.resolveConflict', id: skill.id, clientId: 'qoder', resolution: 'adoptShared' });
    check.equal(refused.plan.status, 409); check.match(refused.plan.text, /EXTENSIONS_SKILL_DISABLED/);
  }),
];
const ui = PRESENT ? uiCases : uiCases.map(item => ({ ...item, expectedFail: REASON }));
export default [...apiCases, ...ui];
