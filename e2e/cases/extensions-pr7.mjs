// 0.7 PR-7 (frontend) cases: MCP 行级启用/停用 → 暂存 → 应用 → 撤销（ext-pr7-01 / ext-mcp-05）、检测的成功·失败·取消（02 / ext-mcp-06）、
// 引用表与凭据泄漏（03 / ext-mcp-07 加强版）、检测全部（04 真实后端、05 排队与取消 / ext-mcp-12）、命令行脱敏（06）、R13 行布局（07）。
// 全部先要求页面里有 MCP 开关（[data-mcp-switch]）：在 0.6.1 / PR-6 UI 上会因前置条件失败，所以 index.mjs 的 expectedFail 门控是真实的。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FIXTURE_SECRET } from '../fixture.mjs';
import { horizontalOverflow } from '../a11y.mjs';

const rows = page => page.locator('.extension-row');
const open = async (page, url, tab = 'mcp') => { await page.goto(`${url}/#extensions&tab=${tab}`); await rows(page).first().waitFor({ timeout: 10000 }); };
const needSwitch = async page => { if (!await page.locator('[data-mcp-switch]').count()) throw new Error('前置条件：MCP 行里没有启用开关（需要 PR-7 前端）'); };
const dialog = page => page.locator('dialog[open]');
const gone = page => page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 8000 }).catch(async () => { throw new Error('对话框没有关闭：' + (await page.locator('dialog[open]').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)); });
const bar = page => page.locator('[data-staging-bar]');
const toast = page => page.locator('.ui-toast');
const row = (page, name) => rows(page).filter({ hasText: name });
const sw = (page, name) => page.locator('.extension-list').getByRole('switch', { name: `${name} · 启用`, exact: true });
// 窄屏（760）时检查器盖在清单右半边：先「返回清单」再操作清单里的开关。
const toList = async page => { const back = page.locator('[data-close-detail]'); if (await back.isVisible().catch(() => false)) await back.click(); };
const flip = async (page, name) => { await toList(page); await sw(page, name).click(); };
const select = async (page, name) => { await toList(page); await row(page, name).locator('[data-extension-id]').first().click(); await page.locator('.extension-detail:not([hidden]) [data-probe]').waitFor({ timeout: 8000 }); };
const servers = async fixture => JSON.parse((await fixture.api('/api/extensions/state')).text).servers;
const server = async (fixture, id) => (await servers(fixture)).find(item => item.id === id);
const confirm = async page => { const button = dialog(page).locator('[data-batch-apply], [data-preview-apply]').first(); await button.waitFor(); await button.click(); };
// 单个检测：确认 → 等卡片到终态（或给定状态）。
const probeOne = async (page, name, status) => {
  await select(page, name); await page.locator('.extension-detail [data-probe]').click(); await dialog(page).waitFor(); await confirm(page); await gone(page);
  const card = page.locator('[data-probe-card]'); await card.waitFor({ timeout: 8000 });
  await page.waitForFunction(expected => { const el = document.querySelector('[data-probe-card]'); return el && (expected ? el.dataset.probeStatus === expected : !['queued', 'running'].includes(el.dataset.probeStatus)); }, status, { timeout: 20000 });
  return card;
};
const mockObject = (page, id, edit) => page.route(new RegExp('/api/extensions/objects/' + id + '(\\?.*)?$'), async route => { const response = await route.request().url().includes(id) ? await route.fetch({ url: route.request().url().replace(id, 'fixture-mcp') }) : await route.fetch(); const body = await response.json(); edit(body); await route.fulfill({ response, json: body }); });
const mockState = (page, edit) => page.route(/\/api\/extensions\/state(\?.*)?$/, async route => { const response = await route.fetch(); const body = await response.json(); edit(body); await route.fulfill({ response, json: body }); });

