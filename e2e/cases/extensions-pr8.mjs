// 0.7 PR-8（前端）：从文件夹导入 Skill + 「添加 ▾」菜单 + 选文件夹桥接适配（契约 §K）。
// 自门控：构建里没有 public/extensions/folder-picker.js（旧 UI）就标 expectedFail，该前端合入后标记自动消失。
// 红线：桥接用 window.webkit.messageHandlers.pickFolder 的桩（addInitScript）；Swift 端没有被这里验证。断言不依赖后端文案的具体字句。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickAdd } from '../add-menu.mjs';
const built = file => { try { return fs.readFileSync(fileURLToPath(new URL('../../' + file, import.meta.url)), 'utf8'); } catch { return ''; } };
const GATE = built('public/extensions/folder-picker.js') !== '' ? {} : { expectedFail: 'PR-8 需要新 UI（public/extensions/folder-picker.js 未合入）：合入后自动变为必须通过' };
const rows = page => page.locator('.extension-row');
const open = async (page, url, tab) => { await page.goto(`${url}/#extensions&tab=${tab}`); await rows(page).first().waitFor({ timeout: 10000 }); };
const dialog = page => page.locator('dialog[open]');
const gone = page => page.waitForFunction(() => !document.querySelector('dialog[open]'));
const toast = page => page.locator('.ui-toast').last();
const pathInput = page => dialog(page).getByLabel('Skill 文件夹路径', { exact: true });
const previewButton = page => dialog(page).getByRole('button', { name: '预览导入', exact: true });
const applyButton = page => dialog(page).getByRole('button', { name: '导入', exact: true });
const pickButton = page => dialog(page).getByRole('button', { name: '选择文件夹…', exact: true });
const dialogError = page => dialog(page).locator('[data-dialog-error]');
const openImport = async (page, url) => { await open(page, url, 'skills'); await clickAdd(page, '从文件夹导入'); await dialog(page).locator('[data-skill-import-form]').waitFor(); };
const phase = page => dialog(page).locator('[data-skill-import-form]').getAttribute('data-phase');
const fieldState = page => pathInput(page).evaluate(input => ({ errors: [...input.closest('form').querySelectorAll('[data-field-error="sourcePath"]')].map(node => node.textContent.trim()), invalid: input.getAttribute('aria-invalid'), described: (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean), focused: document.activeElement === input }));
async function makeSkill(fixture, folder, name, extra = {}) {
  const dir = path.join(fixture.dir, 'import-src', folder); await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${extra.description || '端到端导入的 Skill'}\n---\n\n${extra.body || '正文'}\n`); await fsp.writeFile(path.join(dir, 'notes.txt'), 'extra file\n');
  return dir;
}
const installBridge = page => page.addInitScript(() => {
  window.__posts = [];
  window.webkit = { messageHandlers: { pickFolder: { postMessage(payload) { window.__posts.push(JSON.parse(JSON.stringify(payload))); } } } };
  window.__reply = detail => window.dispatchEvent(new CustomEvent('daylight-folder-picked', { detail }));
});
const posts = page => page.evaluate(() => window.__posts);
const reply = (page, detail) => page.evaluate(value => window.__reply(value), detail);
const prepareBodies = page => { const bodies = []; page.on('request', request => { if (/\/api\/extensions\/prepare/.test(request.url()) && request.method() === 'POST') { try { bodies.push(JSON.parse(request.postData())); } catch { /* ignore */ } } }); return bodies; };
const skillDirs = async fixture => (await fsp.readdir(path.join(fixture.agents, 'skills'))).sort();

export default [
  { id: 'ext-pr8-01', priority: 'P0', widths: [760, 1240, 1440], ...GATE, title: '「添加 ▾」菜单：Skills = 新建 / 从文件夹导入，MCP = 新建 / 导入 JSON，接入软件没有菜单；键盘与外点关闭；展开不挤动工具栏，菜单不出视口', async run({ page, url, assert: check, width }) {
    const trigger = page.locator('[data-add-menu-button]'), menu = page.getByRole('menu', { name: '添加' }), items = () => menu.getByRole('menuitem').allInnerTexts();
    const toolbar = () => page.evaluate(() => { const box = selector => { const rect = document.querySelector(selector)?.getBoundingClientRect(); return rect ? [rect.x, rect.y, rect.width, rect.height].map(value => Math.round(value * 10) / 10) : null; }; return { action: box('.extension-category-action'), tabs: box('.extension-tabs'), search: box('.extension-search'), heading: box('.extension-list-heading') }; });
    await open(page, url, 'skills');
    check.equal(await trigger.getAttribute('aria-haspopup'), 'menu'); check.equal(await trigger.getAttribute('aria-expanded'), 'false'); check.equal((await trigger.innerText()).replace(/\s+/g, ''), '添加▾');
    check.equal(await page.getByRole('button', { name: '添加', exact: true }).count(), 1, '可访问名称是「添加」，箭头不朗读');
    check.equal(await menu.count(), 0, '收起时菜单不在可访问树里'); const before = await toolbar();
    await trigger.click(); await menu.waitFor();
    check.equal(await trigger.getAttribute('aria-expanded'), 'true'); check.deepEqual(await items(), ['新建 Skill…', '从文件夹导入…']);
    check.deepEqual(await toolbar(), before, '展开菜单不改变工具栏布局');
    const rect = await menu.evaluate(node => { const { left, right, top, bottom } = node.getBoundingClientRect(); return { left, right, top, bottom, width: innerWidth, height: innerHeight }; });
    check.ok(rect.left >= 0 && rect.right <= rect.width && rect.top >= 0 && rect.bottom <= rect.height, `${width}：菜单完整落在视口内`);
    // 键盘：Esc 关并还焦点；↓ 打开并聚焦第一项；↓↑循环；Tab 关
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' }); check.equal(await trigger.evaluate(node => document.activeElement === node), true, 'Esc 后焦点回到触发按钮');
    await trigger.press('ArrowDown'); await menu.waitFor(); check.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), '新建 Skill…', '↓ 打开并聚焦第一项');
    await page.keyboard.press('ArrowDown'); check.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), '从文件夹导入…');
    await page.keyboard.press('ArrowDown'); check.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), '新建 Skill…', '到底回到第一项');
    await page.keyboard.press('ArrowUp'); check.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), '从文件夹导入…');
    await page.keyboard.press('Home'); check.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), '新建 Skill…'); await page.keyboard.press('End'); check.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), '从文件夹导入…');
    await page.keyboard.press('Tab'); await menu.waitFor({ state: 'hidden' });
    await trigger.click(); await menu.waitFor(); await page.mouse.click(3, 3); await menu.waitFor({ state: 'hidden' }); check.equal(await trigger.getAttribute('aria-expanded'), 'false', '点菜单外关闭');
    // 选项：Enter 激活并关闭；对话框关掉后焦点回到触发按钮
    await trigger.press('ArrowDown'); await page.keyboard.press('Enter'); await dialog(page).waitFor(); check.match(await dialog(page).innerText(), /新建 Skill/); check.equal(await menu.count(), 0, '激活后菜单收起');
    await page.keyboard.press('Escape'); await gone(page); check.equal(await trigger.evaluate(node => document.activeElement === node), true, '对话框关闭后焦点回到「添加」');
    // MCP：新建 MCP 服务 / 导入 JSON；接入软件：没有菜单，仍是单个按钮
    await open(page, url, 'mcp'); await trigger.click(); await menu.waitFor(); check.deepEqual(await items(), ['新建 MCP 服务…', '导入 JSON…']); await page.keyboard.press('Escape');
    await page.goto(`${url}/#extensions&tab=clients`); await page.locator('.extension-row, .extension-empty').first().waitFor({ timeout: 10000 });
    check.equal(await page.locator('[data-add-menu-button]').count(), 0, '接入软件页签没有菜单'); check.equal(await page.locator('.extension-category-action').getByRole('button').count(), 1);
    check.equal(await page.locator('.extension-list-heading').getByRole('button', { name: /导入.*JSON/ }).count(), 0, '「导入 JSON…」不再在列表标题行');
  } },
  { id: 'ext-pr8-02', priority: 'P0', widths: [1440], ...GATE, title: '没有桥接：不显示「选择文件夹…」，手输绝对路径；空 / ~ / 相对路径 / .. 都被拒，错误在路径框下、aria-invalid + aria-describedby、焦点回路径框、不请求后端、不写盘', async run({ page, url, assert: check, fixture }) {
    const bodies = prepareBodies(page), before = await skillDirs(fixture);
    await openImport(page, url);
    check.equal(await pickButton(page).count(), 0, '没有桥接时没有「选择文件夹…」'); check.equal(await page.evaluate(() => !!window.webkit), false);
    check.equal(await dialog(page).locator('form').evaluate(form => form.noValidate), true, '不依赖浏览器原生气泡');
    for (const [label, value] of [['空', ''], ['只有空格', '   '], ['~ 开头', '~/skills/x'], ['相对路径', 'skills/x'], ['./ 开头', './x'], ['含 ..', '/Users/me/../x'], ['URL', 'file:///tmp/x']]) {
      await pathInput(page).fill(value); await previewButton(page).click();
      const state = await fieldState(page);
      check.equal(state.errors.length, 1, `${label}：路径框下恰有一条错误`); check.ok(state.errors[0].length > 8, `${label}：错误说得出怎么改`); check.doesNotMatch(state.errors[0], /EXTENSIONS_|undefined|\[object/, `${label}：不泄漏内部码`);
      check.equal(state.invalid, 'true', `${label}：aria-invalid`); check.ok(state.described.some(id => id.startsWith('field-error')), `${label}：aria-describedby 指向错误`); check.ok(state.described.includes('skill-import-path-hint'), `${label}：格式提示一直关联`); check.equal(state.focused, true, `${label}：焦点回到路径框`);
      check.equal(await phase(page), 'idle', `${label}：没有进入预览`);
    }
    check.equal(bodies.length, 0, '校验不过不请求后端');
    await pathInput(page).fill('/tmp/anything'); check.equal((await fieldState(page)).errors.length, 0, '一改输入就清掉错误'); const cleared = await fieldState(page); check.equal(cleared.invalid, null); check.deepEqual(cleared.described, ['skill-import-path-hint'], '清掉错误后仍保留格式提示');
    await pathInput(page).fill('  /tmp/not-here-' + Date.now() + '  '); await previewButton(page).click();
    await dialog(page).locator('[data-field-error="sourcePath"]').waitFor(); check.equal(bodies.length, 1); check.equal(bodies[0].action.type, 'skill.import'); check.ok(!/^\s|\s$/.test(bodies[0].action.sourcePath), '首尾空格已去掉'); check.deepEqual(Object.keys(bodies[0].action).sort(), ['scope', 'sourcePath', 'type'], '只传 type / scope / sourcePath');
    const failed = await fieldState(page); check.equal(failed.errors.length, 1, '后端 400（路径不存在）也落在路径框'); check.equal(failed.invalid, 'true'); check.equal(failed.focused, true); check.equal(await phase(page), 'failed');
    check.deepEqual(await skillDirs(fixture), before, '没有写盘');
  } },
  { id: 'ext-pr8-03', priority: 'P0', widths: [1440], ...GATE, title: '导入一个文件夹：预览（只读）→ 导入中（锁定、可朗读）→ 成功回执，复制到共享来源，来源不变；撤销经 operation.restore 预览确认', async run({ page, url, assert: check, fixture }) {
    const source = await makeSkill(fixture, 'imp-ok', 'e2e-imported'), original = await fsp.readFile(path.join(source, 'SKILL.md'), 'utf8'), bodies = prepareBodies(page), before = await skillDirs(fixture);
    await openImport(page, url);
    await pathInput(page).fill(`  ${source}  `); await previewButton(page).click(); await applyButton(page).waitFor();
    check.equal(await phase(page), 'ready'); check.deepEqual(await skillDirs(fixture), before, '预览不写盘'); check.equal(await dialog(page).locator('[data-import-conflict]').count(), 0);
    check.match(await dialog(page).innerText(), /e2e-imported/, '预览里能看到目标 Skill 名');
    check.equal(await pathInput(page).inputValue(), source, '输入框写回去掉空格后的路径');
    // 导入中：慢一点的 actions 响应，期间表单锁定、状态朗读（role=status）
    let release; const hold = new Promise(resolve => { release = resolve; });
    await page.route(/\/api\/extensions\/actions/, async route => { await hold; await route.continue(); });
    await applyButton(page).click();
    await page.waitForFunction(() => document.querySelector('[data-skill-import-form]')?.dataset.phase === 'importing');
    check.equal(await pathInput(page).evaluate(input => input.readOnly), true, '导入中路径框只读'); check.equal(await previewButton(page).isDisabled(), true); check.equal(await applyButton(page).isDisabled(), true, '导入中不能重复提交');
    check.match(await dialog(page).locator('[data-import-status]').innerText(), /导入/); check.equal(await dialog(page).locator('[data-import-status]').getAttribute('role'), 'status');
    release(); await gone(page); await page.unroute(/\/api\/extensions\/actions/);
    check.match(await toast(page).innerText(), /已导入 Skill「e2e-imported」/);
    check.ok((await skillDirs(fixture)).includes('e2e-imported'), '目标已出现'); check.equal(await fsp.readFile(path.join(fixture.agents, 'skills/e2e-imported/SKILL.md'), 'utf8'), original); await fsp.access(path.join(fixture.agents, 'skills/e2e-imported/notes.txt'));
    check.equal(await fsp.readFile(path.join(source, 'SKILL.md'), 'utf8'), original, '来源文件夹不被修改');
    check.equal(bodies.filter(body => body.action.type === 'skill.import').length, 1, '预览只请求一次');
    await rows(page).filter({ hasText: 'e2e-imported' }).first().waitFor({ timeout: 8000 });
    await toast(page).getByRole('button', { name: '撤销', exact: true }).click(); await dialog(page).waitFor(); check.ok((await skillDirs(fixture)).includes('e2e-imported'), '撤销先预览，确认前不动文件');
    await dialog(page).getByRole('button', { name: /撤销变更|确认/ }).last().click(); await gone(page);
    await page.waitForFunction(() => !document.querySelector('[data-extension-id*="e2e-imported"]'), null, { timeout: 8000 }).catch(() => {});
    check.equal((await skillDirs(fixture)).includes('e2e-imported'), false, '撤销后目标目录被移走');
  } },
  { id: 'ext-pr8-04', priority: 'P0', widths: [1440], ...GATE, title: '冲突：同名 Skill 已存在 → 预览就提示，「导入」不可用、不覆盖；改路径后冲突提示消失；skillConflict 门控不参与（后端导入冲突不是 E-11）', async run({ page, url, assert: check, fixture }) {
    const source = await makeSkill(fixture, 'imp-dup', 'review-code', { description: '不应覆盖现有 review-code' }), target = path.join(fixture.agents, 'skills/review-code/SKILL.md'), original = await fsp.readFile(target, 'utf8'), before = await skillDirs(fixture);
    await openImport(page, url); await pathInput(page).fill(source); await previewButton(page).click(); await dialog(page).locator('[data-import-conflict]').waitFor();
    check.equal(await phase(page), 'conflict'); const note = await dialog(page).locator('[data-import-conflict]').innerText(); check.ok(note.length > 12);
    const apply = applyButton(page); check.equal(await apply.isDisabled(), true, '冲突时「导入」不可用'); check.ok((await apply.getAttribute('aria-describedby') || '').includes('skill-import-conflict'), '禁用原因通过 aria-describedby 说明');
    check.equal(await dialog(page).locator('[data-import-conflict]').evaluate(node => document.activeElement === node), true, '焦点落到冲突说明，读屏会朗读');
    check.equal(await apply.evaluate(button => button.click()) ?? null, null); check.equal(await phase(page), 'conflict', '强点也不会提交');
    check.equal(await fsp.readFile(target, 'utf8'), original, '不覆盖现有'); check.deepEqual(await skillDirs(fixture), before);
    await pathInput(page).fill(source + '-x'); check.equal(await dialog(page).locator('[data-import-conflict]').count(), 0, '改了路径就收起旧的冲突提示'); check.equal(await phase(page), 'idle'); check.equal(await applyButton(page).count(), 0, '旧预览不能被误用');
  } },
  { id: 'ext-pr8-05', priority: 'P0', widths: [1440], ...GATE, title: '失败：没有 SKILL.md（路径框内错误）；提交被拒（role=alert，可重试，不残留旧预览）；结果未知（500：锁定表单、指向「核对原请求」，核对后落盘一次）', async run({ page, url, assert: check, fixture }) {
    const empty = path.join(fixture.dir, 'import-src', 'imp-empty'); await fsp.mkdir(empty, { recursive: true }); await fsp.writeFile(path.join(empty, 'readme.txt'), 'no skill here');
    const good = await makeSkill(fixture, 'imp-retry', 'e2e-retry'), before = await skillDirs(fixture), failedPhase = () => page.waitForFunction(() => document.querySelector('[data-skill-import-form]')?.dataset.phase === 'failed');
    await openImport(page, url); await pathInput(page).fill(empty); await previewButton(page).click(); await dialog(page).locator('[data-field-error="sourcePath"]').waitFor();
    const noSkill = await fieldState(page); check.equal(noSkill.errors.length, 1); check.equal(noSkill.focused, true); check.equal(await phase(page), 'failed');
    // 提交被拒（4xx）：回到可重试，错误在 role=alert
    await pathInput(page).fill(good); await previewButton(page).click(); await applyButton(page).waitFor();
    await page.route(/\/api\/extensions\/actions/, route => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: '模拟被拒绝', code: 'E2E_REJECTED' }) }));
    await applyButton(page).click(); await failedPhase();
    check.equal(await dialogError(page).getAttribute('role'), 'alert'); check.ok((await dialogError(page).innerText()).length > 3, '失败原因可见'); check.equal(await applyButton(page).count(), 0, '失败后不残留旧预览');
    check.equal(await pathInput(page).inputValue(), good, '路径保留，方便重试'); check.equal(await pathInput(page).evaluate(input => input.readOnly), false); check.equal(await previewButton(page).isDisabled(), false); check.deepEqual(await skillDirs(fixture), before, '失败不写盘');
    await page.unroute(/\/api\/extensions\/actions/);
    await previewButton(page).click(); await applyButton(page).waitFor();
    // 结果未知（5xx）：不能在这里再点；提示去「核对原请求」；核对后（原请求重放）只落盘一次
    let hits = 0; await page.route(/\/api\/extensions\/actions/, route => { hits++; return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '模拟服务中断', code: 'E2E_BROKEN' }) }); });
    await applyButton(page).click(); await page.waitForFunction(() => document.querySelector('[data-skill-import-form]')?.dataset.phase === 'unknown');
    check.equal(await dialogError(page).getAttribute('role'), 'alert'); check.match(await dialogError(page).innerText(), /核对原请求/); check.equal(await pathInput(page).evaluate(input => input.readOnly), true, '锁定路径'); check.equal(await previewButton(page).isDisabled(), true, '不能再提交');
    check.equal(await dialog(page).getByRole('button', { name: '取消', exact: true }).evaluate(node => document.activeElement === node), true, '焦点在可操作的「取消」上'); check.equal(hits, 1);
    await dialog(page).getByRole('button', { name: '取消', exact: true }).click(); await gone(page); await page.unroute(/\/api\/extensions\/actions/);
    await page.locator('[data-retry-submission]').click(); await page.waitForFunction(() => !document.querySelector('[data-retry-submission]'), null, { timeout: 8000 });
    check.ok((await skillDirs(fixture)).includes('e2e-retry'), '核对原请求后导入完成'); check.equal((await skillDirs(fixture)).filter(name => name === 'e2e-retry').length, 1);
  } },
  { id: 'ext-pr8-06', priority: 'P0', widths: [1440], ...GATE, title: '桥接（桩）：有桥接才显示「选择文件夹…」；请求只带合法 requestId；成功只把路径填进输入框；取消静默；出错友好提示并保留手输；超时（≥5 分钟）后恢复；requestId 不符被忽略；进行中不能重复点', async run({ page, url, assert: check, fixture }) {
    await installBridge(page); const source = await makeSkill(fixture, 'imp-bridge', 'e2e-bridge'), bodies = prepareBodies(page), before = await skillDirs(fixture);
    await openImport(page, url);
    check.equal(await pickButton(page).count(), 1, '有桥接：出现「选择文件夹…」'); check.equal(await pathInput(page).count(), 1, '手输框一直都在');
    // 1) 进行中：按钮禁用、不能重复；不符的 requestId 被忽略
    await pickButton(page).click(); let sent = await posts(page);
    check.equal(sent.length, 1); check.deepEqual(Object.keys(sent[0]), ['requestId'], 'postMessage 只带 requestId'); check.match(sent[0].requestId, /^[a-zA-Z0-9_-]{8,100}$/);
    check.equal(await pickButton(page).isDisabled(), true, '进行中按钮禁用'); check.equal(await phase(page), 'picking'); await pickButton(page).evaluate(button => button.click()); check.equal((await posts(page)).length, 1, '重复点击不再发请求');
    check.match(await dialog(page).locator('[data-import-status]').innerText(), /选择|文件夹/, '状态说明在等原生面板');
    await reply(page, { requestId: 'someone-else-1234', ok: true, path: '/wrong/path' }); check.equal(await pathInput(page).inputValue(), '', 'requestId 不符：路径不被填入'); check.equal(await phase(page), 'picking', '仍在等自己的应答');
    // 2) 成功：只填输入框，不自动导入
    await reply(page, { requestId: sent[0].requestId, ok: true, path: source }); check.equal(await pathInput(page).inputValue(), source); check.equal(await phase(page), 'idle'); check.equal(await pickButton(page).isDisabled(), false); check.equal(bodies.length, 0, '填入路径不会自动请求后端');
    // 3) 取消：没有任何错误，输入不变
    await pickButton(page).click(); sent = await posts(page); check.equal(sent.length, 2); check.notEqual(sent[1].requestId, sent[0].requestId, '每次请求用新的 requestId');
    await reply(page, { requestId: sent[1].requestId, ok: false, cancelled: true }); check.equal(await dialogError(page).innerText(), '', '取消不报错'); check.equal((await fieldState(page)).errors.length, 0); check.equal(await pathInput(page).inputValue(), source, '取消不动已填的路径'); check.equal(await pickButton(page).isDisabled(), false);
    // 4) 出错：友好提示（不回显原生错误原文），仍可手输
    await pickButton(page).click(); sent = await posts(page); await reply(page, { requestId: sent[2].requestId, ok: false, error: 'NSError-secret-detail' });
    const message = await dialogError(page).innerText(); check.ok(message.length > 8, '出错有提示'); check.doesNotMatch(message, /NSError|secret/, '不回显原生错误原文'); check.equal(await dialogError(page).getAttribute('role'), 'alert');
    check.equal(await pathInput(page).evaluate(input => !input.readOnly && !input.disabled), true, '出错后仍可手输'); check.equal(await pickButton(page).isDisabled(), false, '出错后可再试');
    // 5) 超时：≥ 5 分钟（站内时钟快进）才放弃；之后恢复按钮；迟到的应答被忽略
    await pickButton(page).click(); sent = await posts(page); check.equal(sent.length, 4);
    await page.clock.fastForward('04:30'); check.equal(await phase(page), 'picking', '不到 5 分钟不放弃'); check.equal(await pickButton(page).isDisabled(), true);
    await page.clock.fastForward('00:40'); await page.waitForFunction(() => document.querySelector('[data-skill-import-form]')?.dataset.phase === 'idle');
    check.equal(await pickButton(page).isDisabled(), false, '超时后按钮恢复'); check.match(await dialogError(page).innerText(), /再试|输入/, '提示重试或手输');
    await pathInput(page).fill(''); await reply(page, { requestId: sent[3].requestId, ok: true, path: '/late/path' }); check.equal(await pathInput(page).inputValue(), '', '超时后迟到的应答被忽略');
    // 6) 之后仍可：选 → 预览 → 导入，路径经过 skill.import（后端校验）
    await pickButton(page).click(); sent = await posts(page); await reply(page, { requestId: sent[4].requestId, ok: true, path: source });
    await previewButton(page).click(); await applyButton(page).waitFor(); await applyButton(page).click(); await gone(page);
    check.equal(bodies.filter(body => body.action.type === 'skill.import' && body.action.sourcePath === source).length, 1, '选到的路径走 skill.import'); check.ok((await skillDirs(fixture)).includes('e2e-bridge')); check.notDeepEqual(await skillDirs(fixture), before);
  } },
  { id: 'ext-pr8-07', priority: 'P1', widths: [1440], ...GATE, title: '桥接（桩）：原生返回空路径 / 缺 path 当作出错；选择进行中改手输路径不受影响；新对话框不继承上一个的选择', async run({ page, url, assert: check, fixture }) {
    await installBridge(page); await makeSkill(fixture, 'imp-bridge2', 'e2e-bridge2');
    await openImport(page, url); await pickButton(page).click(); let sent = await posts(page);
    await reply(page, { requestId: sent[0].requestId, ok: true, path: '   ' }); check.ok((await dialogError(page).innerText()).length > 8, '空路径当作出错'); check.equal(await pathInput(page).inputValue(), '');
    await pickButton(page).click(); sent = await posts(page); await reply(page, { requestId: sent[1].requestId, ok: true }); check.ok((await dialogError(page).innerText()).length > 8, '缺 path 当作出错');
    await pathInput(page).fill('/tmp/typed'); check.equal(await dialogError(page).innerText(), '', '开始输入就清掉旧提示');
    await dialog(page).getByRole('button', { name: '取消', exact: true }).click(); await gone(page);
    await clickAdd(page, '从文件夹导入'); await dialog(page).locator('[data-skill-import-form]').waitFor(); check.equal(await pathInput(page).inputValue(), '', '新对话框是空的'); check.equal(await dialogError(page).innerText(), '');
  } },
];
