// 0.7 设置页 B 版 + 扩展管理 A 版 + 「已接入」新配色（feat/0.7-settings-extensions-ui）。
// 断言：设置页的分区锚点会滚动到对应分区；扩展页 MCP 表按 已启用 / 未启用 分组；「已接入」的行 / 胶囊没有绿色背景。
const rows = page => page.locator('.extension-row');
// 「绿色背景」：G 通道高于 R 和 B（旧的 #F0F4ED = 240,244,237 也算），且不是透明。浅灰 / 白 / 透明都不算。
const greenish = rgb => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(rgb); if (!m) return false; const [r, g, b] = [+m[1], +m[2], +m[3]], a = m[4] === undefined ? 1 : +m[4]; return a > 0.05 && g > r && g > b; };
const backgrounds = (page, selector) => page.$$eval(selector, nodes => nodes.map(node => getComputedStyle(node).backgroundColor));

export default [
  { id: 'ext-ui-01', priority: 'P0', widths: [1240, 1440], title: '设置页 B 版：分区锚点（药丸）点击后滚动到对应分区，当前药丸 aria-current，右栏显示接入状态', async run({ page, url, assert: check }) {
    await page.goto(`${url}/#settings`); await page.locator('#settings-page .settings-pill').first().waitFor({ timeout: 10000 });
    const ids = await page.$$eval('#settings-page .settings-pill', pills => pills.map(pill => pill.dataset.settingsAnchor));
    check.deepEqual(ids, ['top', 'extensions', 'proxy', 'ai', 'focus', 'shortcuts', 'update'], '七个锚点按顺序');
    await page.locator('[data-settings-rail][data-state="ready"]').waitFor({ timeout: 10000 });
    check.match(await page.locator('[data-settings-rail]').innerText(), /接入状态/, '右栏有「接入状态」');
    check.match(await page.locator('[data-settings-connected]').innerText(), /^\d+$/); check.match(await page.locator('[data-settings-total]').innerText(), /\d+/);
    for (const id of ['update', 'shortcuts', 'proxy', 'extensions']) {
      await page.locator(`.settings-pill[data-settings-anchor="${id}"]`).click(); await page.waitForTimeout(700);
      const { top, atEnd } = await page.locator(`#settings-${id}`).evaluate(node => ({ top: node.getBoundingClientRect().top, atEnd: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2 }));
      // 最后几个分区矮于视口时页面滚到底就停了，顶部到不了上方：到底也算滚到。
      check.ok(top >= 0 && (top < 220 || atEnd), `点「${id}」后分区顶部在视口上部或页面已到底（实际 ${Math.round(top)}px）`);
      check.equal(await page.locator(`.settings-pill[data-settings-anchor="${id}"]`).getAttribute('aria-current'), 'true', `${id} 药丸为当前`);
      check.equal(new URL(page.url()).hash, '#settings', '点锚点不改路由 hash');
    }
    await page.locator('.settings-pill[data-settings-anchor="top"]').click(); await page.waitForTimeout(700);
    check.ok(await page.evaluate(() => window.scrollY) < 40, '「全部」回到顶部');
  } },
  { id: 'ext-ui-02', priority: 'P0', widths: [1240, 1440], title: '扩展管理 A 版：MCP 表七列，行按「已启用 / 未启用」分组，组头带数量，已停用的服务在未启用组', async run({ page, url, assert: check }) {
    await page.goto(`${url}/#extensions&tab=mcp`); await rows(page).first().waitFor({ timeout: 10000 });
    const heads = await page.$$eval('.extension-table-head [role="columnheader"]', nodes => nodes.map(node => node.textContent.trim()));
    check.deepEqual(heads, ['名称与 ID', '来源', '命令', '传输', '启用', '状态', '操作'], '列头顺序（最后一列是 ⋯，列头「操作」给读屏）');
    const groups = await page.$$eval('.extension-group', nodes => nodes.map(node => ({ key: node.dataset.extensionGroup, head: node.querySelector('.extension-group-head')?.textContent.replace(/\s+/g, ' ').trim(), rows: [...node.querySelectorAll('.extension-row')].map(row => row.querySelector('.extension-row-open')?.dataset.extensionId) })));
    check.deepEqual(groups.map(group => group.key), ['enabled', 'disabled'], '先已启用，后未启用');
    check.match(groups[0].head, /已启用\s*5/); check.match(groups[1].head, /未启用\s*1/);
    check.deepEqual(groups[1].rows, ['disabled-one'], '已停用的服务在未启用组'); check.equal(groups[0].rows.length, 5); check.ok(!groups[0].rows.includes('disabled-one'));
    const state = await page.$$eval('.extension-group', nodes => nodes.map(node => [...node.querySelectorAll('[role="switch"]')].map(input => input.checked ?? input.getAttribute('aria-checked') === 'true')));
    check.ok(state[0].every(Boolean), '已启用组里的开关都是开的'); check.ok(state[1].every(value => !value), '未启用组里的开关都是关的');
    check.equal(await page.locator('.extension-row .extension-row-more-button').count(), 6, '每行有 ⋯');
    const failureChip = await page.locator('.ui-chip-off').count(); check.equal(failureChip, 1, '已停用用短横线胶囊');
  } },
  { id: 'ext-ui-03', priority: 'P0', widths: [1240, 1440], title: '已接入新配色：扩展表的行、设置页右栏的已接入行、成功胶囊都没有绿色背景；绿点是 teal 主题的 #257C1D', async run({ page, url, assert: check }) {
    await page.goto(`${url}/#extensions&tab=mcp`); await rows(page).first().waitFor({ timeout: 10000 });
    for (const rgb of await backgrounds(page, '.extension-row')) check.ok(!greenish(rgb), `扩展行背景不是绿色：${rgb}`);
    for (const rgb of await backgrounds(page, '.extension-row:hover, .extension-group-head')) check.ok(!greenish(rgb), `悬停 / 组头背景不是绿色：${rgb}`);
    await rows(page).first().hover(); check.ok(!greenish((await backgrounds(page, '.extension-row:hover'))[0] || 'rgb(255,255,255)'), '悬停行不是绿色');
    // 夹具里没有真实安装的 CLI：把状态接口里的 installed 置为 true，让「选中」的软件显示成「已接入」。
    await page.route('**/api/extensions/state', async route => { const response = await route.fetch(); const body = await response.json(); for (const client of body.clients || []) client.installed = true; await route.fulfill({ response, json: body }); });
    await page.goto(`${url}/#settings`); await page.locator('[data-settings-rail][data-state="ready"]').waitFor({ timeout: 10000 });
    const connected = page.locator('.settings-rail-row[data-connection="connected"]');
    check.ok(await connected.count() > 0, '夹具里至少有一个已接入的软件');
    for (const rgb of await backgrounds(page, '.settings-rail-row[data-connection="connected"], .settings-rail-row[data-connection="connected"] *')) check.ok(!greenish(rgb) || rgb.includes('31, 122, 53') || rgb.includes('30, 123, 62') || rgb.includes('37, 124, 29'), `已接入行没有绿底（绿点允许 0.7 的 #1F7A35 、Mist 的 #1E7B3E 或 teal 的 #257C1D）：${rgb}`);
    const solid = page.locator('.settings-rail-row .ui-chip-connected'); check.ok(await solid.count() > 0, '夹具里至少有一个「已接入」胶囊（选中且找到命令）');
    check.equal(await solid.first().locator('.ui-chip-dot').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(37, 124, 29)', '已接入的点是 teal 主题的 --color-success #257C1D（0.7 为 #1F7A35）');
    check.equal(await solid.first().evaluate(node => getComputedStyle(node).color), 'rgb(74, 77, 88)', '已接入的文字是 Mist 的 --color-text-secondary #4A4D58（0.7 为 #3A3A3C）');
    const chipBg = await backgrounds(page, '.settings-rail-row .ui-chip-connected');
    for (const rgb of chipBg) check.equal(rgb, 'rgb(245, 246, 248)', '已接入胶囊底色 Mist 的 --color-bg-sunken #F5F6F8（0.7 为 #F2F2F4）');
  } },
];