// 自带 expectedFail 门控（同 index.mjs 的做法：构建里没有 public/extensions/mcp.js 就标记，有就自动解除），
// 这样本补丁只动 extensions-p0.mjs 的两行，不与 index.mjs 的其他前端补丁冲突，合入顺序无关。
const PRESENT = (() => { try { return fs.existsSync(fileURLToPath(new URL('../../public/extensions/mcp.js', import.meta.url))); } catch { return false; } })();
const REASON = '需要 0.7 扩展页 MCP 前端（PR-7：行级开关、检测与检测全部、引用表）：该前端合入后此标记自动消失';
const cases = [
  { id: 'ext-pr7-01', priority: 'P0', title: 'MCP 行开关：暂存 → 底栏 → 预览是人话 → 应用只改 enabled → 停用后「测试连接」不可用并写明原因 → 撤销（ext-mcp-05 / E-12）', async run({ page, url, assert: check, fixture }) {
    await open(page, url); await needSwitch(page);
    const name = '缺少凭据的服务', before = await server(fixture, 'missing-env-mcp');
    check.equal(before.enabled, true); check.equal(await sw(page, name).isChecked(), true, '开关反映配置');
    await flip(page, name); await bar(page).waitFor();
    check.match(await bar(page).innerText(), /1 项待应用的变更/);
    check.equal(await sw(page, name).isChecked(), false, '开关立即显示想要的值');
    check.match(await row(page, name).innerText(), /待应用/, '行里有「待应用」');
    check.equal((await server(fixture, 'missing-env-mcp')).enabled, true, '暂存时不改配置');
    await bar(page).getByRole('button', { name: '预览并应用', exact: true }).click(); await dialog(page).waitFor();
    const preview = await dialog(page).locator('[data-batch-list]').innerText();
    check.ok(preview.includes(name) && /停用/.test(preview), '预览写明哪个服务、停用：' + preview);
    check.ok(!/mcp\.toggle|actionType|undefined|\[object/.test(preview), '预览里没有内部动作名：' + preview);
    await confirm(page); await gone(page);
    const after = await server(fixture, 'missing-env-mcp');
    check.equal(after.enabled, false, '应用后配置为停用');
    check.deepEqual({ ...after, enabled: true, refStatus: undefined, revision: undefined, lastProbe: undefined }, { ...before, refStatus: undefined, revision: undefined, lastProbe: undefined }, '只改了 enabled');
    check.match(await row(page, name).innerText(), /已停用/, '行状态是文字「已停用」');
    await select(page, name);
    const probe = page.locator('.extension-detail [data-probe]');
    check.equal(await probe.isDisabled(), true, '停用后「测试连接」不可用');
    const hint = await page.locator('[data-probe-hint]').innerText(); check.match(hint, /已停用，启用后可检测/, '写明原因');
    const describedBy = await probe.getAttribute('aria-describedby'); check.ok(describedBy && await page.locator('#' + describedBy).count() === 1, '按钮用 aria-describedby 关联原因');
    await toast(page).getByRole('button', { name: '撤销', exact: true }).click(); await dialog(page).waitFor(); await confirm(page); await gone(page);
    check.equal((await server(fixture, 'missing-env-mcp')).enabled, true, '撤销后恢复启用');
    await page.waitForFunction(() => !document.querySelector('[data-probe-hint]') && !document.querySelector('.extension-detail [data-probe]')?.disabled, null, { timeout: 5000 });
    // 暂存「启用」但尚未应用：不能检测，提示说明还没生效。
    await flip(page, '已停用的服务'); await select(page, '已停用的服务');
    check.equal(await page.locator('.extension-detail [data-probe]').isDisabled(), true);
    check.match(await page.locator('[data-probe-hint]').innerText(), /启用待应用，应用后才能检测/);
    await bar(page).getByRole('button', { name: '还原', exact: true }).click();
    await toList(page); check.equal(await sw(page, '已停用的服务').isChecked(), false, '还原后开关回到停用');
  } },
  { id: 'ext-pr7-02', priority: 'P0', title: '单个检测：成功显示工具数；失败给出后端原因和建议；运行中可取消（ext-mcp-06 / E-12）', async run({ page, url, assert: check }) {
    await open(page, url); await needSwitch(page);
    let card = await probeOne(page, '本地 MCP 测试服务', 'succeeded');
    check.match(await card.innerText(), /工具数：2/, '成功显示工具数');
    check.match(await row(page, '本地 MCP 测试服务').innerText(), /握手成功/); check.match(await row(page, '本地 MCP 测试服务').innerText(), /2 个工具/);
    card = await probeOne(page, '命令不存在的服务', 'failed');
    check.match(await card.innerText(), /找不到可执行命令/, '失败原因（后端消息）'); check.equal(await card.locator('[data-probe-advice]').count(), 1, '有建议');
    check.match(await row(page, '命令不存在的服务').innerText(), /检测失败/);
    card = await probeOne(page, '缺少凭据的服务', 'failed');
    check.match(await card.locator('[data-probe-advice]').innerText(), /E2E_MISSING_TOKEN/, '缺环境变量：建议点名缺哪个变量');
    card = await probeOne(page, 'GitHub（HTTP', 'failed');
    check.ok((await card.innerText()).length > 20, 'HTTP 不可达也有原因'); check.ok(!(await page.content()).includes(FIXTURE_SECRET), '失败信息里没有凭据值');
    // 取消：慢服务（约 1 秒）在运行时点「取消检测」。
    await select(page, '慢速 MCP'); await page.locator('.extension-detail [data-probe]').click(); await dialog(page).waitFor(); await confirm(page); await gone(page);
    const cancel = page.locator('[data-cancel-probe]'); await cancel.waitFor({ timeout: 5000 });
    check.equal(await page.locator('.extension-detail [data-probe]').isDisabled(), true, '检测中不能重复发起');
    await cancel.click();
    await page.waitForFunction(() => document.querySelector('[data-probe-card]')?.dataset.probeStatus === 'cancelled', null, { timeout: 8000 });
    await toList(page); await page.waitForFunction(() => [...document.querySelectorAll('.extension-row')].some(el => /慢速 MCP/.test(el.textContent) && /已取消/.test(el.textContent)), null, { timeout: 5000 }).catch(() => {});
    check.match(await row(page, '慢速 MCP').innerText(), /已取消/, '行状态是「已取消」'); await page.waitForTimeout(1200); check.match(await row(page, '慢速 MCP').innerText(), /已取消/, '刷新后仍是「已取消」'); await select(page, '慢速 MCP'); check.equal(await page.locator('.extension-detail [data-probe]').isDisabled(), false, '取消后可再次检测');
  } },
  { id: 'ext-pr7-03', priority: 'P0', title: '引用表只显示「已设置 / 未设置」，凭据值不出现在 DOM、可见文字和 API 响应里，检测失败后也一样（ext-mcp-07 加强版 / E-23）', async run({ page, url, fixture, assert: check }) {
    await open(page, url); await needSwitch(page);
    await select(page, 'GitHub（HTTP');
    let table = page.locator('[data-ref-table]'); await table.waitFor();
    let line = table.locator('[data-ref-row]').filter({ hasText: 'E2E_GITHUB_AUTH' });
    check.equal(await line.getAttribute('data-ref-status'), 'set'); check.match(await line.innerText(), /已设置/);
    check.match(await table.innerText(), /不读取、不显示值/, '说明只检查是否存在');
    await select(page, '缺少凭据的服务');
    table = page.locator('[data-ref-table]'); line = table.locator('[data-ref-row]').filter({ hasText: 'E2E_MISSING_TOKEN' });
    check.equal(await line.getAttribute('data-ref-status'), 'unset'); check.match(await line.innerText(), /未设置/);
    check.match(await page.locator('.extension-detail').innerText(), /E2E_MISSING_TOKEN/);
    check.ok(await row(page, '缺少凭据的服务').innerText().then(text => /缺 1 个变量|未设置|缺少/.test(text)), '列表行上有引用状态徽标');
    await probeOne(page, 'GitHub（HTTP', 'failed');
    const html = await page.content(), text = await page.locator('body').innerText();
    check.ok(!html.includes(FIXTURE_SECRET) && !text.includes(FIXTURE_SECRET), 'DOM / 可见文字中出现凭据值');
    for (const endpoint of ['/api/extensions/state', '/api/extensions/objects/github-remote', '/api/extensions/objects/missing-env-mcp']) check.ok(!(await fixture.api(endpoint)).text.includes(FIXTURE_SECRET), endpoint + ' 返回了凭据值');
  } },
  { id: 'ext-pr7-04', priority: 'P1', title: '检测全部（真实后端）：确认对话框列出对象与跳过项 → 逐个完成 → 每行显示结果 → 完成播报（ext-mcp-12 / E-12）', async run({ page, url, assert: check }) {
    await open(page, url); await needSwitch(page);
    const button = page.locator('[data-probe-all]'); check.equal(await button.isEnabled(), true);
    await button.click(); await dialog(page).waitFor();
    const text = await dialog(page).innerText();
    for (const name of ['本地 MCP 测试服务', '缺少凭据的服务', '慢速 MCP', '命令不存在的服务', 'GitHub（HTTP']) check.ok(text.includes(name), '对话框列出：' + name);
    check.match(text, /不检测（已停用）：已停用的服务/, '已停用的单列为跳过'); check.match(text, /同时最多检测 2 个/);
    check.equal(await dialog(page).locator('[data-probe-targets] li').count(), 5);
    await dialog(page).locator('[data-preview-cancel]').click(); await gone(page);
    check.equal(await page.locator('[data-probe-card]').count(), 0, '取消对话框不发起检测');
    await button.click(); await dialog(page).waitFor(); await dialog(page).locator('[data-preview-apply]').click(); await gone(page);
    await page.waitForFunction(() => document.querySelector('[data-probe-all]') && !document.querySelector('[data-cancel-all-probes]'), null, { timeout: 30000 });
    await page.waitForFunction(() => /检测完成/.test(document.querySelector('[data-probe-live]')?.textContent || ''), null, { timeout: 10000 });   // 先等收尾（刷新、重绘、聚焦、播报）走完
    check.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-probe-all')), true, '完成后焦点回到「检测全部服务」');
    check.match(await page.locator('[data-probe-live]').innerText(), /检测完成：成功 \d，失败 \d/, '完成时在 live region 播报');
    check.match(await row(page, '本地 MCP 测试服务').innerText(), /握手成功/); check.match(await row(page, '慢速 MCP').innerText(), /握手成功/);
    check.match(await row(page, '命令不存在的服务').innerText(), /检测失败/); check.match(await row(page, 'GitHub（HTTP').innerText(), /检测失败/);
    check.match(await row(page, '已停用的服务').innerText(), /已停用/);
  } },
  { id: 'ext-pr7-05', priority: 'P1', title: '检测全部（脚本化后端）：运行 2 + 排队 3 的进度；取消全部对每个未完成的检测发 DELETE；已完成的不再取消；对话框提交时携带当前版本（ext-mcp-12）', async run({ page, url, assert: check }) {
    await open(page, url); await needSwitch(page);
    const ids = ['fixture-mcp', 'missing-env-mcp', 'slow-mcp', 'broken-cmd', 'github-remote'];
    const make = (index, status) => ({ id: 'probe-' + index, serverId: ids[index], status, startedAt: status === 'queued' ? null : '2026-10-30T13:00:00.000Z', finishedAt: ['succeeded', 'failed', 'cancelled'].includes(status) ? '2026-10-30T13:00:01.000Z' : null, stale: false, configRevision: null, tools: [], toolCount: status === 'succeeded' ? 1 : null, message: status === 'failed' ? '授权失败，请检查凭据。' : '' });
    let phase = 0; const deleted = [], posted = [];
    const view = () => ids.map((_, index) => make(index, phase === 0 ? (index < 2 ? 'running' : 'queued') : phase === 1 ? (index < 2 ? 'succeeded' : index < 4 ? 'running' : 'queued') : 'succeeded'));
    await page.route(/\/api\/extensions\/probes$/, async route => { if (route.request().method() !== 'POST') return route.continue(); posted.push(route.request().postDataJSON()); await route.fulfill({ status: 202, json: { probes: view(), skipped: [{ id: 'disabled-one', reason: 'disabled' }] } }); });
    await page.route(/\/api\/extensions\/probes\/probe-\d$/, async route => {
      const id = route.request().url().split('/').pop(), index = Number(id.slice(-1));
      if (route.request().method() === 'DELETE') { deleted.push(id); phase = 99; return route.fulfill({ json: make(index, 'cancelled') }); }
      await route.fulfill({ json: phase === 99 ? make(index, 'cancelled') : view()[index] });
    });
    await page.locator('[data-probe-all]').click(); await dialog(page).waitFor(); await dialog(page).locator('[data-preview-apply]').click(); await gone(page);
    check.equal(posted.length, 1); check.deepEqual([...posted[0].ids].sort(), [...ids].sort(), '只提交已启用的服务'); check.ok(posted[0].expectedVersion !== undefined && posted[0].expectedVersion !== null, '带上当前版本：' + JSON.stringify(posted[0]));
    await page.locator('[data-cancel-all-probes]').waitFor();
    check.match(await page.locator('[data-probe-progress]').innerText(), /完成 0 \/ 5 · 排队 3/, '进度：2 个运行、3 个排队');
    check.equal(await page.locator('[data-probe-progress]').getAttribute('aria-hidden'), 'true', '可见进度对读屏隐藏，用 live region 播报');
    check.match(await page.locator('[data-probe-live]').innerText(), /排队 3/);
    check.match(await row(page, '命令不存在的服务').innerText(), /排队/, '排队的行写「排队」');
    await page.waitForFunction(() => document.activeElement?.hasAttribute('data-cancel-all-probes'), null, { timeout: 3000 }).catch(() => {}); check.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-cancel-all-probes')), true, '焦点移到「取消全部检测」');
    phase = 1; await page.waitForFunction(() => /完成 2 \/ 5/.test(document.querySelector('[data-probe-progress]')?.textContent || ''), null, { timeout: 8000 });
    check.equal(await page.locator('[data-cancel-all-probes]').count(), 1, '运行中按钮不丢（轮询重绘不夺焦点）');
    check.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-cancel-all-probes')), true, '轮询重绘后焦点仍在取消按钮');
    await page.locator('[data-cancel-all-probes]').click();
    await page.waitForFunction(() => !document.querySelector('[data-cancel-all-probes]'), null, { timeout: 8000 });
    check.deepEqual(deleted.sort(), ['probe-2', 'probe-3', 'probe-4'], '只取消未完成的 3 个（运行中 2 + 排队 1）；已成功的 probe-0/1 不发 DELETE');
    check.match(await toast(page).first().innerText(), /检测完成：成功 2，失败 0，已取消 3/);
  } },
  { id: 'ext-pr7-06', priority: 'P0', title: '命令行脱敏：疑似凭据的参数在行摘要、检测全部对话框、检查器里都不出现（E-23 第二道防线）', async run({ page, url, assert: check }) {
    const A = 'SENTINEL-ARG-AAAA', B = 'SENTINEL-ARG-BBBB', C = 'ghp_SENTINELcccccccccccccccccccccccccc';
    await mockState(page, body => { const base = body.servers.find(item => item.id === 'fixture-mcp'); body.servers.push({ ...base, id: 'redact-mcp', name: '参数脱敏测试', args: ['server.js', `--api-key=${A}`, '--token', B, C, 'plain-arg'] }); });
    await mockObject(page, 'redact-mcp', body => { const item = body.item || body.object || body; item.id = 'redact-mcp'; item.name = '参数脱敏测试'; item.args = ['server.js', `--api-key=${A}`, '--token', B, C, 'plain-arg']; });
    await open(page, url); await needSwitch(page);
    const line = await row(page, '参数脱敏测试').innerText();
    check.ok(!/SENTINEL/.test(line), '行摘要里没有凭据：' + line); check.match(line, /plain-arg/, '普通参数保留');
    await select(page, '参数脱敏测试'); check.ok(!/SENTINEL/.test(await page.locator('.extension-detail').innerText()), '检查器里没有凭据');
    await toList(page); await page.locator('[data-probe-all]').click(); await dialog(page).waitFor();
    const text = await dialog(page).innerText(); check.ok(text.includes('参数脱敏测试') && !/SENTINEL/.test(text), '对话框里没有凭据');
    check.ok(!/SENTINEL/.test(await page.locator('body').innerText()), '页面可见文字里没有凭据');
    await dialog(page).locator('[data-preview-cancel]').click(); await gone(page);
  } },
  { id: 'ext-pr7-07', priority: 'P1', widths: [760, 1100, 1440], title: 'R13 / E-20：MCP 表格（含开关、状态列、检测全部）在各宽度不溢出、行高一致、长命令不撑破（ext-l-05 补充）', async run({ page, url, assert: check, shot }) {
    const long = '/opt/very/long/path/to/some-mcp-server/bin/server.js --workspace /Users/someone/Documents/projects/with/a/deeply/nested/folder/name --verbose';
    await mockState(page, body => { const base = body.servers.find(item => item.id === 'fixture-mcp'); body.servers.push({ ...base, id: 'long-mcp', name: '一个名字特别特别长的 MCP 服务用来检查省略号和换行是否撑破布局', command: long.split(' ')[0], args: long.split(' ').slice(1) }); });
    await open(page, url); await needSwitch(page);
    { const overflow = await horizontalOverflow(page); check.equal(overflow.overflow, false, '页面没有横向滚动：' + JSON.stringify(overflow)); }
    const heights = await rows(page).evaluateAll(list => list.map(el => Math.round(el.getBoundingClientRect().height)));
    check.ok(heights.every(h => h >= 52 && h <= 90), '行高在 52–90 之间（含超长名称与超长命令）：' + heights);
    check.equal(await page.locator('[data-probe-all]').isVisible(), true, '检测全部按钮可见');
    const clipped = await rows(page).evaluateAll(list => list.filter(el => el.scrollWidth > el.clientWidth + 1).length); check.equal(clipped, 0, '没有行内容溢出');
    const sizes = await page.locator('.extension-list [data-mcp-switch]').evaluateAll(list => list.map(el => { const box = (el.closest('label') || el).getBoundingClientRect(); return [Math.round(box.width), Math.round(box.height)]; }));
    check.ok(sizes.every(([w, h]) => w >= 24 && h >= 24), '开关命中区 ≥ 24px：' + JSON.stringify(sizes));
    await shot('mcp-table-pr7');
  } },
  { id: 'ext-pr7-08', priority: 'P1', title: '检测全部超过 50 个服务：对话框写明分批；分 50 + 50 + 20 三次 POST，ids 不重复、都带版本；全部完成后播报（#27 ids 上限 1–50）', async run({ page, url, assert: check }) {
    await mockState(page, body => { const base = body.servers.find(item => item.id === 'fixture-mcp'); for (let index = 0; index < 115; index++) body.servers.push({ ...base, id: 'bulk-' + index, name: '批量服务 ' + index, lastProbe: null }); });
    await open(page, url); await needSwitch(page);
    const owner = new Map(), posted = [];
    const make = (id, serverId) => ({ id, serverId, status: 'succeeded', startedAt: '2026-10-30T13:00:00.000Z', finishedAt: '2026-10-30T13:00:01.000Z', stale: false, configRevision: null, tools: [], toolCount: 1, message: '' });
    await page.route(/\/api\/extensions\/probes$/, async route => { if (route.request().method() !== 'POST') return route.continue(); const body = route.request().postDataJSON(); posted.push(body); await route.fulfill({ status: 202, json: { probes: body.ids.map(id => { const probeId = 'probe-' + id; owner.set(probeId, id); return { ...make(probeId, id), status: 'queued', finishedAt: null, toolCount: null }; }), skipped: [] } }); });
    await page.route(/\/api\/extensions\/probes\/probe-.+$/, async route => { const id = route.request().url().split('/').pop(); await route.fulfill({ json: make(id, owner.get(id)) }); });
    await page.locator('[data-probe-all]').click(); await dialog(page).waitFor();
    check.match(await dialog(page).innerText(), /分 3 批提交（每批最多 50 个）/, '对话框写明分批');
    await dialog(page).locator('[data-preview-apply]').click(); await gone(page);
    await page.waitForFunction(() => document.querySelector('[data-probe-all]') && !document.querySelector('[data-cancel-all-probes]'), null, { timeout: 40000 });
    check.deepEqual(posted.map(item => item.ids.length), [50, 50, 20], '分三批提交：' + posted.map(item => item.ids.length));
    const all = posted.flatMap(item => item.ids); check.equal(new Set(all).size, all.length, 'ids 不重复'); check.equal(all.length, 120, '全部已启用的共享服务都提交了：' + all.length);
    check.ok(posted.every(item => item.ids.length <= 50 && item.expectedVersion !== undefined && item.expectedVersion !== null), '每批 ≤ 50 且带版本');
    check.match(await toast(page).first().innerText(), /检测完成：成功 120/);
  } },
  { id: 'ext-pr7-09', priority: 'P1', title: '刷新后 /state 里还在排队 / 检测的服务：≥2 个时恢复检测全部进度（可取消，完成后让位）；只有 1 个时不出现进度条；lastProbe.stale 的行显示「配置已变更」', async run({ page, url, assert: check }) {
    const ids = ['fixture-mcp', 'missing-env-mcp', 'slow-mcp'];
    let phase = 0;
    const make = (index, status) => ({ id: 'resume-' + index, serverId: ids[index], status, startedAt: status === 'queued' ? null : '2026-10-30T13:00:00.000Z', finishedAt: status === 'succeeded' ? '2026-10-30T13:00:01.000Z' : null, stale: false, configRevision: null, tools: [], toolCount: status === 'succeeded' ? 2 : null, message: '' });
    const view = () => ids.map((_, index) => make(index, phase ? 'succeeded' : index === 0 ? 'running' : 'queued'));
    await mockState(page, body => { ids.forEach((id, index) => { const server = body.servers.find(item => item.id === id); server.lastProbe = view()[index]; }); const stale = body.servers.find(item => item.id === 'broken-cmd'); stale.lastProbe = { ...make(0, 'succeeded'), id: 'old', serverId: 'broken-cmd', stale: true }; });
    await page.route(/\/api\/extensions\/probes\/resume-\d$/, async route => { const index = Number(route.request().url().slice(-1)); await route.fulfill({ json: view()[index] }); });
    await open(page, url); await needSwitch(page);
    await page.locator('[data-cancel-all-probes]').waitFor({ timeout: 8000 });
    check.match(await page.locator('[data-probe-progress]').innerText(), /完成 0 \/ 3 · 排队 2/, '恢复后的进度：1 个运行、2 个排队');
    check.match(await row(page, '命令不存在的服务').innerText(), /配置已变更/, 'stale 的 lastProbe 显示配置已变更，不用绿点');
    phase = 1;
    await page.waitForFunction(() => !document.querySelector('[data-cancel-all-probes]'), null, { timeout: 15000 });
    check.equal(await page.locator('[data-probe-all]').isVisible(), true, '完成后回到「检测全部服务」');
  } },
  { id: 'ext-pr7-10', priority: 'P2', title: '刷新后只有 1 个服务在检测：不恢复检测全部进度条（由检查器自己跟进）', async run({ page, url, assert: check }) {
    await mockState(page, body => { const server = body.servers.find(item => item.id === 'fixture-mcp'); server.lastProbe = { id: 'solo-1', serverId: 'fixture-mcp', status: 'running', startedAt: '2026-10-30T13:00:00.000Z', finishedAt: null, stale: false, configRevision: null, tools: [], toolCount: null, message: '' }; });
    await page.route(/\/api\/extensions\/probes\/solo-1$/, route => route.fulfill({ json: { id: 'solo-1', serverId: 'fixture-mcp', status: 'running', startedAt: '2026-10-30T13:00:00.000Z', finishedAt: null, stale: false, configRevision: null, tools: [], toolCount: null, message: '' } }));
    await open(page, url); await needSwitch(page);
    check.equal(await page.locator('[data-cancel-all-probes]').count(), 0, '单个检测不出现「取消全部检测」');
    check.match(await row(page, '本地 MCP 测试服务').innerText(), /检测|排队/, '这一行仍显示检测中');
  } },
];

export default PRESENT ? cases : cases.map(item => item.expectedFail ? item : { ...item, expectedFail: REASON });
