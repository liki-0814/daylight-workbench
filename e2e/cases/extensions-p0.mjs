// P0 cases from the 0.7 test plan (§3) that can run on the current UI. IDs match test-plan.md.
// `expectedFail` records a known defect: the case must fail until the fix lands, then the runner demands the flag be removed.
import os from 'node:os';
import path from 'node:path';
import { FIXTURE_EXPECTED, FIXTURE_SECRET } from '../fixture.mjs';
import { horizontalOverflow, unnamedControls, focusWalk, smallTargets } from '../a11y.mjs';
// ext-sk-16 / ext-sk-17 (E-26 / E-27) live in extensions-pr1.mjs together with the other PR-1 cases.

const rows = page => page.locator('.extension-row');
const open = async (page, url, tab) => { await page.goto(`${url}/#extensions&tab=${tab}`); await rows(page).first().waitFor({ timeout: 10000 }); };
const search = page => page.getByRole('searchbox', { name: '搜索扩展' });
const dialog = page => page.locator('dialog[open]');

export default [
  { id: 'ext-fix-01', priority: 'P0', widths: [1440], title: 'fixture-v1 数量与隔离', async run({ page, url, fixture, assert: check }) {
    const state = JSON.parse((await fixture.api('/api/extensions/state')).text);
    check.equal(state.skills.length, FIXTURE_EXPECTED.skills, 'Skills 数量');
    check.equal(state.servers.length, FIXTURE_EXPECTED.mcpServers, 'MCP 数量');
    check.equal(state.clients.filter(client => ['codex', 'qoder', 'pi'].includes(client.id)).length, FIXTURE_EXPECTED.clients, '接入软件数量');
    check.ok(path.resolve(fixture.dir).startsWith(os.tmpdir()), '夹具必须位于临时目录');
  } },
  { id: 'ext-shell-01', priority: 'P0', title: '三宽度渲染：Skills 页无横向滚动、无脚本错误、无外部请求', async run({ page, url, errors, blocked, assert: check, shot }) {
    await open(page, url, 'skills');
    check.ok(!(await horizontalOverflow(page)).overflow, '出现横向滚动');
    check.deepEqual(errors, [], '页面脚本错误');
    check.deepEqual(blocked, [], '出现外部网络请求');
    await shot('skills-list');
  } },
  { id: 'ext-sk-01', priority: 'P0', widths: [1440], title: 'Skills 列表、搜索、空结果', async run({ page, url, assert: check }) {
    await open(page, url, 'skills');
    check.ok(await rows(page).count() >= 14, '列表行数');
    await search(page).fill('review'); await page.waitForTimeout(300);
    check.equal(await rows(page).count(), 1);
    await search(page).fill('zzzz-none'); await page.waitForTimeout(300);
    check.equal(await rows(page).count(), 0);
    check.ok((await page.locator('.extension-empty').textContent()).trim().length > 0, '空结果应有说明文字');
  } },
  { id: 'ext-sk-03', priority: 'P0', widths: [1440], title: '「只看有问题」筛选包含冲突与无效 Skill', async run({ page, url, assert: check }) {
    await open(page, url, 'skills');
    await page.locator('[data-problems]').check(); await page.waitForTimeout(300);
    const text = await rows(page).allTextContents();
    check.ok(text.some(value => value.includes('broken-skill')), '无效 Skill 应在问题列表');
    check.ok(text.some(value => value.includes('api-design')), '冲突 Skill 应在问题列表');
    check.ok(!text.some(value => value.includes('review-code')), '正常 Skill 不应出现');
  } },
  { id: 'ext-mcp-01', priority: 'P0', widths: [1440], title: 'MCP 列表：6 个服务，停用服务有文字状态', async run({ page, url, assert: check }) {
    await open(page, url, 'mcp');
    check.equal(await rows(page).count(), FIXTURE_EXPECTED.mcpServers);
    const disabled = (await rows(page).filter({ hasText: '已停用的服务' }).textContent()).replace(/\s+/g, '');
    check.ok(/停用|已停用/.test(disabled), '停用状态需有文字');
  } },
  { id: 'ext-mcp-07', priority: 'P0', widths: [1440], title: '凭据值永不出现在 DOM、可见文字与 API 响应', async run({ page, url, fixture, assert: check }) {
    await open(page, url, 'mcp');
    for (const name of ['GitHub（HTTP', '缺少凭据的服务']) { await rows(page).filter({ hasText: name }).locator('[data-extension-id]').first().click(); await page.locator('.extension-detail:not([hidden])').waitFor(); await page.waitForTimeout(200); }
    const html = await page.content();
    check.ok(!html.includes(FIXTURE_SECRET), 'DOM 中出现凭据值');
    for (const endpoint of ['/api/extensions/state', '/api/extensions/objects/github-remote']) check.ok(!(await fixture.api(endpoint)).text.includes(FIXTURE_SECRET), endpoint + ' 返回了凭据值');
  } },
  { id: 'ext-a11y-01', priority: 'P0', widths: [1440], title: '启发式：图标按钮与复选框都有可访问名称', async run({ page, url, assert: check }) {
    await open(page, url, 'skills');
    check.deepEqual(await unnamedControls(page), []);
  } },
  { id: 'ext-a11y-02', priority: 'P0', widths: [1440], title: '启发式：键盘 Tab 焦点始终可见、不丢到 body', async run({ page, url, assert: check }) {
    await open(page, url, 'skills');
    const visited = await focusWalk(page, 24);
    check.ok(!visited.some(step => step.onBody), '焦点落到 body');
    const invisible = visited.filter(step => !step.focusVisible);
    check.deepEqual(invisible.map(step => step.tag + ':' + step.name), [], '无可见焦点指示');
  } },
  { id: 'ext-a11y-03', priority: 'P1', widths: [1440], expectedFail: '0.6.1 现状：「只看有问题」复选框命中区高 22px（<24px）；组件规格落地后移除此标记', title: '启发式：交互目标不小于 24px（设计目标 28px，仅报告）', async run({ page, url, assert: check, note }) {
    await open(page, url, 'skills');
    const hard = await smallTargets(page, { min: 24 }), design = await smallTargets(page, { min: 28 });
    note(`小于 28px：${design.length} 个；小于 24px：${hard.length} 个`);
    check.deepEqual(hard.map(item => item.html), [], '小于 24px 的目标');
  } },
  { id: 'ext-shell-05', priority: 'P0', widths: [1440], title: 'reducedMotion: 无进行中的 CSS 动画/过渡', async run({ page, url, assert: check }) {
    await open(page, url, 'skills');
    check.ok(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), '未启用 reduced motion');
    await rows(page).first().locator('[data-extension-id]').first().click(); await page.waitForTimeout(100);
    check.deepEqual(await page.evaluate(() => document.getAnimations().filter(a => a.effect?.getComputedTiming().duration > 0 && a.playState === 'running' && a.transitionProperty && /transform|translate|scale/.test(a.transitionProperty)).map(a => a.transitionProperty)), []);
  } },
];
