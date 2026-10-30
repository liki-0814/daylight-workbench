// 0.7 后续项（PR-12 之后）：恢复后常驻「撤销」入口、reveal 补 skill / client、非 macOS 501 提示、PR-12 小问题（处理方式只管一次提交）。
// 自门控：构建里没有 public/extensions/restore-reveal.js（旧 UI）就标 expectedFail，该前端合入后标记自动消失。
// 红线：Mac 上绝不真的触发访达——darwin 时 /reveal 一律用桩；Linux 上不桩，直接验证真实后端的 501。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const built = file => { try { return fs.readFileSync(fileURLToPath(new URL('../../' + file, import.meta.url)), 'utf8'); } catch { return ''; } };
const GATE = built('public/extensions/restore-reveal.js') !== '' ? {} : { expectedFail: '后续项需要新 UI（public/extensions/restore-reveal.js 未合入）：合入后自动变为必须通过' };
const FIX05 = built('public/extensions/page.js').includes('conflictChoice = null;') ? {} : { expectedFail: 'PR-12 小问题修复（e1143a8）未合入：合入后自动变为必须通过' };
const json = response => JSON.parse(response.text);
const rows = page => page.locator('.extension-row');
const open = async (page, url, tab) => { await page.goto(`${url}/#extensions&tab=${tab}`); await rows(page).first().waitFor({ timeout: 10000 }); };
const detail = page => page.locator('.extension-detail:not([hidden])');
const pick = async (page, id) => { await page.locator(`[data-extension-id="${id}"]`).first().click(); await detail(page).waitFor(); await page.waitForFunction(() => !document.querySelector('.extension-detail')?.textContent?.includes('正在读取详情')); };
const rescan = async page => { const done = page.waitForResponse(response => /\/api\/extensions\/refresh/.test(response.url())); await page.getByRole('button', { name: '重新扫描扩展', exact: true }).evaluate(el => el.click()); await done; await page.waitForTimeout(300); };
async function applyAction(fixture, action) {
  const plan = await fixture.api('/api/extensions/prepare', { action }); if (plan.status !== 200) return { plan };
  const body = json(plan); return { plan, applied: await fixture.api('/api/extensions/actions', { requestId: crypto.randomUUID(), expectedVersion: body.expectedVersion, planId: body.planId, action: body.normalizedAction }) };
}
// 只改 capabilities 镜像（Linux 后端没有 reveal；恢复能力保持真实值）。
const mockCapabilities = async (page, extensions) => page.route(/\/api\/extensions\/(state|refresh)(\?.*)?$/, async route => { const response = await route.fetch(), body = await response.json(); body.capabilities = { ...(body.capabilities || {}), extensions }; await route.fulfill({ response, json: body }); });

