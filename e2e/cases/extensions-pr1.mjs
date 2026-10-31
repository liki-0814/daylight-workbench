// 0.7 PR-1 (frontend) cases: E-26 / E-27 / E-01 / E-04 / E-08 / E-16 / E-17. IDs match test-plan.md.
// These run on all three desktop widths unless noted. They assert behaviour the user can see: focus, enabled state, inline errors, files left untouched.
import fs from 'node:fs/promises';
import path from 'node:path';
import { clickAdd, addDisabled, addItemVisible } from '../add-menu.mjs';

const rows = page => page.locator('.extension-row');
const open = async (page, url, tab) => { await page.goto(`${url}/#extensions&tab=${tab}`); await rows(page).first().waitFor({ timeout: 10000 }); };
const dialog = page => page.locator('dialog[open]');
const gone = page => page.waitForFunction(() => !document.querySelector('dialog[open]'));
const fieldIn = (page, label) => dialog(page).getByLabel(label, { exact: true });
const fieldErrors = page => dialog(page).locator('[data-field-error]').allInnerTexts();
const activeName = page => page.evaluate(() => document.activeElement?.name || null);
const save = page => dialog(page).getByRole('button', { name: '保存主来源', exact: true });

export default [
  { id: 'ext-sk-16', priority: 'P0', title: '预览取消后复选框恢复可操作、焦点回位、可再次进入预览：清单与详情两处 × 取消按钮 / Esc / 点遮罩（E-26）', async run({ page, url, assert: check }) {
    await open(page, url, 'skills');
    const cancels = {
      '取消按钮': () => dialog(page).getByRole('button', { name: '取消', exact: true }).click(),
      'Esc': () => page.keyboard.press('Escape'),
      '点遮罩': () => page.mouse.click(3, 3),
    };
    if (await page.locator('[data-staging-bar]').count()) {
      // 0.7 PR-6：开关只暂存，预览在底栏「预览并应用」里打开。E-26 的不变量照旧：取消后一切仍可操作、焦点回到触发预览的按钮、可再次进入预览，且没有写任何文件。
      const staged = { '清单': '.extension-list', '详情': '.extension-detail' };
      for (const [area, scope] of Object.entries(staged)) {
        if (area === '详情') { await rows(page).filter({ hasText: 'review-code' }).locator('[data-extension-id]').first().click(); await page.locator('.extension-detail:not([hidden])').waitFor(); }
        const box = () => page.locator(scope).getByRole('switch', { name: 'review-code · Pi', exact: true });
        const review = page.locator('[data-staging-bar]').getByRole('button', { name: '预览并应用', exact: true });
        await box().click();
        for (const [name, cancel] of Object.entries(cancels)) {
          const label = area + ' / ' + name;
          await review.click({ timeout: 5000 }).catch(error => { throw new Error(label + '：点不到「预览并应用」（' + error.message.split('\n')[0] + '）'); });
          await dialog(page).waitFor(); await cancel(); await gone(page);
          await page.waitForFunction(() => { const button = document.querySelector('[data-staging-review]'); return button && !button.disabled; }, null, { timeout: 2000 }).catch(() => { throw new Error(label + '：「预览并应用」仍为 disabled'); });
          await page.waitForFunction(() => document.activeElement?.matches?.('[data-staging-review]'), null, { timeout: 2000 }).catch(() => { throw new Error(label + '：焦点没有回到「预览并应用」'); });
          check.equal(await box().isDisabled(), false, label + '：开关仍可操作');
          check.equal(await box().isChecked(), true, label + '：暂存值保留');
        }
        await review.click(); await dialog(page).waitFor(); await page.keyboard.press('Escape'); await gone(page);   // 取消后还能再进入预览
        await page.locator('[data-staging-revert]').click();
        check.equal(await box().isChecked(), false, area + '：还原后回到未接入');
      }
      return;
    }
    // 清单里的复选框先测（E-26 的根因在清单重绘的缓存）；窄窗口下打开详情会隐藏清单，所以放在详情之前。
    const areas = { '清单': '.extension-list', '详情': '.extension-detail' };
    for (const [area, scope] of Object.entries(areas)) {
      if (area === '详情') { await rows(page).filter({ hasText: 'review-code' }).locator('[data-extension-id]').first().click(); await page.locator('.extension-detail:not([hidden])').waitFor(); }
      const box = () => page.locator(scope).getByRole('switch', { name: 'review-code · Pi', exact: true });
      for (const [name, cancel] of Object.entries(cancels)) {
        const label = area + ' / ' + name;
        await box().click(); await dialog(page).waitFor(); await cancel(); await gone(page);
        // dialog 的 close 事件晚一个任务才触发，恢复动作随后执行：轮询等待，而不是在同一刻读取
        await page.waitForFunction(selector => { const e = document.querySelector(selector); return e && !e.disabled; }, scope + ' input[data-binding-toggle][aria-label="review-code · Pi"]', { timeout: 2000 }).catch(() => { throw new Error(label + '：复选框仍为 disabled'); });
        check.equal(await box().isChecked(), false, label + '：复选框不应被选中');
        await page.waitForFunction(selector => document.activeElement?.matches?.(selector), scope + ' input[data-binding-toggle][aria-label="review-code · Pi"]', { timeout: 2000 }).catch(() => { throw new Error(label + '：焦点没有回到复选框'); });
      }
      await box().click(); await dialog(page).waitFor(); await page.keyboard.press('Escape'); await gone(page);   // 取消后还能再进入预览
    }
  } },
  { id: 'ext-sk-17', priority: 'P0', title: '归档 / 移除登记后焦点落到相邻行，不在 body（E-27）：Skills、MCP、接入软件', async run({ page, url, assert: check, fixture }) {
    const ids = () => page.evaluate(() => [...document.querySelectorAll('.extension-row [data-extension-id]')].map(e => e.dataset.extensionId));
    const focused = () => page.evaluate(() => ({ id: document.activeElement?.dataset?.extensionId || null, body: document.activeElement === document.body, heading: !!document.activeElement?.closest?.('.extension-list-heading') }));
    const adjacent = (list, id) => { const at = list.indexOf(id); return list[at + 1] ?? list[at - 1] ?? null; };
    const archive = async hasText => {
      const before = await ids(), target = rows(page).filter({ hasText }).locator('[data-extension-id]').first(), id = await target.getAttribute('data-extension-id');
      await target.click(); await page.locator('.extension-detail:not([hidden])').waitFor();
      await page.locator('.extension-detail').getByRole('button', { name: /归档/ }).first().click(); await dialog(page).waitFor();
      await dialog(page).getByRole('button', { name: /归档|确认|应用/ }).last().click(); await gone(page); await page.waitForTimeout(400);
      return { expected: adjacent(before, id), got: await focused() };
    };
    await open(page, url, 'skills');
    let r = await archive('perf-profiling'); check.ok(!r.got.body, 'Skills：焦点落到 body'); check.equal(r.got.id, r.expected, 'Skills：应落到相邻行');
    r = await archive('meeting-minutes'); check.equal(r.got.id, r.expected, 'Skills(2)：应落到相邻行');
    await open(page, url, 'mcp');
    r = await archive('已停用的服务'); check.ok(!r.got.body, 'MCP：焦点落到 body'); check.equal(r.got.id, r.expected, 'MCP：应落到相邻行');
    await open(page, url, 'clients');
    await page.getByRole('button', { name: '添加 CLI', exact: true }).click();
    await fieldIn(page, '软件名称').fill('E2E CLI'); await fieldIn(page, 'CLI 命令').fill(process.execPath); await fieldIn(page, '软件主目录').fill(path.join(fixture.dir, 'e2e-cli'));
    await dialog(page).getByRole('button', { name: '预览登记', exact: true }).click(); await dialog(page).getByRole('button', { name: '确认保存登记', exact: true }).click(); await gone(page);
    const before = await ids(), current = await page.locator('[data-extension-id][aria-current="true"]').getAttribute('data-extension-id');
    await page.getByRole('button', { name: '移除登记', exact: true }).click(); await dialog(page).getByRole('button', { name: /应用|确认|移除/ }).last().click(); await gone(page); await page.waitForTimeout(400);
    const after = await focused(); check.ok(!after.body, '接入软件：焦点落到 body'); check.equal(after.id, adjacent(before, current), '接入软件：应落到相邻行');
  } },
  { id: 'ext-sk-09', priority: 'P0', title: '新建 Skill：空提交、非法名称实时提示（E-04）、重名被拒且不覆盖、成功', async run({ page, url, assert: check, fixture, errors }) {
    await open(page, url, 'skills');
    await clickAdd(page, '新建 Skill');
    check.equal(await dialog(page).locator('form').evaluate(form => form.noValidate), true, '不应依赖浏览器原生气泡');
    await save(page).click();
    check.equal((await fieldErrors(page)).length, 2); check.equal(await activeName(page), 'directory', '首个错误应获得焦点');
    await fieldIn(page, 'Skill 名称 / 目录').fill('Bad Name'); check.match((await fieldErrors(page)).join(' '), /小写字母、数字和短横线/);
    await fieldIn(page, 'Skill 名称 / 目录').fill('e2e-new-skill'); await fieldIn(page, '用途说明').fill('端到端新建');
    await save(page).click(); await gone(page);
    await fs.access(path.join(fixture.agents, 'skills/e2e-new-skill/SKILL.md'));
    const original = await fs.readFile(path.join(fixture.agents, 'skills/review-code/SKILL.md'), 'utf8');
    await clickAdd(page, '新建 Skill'); await fieldIn(page, 'Skill 名称 / 目录').fill('review-code'); await fieldIn(page, '用途说明').fill('不应覆盖');
    await save(page).click(); await dialog(page).locator('[data-field-error="directory"]').waitFor();
    check.equal(await activeName(page), 'directory'); check.equal(await fieldIn(page, '用途说明').inputValue(), '不应覆盖', '输入应保留');
    check.equal(await fs.readFile(path.join(fixture.agents, 'skills/review-code/SKILL.md'), 'utf8'), original, '重名不得覆盖');
    check.deepEqual(errors.filter(text => /pattern|regular expression/i.test(text)), [], '控制台不应有 pattern 报错');
  } },
  { id: 'ext-mcp-02', priority: 'P0', title: '新建 MCP：字段级错误（E-16）、非法 URL、http:// 警告（E-17）、成功后详情带警告', async run({ page, url, assert: check, fixture }) {
    await open(page, url, 'mcp');
    await clickAdd(page, '新建 MCP 服务'); await save(page).click();
    check.equal((await fieldErrors(page)).length, 3, JSON.stringify(await fieldErrors(page))); check.equal(await activeName(page), 'id');
    await fieldIn(page, '稳定 ID').fill('bad id!'); check.match((await fieldErrors(page)).join(' '), /字母、数字、下划线和短横线/);
    await fieldIn(page, '稳定 ID').fill('e2e-http'); await fieldIn(page, '服务名称').fill('E2E HTTP');
    await dialog(page).locator('#extension-transport .select-trigger').click(); await dialog(page).locator('#extension-transport [data-value="http"]').click();
    const warning = dialog(page).locator('[data-field-warning="url"]');
    await fieldIn(page, 'HTTP 端点').fill('http://api.example.com/mcp'); await warning.waitFor(); check.match(await warning.innerText(), /警告 · .*明文 http/);
    await fieldIn(page, 'HTTP 端点').fill('https://api.example.com/mcp'); check.equal(await warning.count(), 0, 'https 不应有警告');
    await fieldIn(page, 'HTTP 端点').fill('http://localhost:3000/mcp'); check.equal(await warning.count(), 0, '本机地址不应有警告');
    await fieldIn(page, 'HTTP 端点').fill('ftp://x'); await save(page).click(); await dialog(page).locator('[data-field-error="url"]').waitFor(); check.equal(await activeName(page), 'url');
    await fieldIn(page, 'HTTP 端点').fill('http://api.example.com/mcp'); await save(page).click(); await gone(page);
    await page.locator('[data-insecure-http]').waitFor();
    check.ok(JSON.parse(await fs.readFile(path.join(fixture.agents, 'mcp/servers.json'), 'utf8')).servers.some(server => server.id === 'e2e-http'));
  } },
  { id: 'ext-mcp-03', priority: 'P0', title: '新建同 ID：字段下提示 + 「查看现有服务」，不写盘、不丢输入；服务端 409 兜底（E-01）', async run({ page, url, assert: check, fixture }) {
    const file = path.join(fixture.agents, 'mcp/servers.json'), original = await fs.readFile(file, 'utf8');
    await open(page, url, 'mcp');
    await clickAdd(page, '新建 MCP 服务');
    await fieldIn(page, '稳定 ID').fill('fixture-mcp'); await fieldIn(page, '服务名称').fill('重复'); await fieldIn(page, '可执行命令').fill('node');
    await dialog(page).locator('[data-field-action="view-existing"]').waitFor(); check.match((await fieldErrors(page)).join(' '), /已存在 ID 为 fixture-mcp/);
    await save(page).click(); await dialog(page).locator('[data-field-error="id"]').waitFor();
    // PR-12：服务端声明 mcpConflictCompare 后，提交不再被本地拦下，而是由服务端 409 带出「对比与选择」面板（焦点在面板里）；未声明时仍是原来的行为。
    const conflictCompare = JSON.parse((await fixture.api('/api/extensions/state')).text).capabilities?.extensions?.mcpConflictCompare === true;
    if (conflictCompare) { await dialog(page).locator('[data-duplicate-panel] input[type="radio"]').first().waitFor(); check.equal(await page.evaluate(() => !!document.activeElement?.closest('[data-duplicate-panel]')), true, '焦点在对比面板里'); }
    else check.equal(await activeName(page), 'id', '焦点回到 ID');
    check.equal(await fieldIn(page, '服务名称').inputValue(), '重复'); check.equal(await fs.readFile(file, 'utf8'), original, 'servers.json 不得改动');
    await fieldIn(page, '稳定 ID').focus(); await page.keyboard.press('Tab'); check.equal(await page.evaluate(() => document.activeElement?.dataset?.fieldAction), 'view-existing', 'Tab 应到达“查看现有服务”');
    await page.keyboard.press('Enter'); await gone(page); await page.locator('.extension-detail:not([hidden])').getByText('本地 MCP 测试服务').first().waitFor();
    // 服务端 409：本地状态过期时（这里用路由模拟），错误同样贴在 ID 字段上并保留输入
    await page.route('**/api/extensions/prepare', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '已存在 ID 为 ghost 的 MCP 服务；请改用其他 ID，或编辑现有服务', code: 'EXTENSIONS_DUPLICATE_ID', field: 'server.id' }) }));
    await page.getByRole('button', { name: '返回清单', exact: true }).click().catch(() => {});
    await clickAdd(page, '新建 MCP 服务'); await fieldIn(page, '稳定 ID').fill('ghost'); await fieldIn(page, '服务名称').fill('幽灵'); await fieldIn(page, '可执行命令').fill('node');
    await save(page).click(); await dialog(page).locator('[data-field-error="id"]').waitFor();
    check.match((await fieldErrors(page)).join(' '), /已存在 ID 为 ghost/); check.equal(await activeName(page), 'id', 'ghost 焦点'); check.equal(await fieldIn(page, '服务名称').inputValue(), '幽灵');
  } },
  { id: 'ext-mcp-09', priority: 'P0', title: '配置损坏：横幅、新建暂停、不覆盖原文件；详情读取失败文案；修复后重新扫描自动清除（E-07/E-08/E-25）', async run({ page, url, assert: check, fixture }) {
    const file = path.join(fixture.agents, 'mcp/servers.json'), good = await fs.readFile(file, 'utf8'), broken = '{ "schemaVersion": 1, "servers": [ ';
    await open(page, url, 'mcp');
    await rows(page).filter({ hasText: '本地 MCP 测试服务' }).locator('[data-extension-id]').first().click(); await page.locator('.extension-detail:not([hidden])').waitFor();
    await fs.writeFile(file, broken);
    // 760 下检查器是覆盖层，会盖住页头的「重新扫描扩展」；这里只需要触发一次重扫，用 DOM click 与覆盖层无关。
    await page.getByRole('button', { name: '重新扫描扩展', exact: true }).evaluate(el => el.click());
    const failure = page.locator('.extension-detail-error'); await failure.waitFor(); const text = await failure.innerText();
    check.match(text, /MCP/); check.doesNotMatch(text, /Skill/); check.equal(await failure.getAttribute('role'), 'alert');
    await failure.getByRole('button', { name: '返回清单', exact: true }).click();
    const banner = page.locator('[data-config-banner="MCP_FORMAT"]'); await banner.waitFor(); check.match(await banner.innerText(), /不会覆盖/);
    check.equal(await addDisabled(page, '新建 MCP 服务'), true);
    check.equal(await fs.readFile(file, 'utf8'), broken, '原文件不得被改写');
    check.equal(await page.locator('.extension-static-diagnostics').filter({ hasText: /broken-skill|SKILL\.md/ }).count(), 0, 'Skill 问题不应出现在 MCP 页');
    await fs.writeFile(file, good); await page.getByRole('button', { name: '重新扫描扩展', exact: true }).click(); await banner.waitFor({ state: 'detached' });
    check.equal(await addDisabled(page, '新建 MCP 服务'), false);
  } },
];