export default [
  { id: 'ext-fu-01', priority: 'P0', widths: [1440], ...GATE, title: '真实后端：配置损坏 → 从备份恢复（时间可读、带服务个数）→ 回执条常驻「撤销」→ 撤销回到恢复前；toast 只说结果', async run({ page, url, fixture, assert: check }) {
    const file = path.join(fixture.agents, 'mcp/servers.json'), good = await fsp.readFile(file, 'utf8'), broken = '{ "schemaVersion": 1, "servers": [ ';
    const dialog = page.locator('dialog[open]');
    for (const id of ['fu-one', 'fu-two']) check.equal((await applyAction(fixture, { type: 'mcp.save', create: true, server: { id, name: id, transport: 'stdio', command: 'node', args: [id + '.mjs'] } })).applied.status, 200, '造恢复点：' + id);
    await open(page, url, 'mcp');
    try {
      await fsp.writeFile(file, broken); await rescan(page);
      const banner = page.locator('[data-config-banner="MCP_FORMAT"]'); await banner.waitFor();
      await banner.getByRole('button', { name: '从备份恢复…' }).click();
      const radios = dialog.locator('input[name="backup"]'); await radios.first().waitFor();
      const meta = await dialog.locator('.ui-sheet-list small').first().innerText();
      check.match(meta, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2} · \d+ 个服务$/, '时间已格式化并带服务个数：' + meta);
      check.equal(await dialog.getByText(/T\d{2}:\d{2}:\d{2}\.\d+Z/).count(), 0, '不再显示原始 ISO 时间');
      await dialog.getByRole('button', { name: '预览恢复' }).click();
      await dialog.locator('[data-preview-apply], [data-batch-apply]').first().waitFor(); await dialog.locator('[data-preview-apply], [data-batch-apply]').first().click();
      await page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 8000 });
      const toast = page.locator('.ui-toast').filter({ hasText: '已从备份恢复 MCP 配置' }); await toast.waitFor();
      check.equal(await toast.getByRole('button', { name: '撤销' }).count(), 0, 'toast 不放撤销（4 秒就没了）');
      const notice = page.locator('[data-restore-banner]'); await notice.waitFor();
      check.match(await fsp.readFile(file, 'utf8'), /fu-one/, '恢复后文件可读，含恢复点里的服务');
      await page.waitForTimeout(5000);   // 超过 toast 时长，提示条仍在
      check.equal(await notice.count(), 1, '提示条常驻');
      await notice.getByRole('button', { name: '撤销' }).click();
      await dialog.locator('[data-batch-apply], [data-preview-apply]').first().waitFor(); await dialog.locator('[data-batch-apply], [data-preview-apply]').first().click();
      await page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 8000 });
      await page.waitForFunction(() => !document.querySelector('[data-restore-banner]'), null, { timeout: 5000 });
      check.equal(await fsp.readFile(file, 'utf8'), broken, '撤销回到恢复前的内容');
    } finally { await fsp.writeFile(file, good); }
  } },
  { id: 'ext-fu-02', priority: 'P0', widths: [1440], ...GATE, title: 'reveal 补 skill / client：门控字面 true；请求体只有 kind + id / clientId；client 仅已接入时有；关闭门控没有按钮', async run({ page, url, fixture, assert: check }) {
    const state = json(await fixture.api('/api/extensions/state')), skill = state.skills[0], selectedClient = state.clients.find(item => item.selected), plainClient = state.clients.find(item => !item.selected);
    check.ok(skill && selectedClient, '夹具有 skill 与已接入的软件');
    const bodies = [];
    await mockCapabilities(page, { restoreBackup: true, reveal: true });
    await page.route(/\/api\/extensions\/reveal$/, async route => { bodies.push(route.request().postDataJSON()); await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
    await open(page, url, 'skills'); await pick(page, skill.id);
    await detail(page).getByRole('button', { name: '在访达中显示' }).click(); await page.locator('.ui-toast').filter({ hasText: '已在访达中显示' }).waitFor();
    check.deepEqual(bodies[0], { kind: 'skill', id: skill.id }, 'skill 请求体');
    await open(page, url, 'clients'); await pick(page, selectedClient.id);
    await detail(page).getByRole('button', { name: '在访达中显示' }).click(); await page.waitForFunction(() => document.querySelectorAll('.ui-toast').length >= 1);
    check.ok(bodies.length === 2, '第二次请求已发出：' + bodies.length);
    check.deepEqual(bodies[1], { kind: 'client', clientId: selectedClient.id }, 'client 请求体');
    check.ok(bodies.every(body => !('path' in body)), '请求体不带路径');
    if (plainClient) { await pick(page, plainClient.id); check.equal(await detail(page).getByRole('button', { name: '在访达中显示' }).count(), 0, '未接入的软件没有「在访达中显示」'); }
    await mockCapabilities(page, { restoreBackup: true, reveal: 'true' }); await page.reload();   // 同一页内换 hash 不会重新取 /state，必须整页重载
    await open(page, url, 'skills'); await pick(page, skill.id);
    check.equal(await detail(page).getByRole('button', { name: '在访达中显示' }).count(), 0, "reveal:'true' 不是字面 true，没有按钮");
  } },
  { id: 'ext-fu-03', priority: 'P0', widths: [1440], ...GATE, title: '非 macOS：门控被打开但后端返回 501 → toast 说明不支持并给「复制路径」；404 提示重新扫描', async run({ page, url, fixture, assert: check }) {
    const skill = json(await fixture.api('/api/extensions/state')).skills[0];
    await mockCapabilities(page, { restoreBackup: true, reveal: true });
    let forced = process.platform === 'darwin' ? 501 : 0;   // Linux 上走真实后端（501）；Mac 上绝不真的打开访达
    await page.route(/\/api\/extensions\/reveal$/, async route => { if (forced) await route.fulfill({ status: forced, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: forced === 404 ? 'EXTENSIONS_OBJECT_MISSING' : 'EXTENSIONS_UNSUPPORTED' }) }); else await route.continue(); });
    await open(page, url, 'skills'); await pick(page, skill.id);
    await detail(page).getByRole('button', { name: '在访达中显示' }).click();
    const toast = page.locator('.ui-toast').filter({ hasText: '无法在访达中显示' }); await toast.waitFor();
    check.match(await toast.innerText(), /当前系统不支持.*macOS/, '501 提示'); check.equal(await page.locator('[data-error]').innerText(), '', '不占用页面错误区');
    await toast.getByRole('button', { name: '复制路径' }).waitFor();
    forced = 404; await detail(page).getByRole('button', { name: '在访达中显示' }).click();
    await page.locator('.ui-toast').filter({ hasText: /已经不存在.*重新扫描/ }).waitFor();
  } },
  { id: 'ext-fu-04', priority: 'P0', widths: [1440], ...GATE, ...FIX05, title: 'PR-12 小问题：选过处理方式后遇到非冲突失败，面板收起且选择清掉；再次提交重新 409，没有预选，请求不带 onConflict', async run({ page, url, fixture, assert: check }) {
    const dialog = page.locator('dialog[open]'), requests = []; let failNext = false;
    await page.route(/\/api\/extensions\/prepare$/, async route => { requests.push(route.request().postDataJSON()); if (failNext) { failNext = false; await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '临时失败', code: 'EXTENSIONS_INTERNAL' }) }); } else await route.continue(); });
    await open(page, url, 'mcp');
    await page.getByRole('button', { name: '新建 MCP 服务', exact: true }).click();
    await dialog.getByLabel('稳定 ID', { exact: true }).fill('missing-env-mcp'); await dialog.getByLabel('服务名称', { exact: true }).fill('残留测试'); await dialog.getByLabel('可执行命令', { exact: true }).fill('npx');
    await dialog.locator('form button[type="submit"]').first().click(); await dialog.locator('[data-duplicate-panel] input[type="radio"]').first().waitFor();
    await dialog.getByRole('radio', { name: /保留现有/ }).check(); failNext = true;
    await dialog.getByRole('button', { name: /按所选继续/ }).click();
    await page.waitForFunction(() => document.querySelector('[data-duplicate-panel]')?.hidden !== false, null, { timeout: 5000 });
    check.equal(await dialog.locator('[data-duplicate-panel]:not([hidden])').count(), 0, '非冲突失败后面板收起');
    await dialog.locator('form button[type="submit"]').first().click(); await dialog.locator('[data-duplicate-panel] input[type="radio"]').first().waitFor();
    check.equal(await dialog.locator('[data-duplicate-panel] input[type="radio"]:checked').count(), 0, '重新出现的面板没有预选');
    const last = requests.at(-1); check.ok(!JSON.stringify(last).includes('onConflict'), '再次提交的请求不带 onConflict：' + JSON.stringify(last).slice(0, 200));
    check.equal(requests.some(body => body?.action?.onConflict === 'keepExisting'), true, '第一次带选择的请求确实发出过');
    await dialog.getByRole('button', { name: /取消|关闭/ }).first().click().catch(() => {});
  } },
];
