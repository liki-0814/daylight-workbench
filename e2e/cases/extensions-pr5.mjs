// 0.7 PR-5 (frontend) cases — step A (ext-l-01..09, 16) + step B keyboard (ext-l-10..15) + capabilities mirror (ext-l-17):
// step A: table layout, sticky inspector (360 / 320), 760 overlay with 「‹ 返回清单」, MCP row info, loading / empty / no-match / failure states, no redraw on refresh.
import fs from 'node:fs/promises';
import path from 'node:path';
const rows = page => page.locator('.extension-row');
const open = async (page, url, tab, extra = '') => { await page.goto(`${url}/#extensions&tab=${tab}${extra}`); await rows(page).first().waitFor({ timeout: 10000 }); };
const detail = page => page.locator('.extension-detail:not([hidden])');
const selectRow = async (page, text) => { await rows(page).filter({ hasText: text }).locator('[data-extension-id]').first().click(); await detail(page).waitFor(); await page.waitForFunction(() => !document.querySelector('.extension-detail')?.textContent?.includes('正在读取详情')); };
const inspectorWidth = width => width >= 1340 ? 360 : width >= 1000 ? 320 : 400;
const mockState = (page, mutate, { delay = 0 } = {}) => page.route(/\/api\/extensions\/(state|refresh)(\?.*)?$/, async route => {
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  const response = await route.fetch(), body = await response.json(); mutate(body); await route.fulfill({ response, json: body });
});

const stepA = [
  { id: 'ext-l-01', priority: 'P0', title: '检查器宽度：1440 → 360px、1240 → 320px、760 → 400px 覆盖层；页面无横向溢出', async run({ page, url, width, shot, assert: check }) {
    await open(page, url, 'skills'); await selectRow(page, 'review-code');
    const box = await detail(page).boundingBox();
    check.ok(Math.abs(box.width - inspectorWidth(width)) <= 1, `${width}px 视口检查器应为 ${inspectorWidth(width)}px，实际 ${box.width}`);
    check.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, '无横向滚动');
    await shot('skills-inspector');
  } },
  { id: 'ext-l-02', priority: 'P0', widths: [1240, 1440], title: '检查器吸顶：滚动页面后仍贴在 52px 工具栏下面（E-03），自身可滚动', async run({ page, url, assert: check }) {
    await open(page, url, 'skills'); await selectRow(page, 'review-code');
    check.equal(await detail(page).evaluate(el => getComputedStyle(el).position), 'sticky');
    await page.evaluate(() => { const s = document.createElement('div'); s.id = 'e2e-spacer'; s.style.cssText = 'height:3000px;width:1px'; document.querySelector('.extension-list').append(s); window.scrollTo(0, 500); });
    await page.waitForFunction(() => window.scrollY > 200 || document.documentElement.scrollTop > 200);
    const top = await detail(page).evaluate(el => el.getBoundingClientRect().top);
    check.ok(top >= 52 && top <= 84, '滚动后检查器顶部应在工具栏下方（52–84px），实际 ' + top);
    const overflow = await detail(page).evaluate(el => getComputedStyle(el).overflowY);
    check.equal(overflow, 'auto', '检查器自身滚动');
  } },
  { id: 'ext-l-03', priority: 'P0', widths: [760], widthLocked: true, title: '760：检查器是覆盖层，清单仍在下面；顶部第一个控件是「‹ 返回清单」，点击后收起并清掉路由里的 id（E-22）', async run({ page, url, assert: check, shot }) {
    await open(page, url, 'skills'); const before = await rows(page).count(); await selectRow(page, 'review-code');
    check.equal(await detail(page).evaluate(el => getComputedStyle(el).position), 'fixed', '≤999 是覆盖层');
    check.equal(await rows(page).count(), before, '清单没有被隐藏');
    check.ok(await rows(page).first().isVisible(), '清单行仍可见');
    const box = await detail(page).boundingBox(), vw = await page.evaluate(() => document.documentElement.clientWidth);
    check.ok(Math.abs(box.x + box.width - vw) <= 1 && Math.abs(box.width - 400) <= 1, '覆盖层 400px 贴右：' + JSON.stringify(box));
    const first = detail(page).locator('button, a, input, [tabindex="0"]').first();
    check.equal((await first.innerText()).replace(/\s+/g, ''), '‹返回清单');
    check.equal(await first.evaluate(el => el.getAttribute('data-close-detail') !== null), true);
    const back = page.getByRole('button', { name: '返回清单', exact: true }); check.equal(await back.count(), 1, '只有一个「返回清单」，可访问名称不含 ‹');
    const at = await back.boundingBox(); check.ok(at.y - box.y < 80, '返回按钮在检查器顶部：' + (at.y - box.y));
    await shot('overlay');
    await back.click(); await page.locator('.extension-detail').waitFor({ state: 'hidden' });
    check.equal(await page.evaluate(() => location.hash.includes('id=')), false, '路由里的 id 已清除');
  } },
  { id: 'ext-l-04', priority: 'P1', title: '清单是表格：role=table + 表头 + 行高 ≥ 56；Skill 行文字完整换行、不裁切（E-09 / 0.8 不截断）', async run({ page, url, note, assert: check, shot }) {
    await open(page, url, 'skills');
    const table = page.locator('.extension-list [role=table]'); check.equal(await table.count(), 1);
    check.ok(await table.locator('[role=columnheader]').count() >= 2, '有列标题');
    const heights = await rows(page).evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().height)));
    note('Skill 行高：' + heights.join(','));
    check.ok(heights.every(h => h >= 56), '行高 ≥ 56：' + heights); { const clipped = await rows(page).evaluateAll(els => els.filter(el => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1).length); check.equal(clipped, 0, '文字完整换行显示，行内容不被裁切（0.8：不再截断，不设行高上限）'); }
    await shot('skills-table');
  } },
  { id: 'ext-l-05', priority: 'P1', title: 'MCP 行显示 ID（等宽）、传输类型和探测状态（E-20）', async run({ page, url, assert: check, shot }) {
    await open(page, url, 'mcp');
    const row = rows(page).first();
    const id = await row.locator('code.extension-row-id').innerText(); check.ok(id.length > 0, '行里有 ID：' + id);
    const text = await row.innerText(); check.match(text, /stdio|http/); check.match(text, /尚未检测|握手成功|检测失败|正在检测|用户级配置|已取消|检测超时/);
    // PR-7 把「配置启用/配置禁用」小字换成了可操作的启用开关 + 文字状态：有开关时断言开关和「已启用/已停用」，没有时保持原断言。
    if (await row.locator('[data-mcp-switch]').count()) { check.equal(await row.locator('[data-mcp-switch]').isChecked(), true, 'MCP 行有启用开关'); check.match(await row.locator('[role="switch"]').first().evaluate(el => el.getAttribute('aria-label') || el.closest('label')?.innerText || ''), /启用/); }
    else check.match(text, /配置启用|配置禁用/);
    await shot('mcp-table');
  } },
  { id: 'ext-l-06', priority: 'P0', widths: [1440], title: '加载：<300ms 无骨架；>300ms 骨架（对读屏隐藏）；>1s 出现文字；完成后恢复清单（E-19）', async run({ page, url, assert: check, shot }) {
    await mockState(page, () => {}, { delay: 1800 });
    await page.goto(`${url}/#extensions&tab=skills`); await page.locator('.extension-loading').waitFor({ timeout: 5000 });
    check.equal(await page.locator('.extension-skeleton').count(), 0, '刚开始加载不出骨架（避免闪烁）');
    await page.locator('.extension-skeleton').waitFor({ timeout: 2000 });
    check.equal(await page.locator('.extension-skeleton').getAttribute('aria-hidden'), 'true');
    check.equal(await page.locator('.extension-loading-text').evaluate(el => el.classList.contains('extension-visually-hidden')), true, '1s 前文字仅给读屏');
    await page.waitForFunction(() => { const el = document.querySelector('.extension-loading-text'); return el && !el.classList.contains('extension-visually-hidden'); }, null, { timeout: 3000 });
    await shot('loading');
    await rows(page).first().waitFor({ timeout: 6000 }); check.equal(await page.locator('.extension-skeleton').count(), 0);
  } },
  { id: 'ext-l-07', priority: 'P0', widths: [1440], title: '读取失败：三段式（出了什么/为什么/怎么办），有「重新扫描」；恢复后回到清单', async run({ page, url, assert: check, shot }) {
    let fail = true;
    await page.route(/\/api\/extensions\/state(\?.*)?$/, route => fail ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '验收来源读取失败' }) }) : route.continue());
    await page.goto(`${url}/#extensions&tab=skills`);
    const box = page.locator('.extension-failure'); await box.waitFor({ timeout: 8000 });
    check.match(await box.innerText(), /扩展来源读取失败/); check.match(await box.innerText(), /验收来源读取失败/); check.match(await box.innerText(), /请重新扫描/);
    check.equal(await box.getAttribute('role'), 'alert');
    await shot('failure'); fail = false;
    await box.getByRole('button', { name: '重新扫描', exact: true }).click(); await rows(page).first().waitFor({ timeout: 8000 });
  } },
  { id: 'ext-l-08', priority: 'P0', widths: [1440], title: '空状态与无匹配：没有 Skill → 「还没有 Skill」+「添加 Skill」；搜索无结果 → 「清除筛选」恢复；计数「显示 a / b」；命中高亮', async run({ page, url, assert: check, shot }) {
    await open(page, url, 'skills');
    const total = await rows(page).count();
    check.equal(await page.locator('[data-list-count]').innerText(), `${total} 项`);
    await page.getByRole('searchbox', { name: '搜索扩展' }).fill('review');
    const shown = await rows(page).count(); check.ok(shown >= 1 && shown < total, `过滤后 ${shown}/${total}`);
    check.equal(await page.locator('[data-list-count]').innerText(), `显示 ${shown} / ${total}`);
    check.ok(await page.locator('.extension-list mark').count() >= 1, '命中词高亮');
    check.equal(await page.locator('.extension-list mark').first().evaluate(el => el.textContent.toLowerCase()), 'review');
    await page.getByRole('searchbox', { name: '搜索扩展' }).fill('zzz-no-such'); await page.locator('.extension-no-match').waitFor();
    check.equal(await page.locator('[data-list-count]').innerText(), `显示 0 / ${total}`);
    await shot('no-match');
    await page.getByRole('button', { name: '清除筛选', exact: true }).click(); await rows(page).first().waitFor();
    check.equal(await rows(page).count(), total, '清除筛选后恢复全部');
    check.equal(await page.getByRole('searchbox', { name: '搜索扩展' }).inputValue(), '');
    check.equal(await page.evaluate(() => document.activeElement?.getAttribute('type')), 'search', '清除筛选后焦点回到搜索框');
    await mockState(page, body => { body.skills = []; });
    await page.getByRole('button', { name: '重新扫描扩展', exact: true }).click(); await page.locator('.extension-empty-state').waitFor();
    check.match(await page.locator('.extension-empty-state').innerText(), /还没有 Skill/);
    await shot('empty');
    await page.locator('.extension-empty-state').getByRole('button', { name: '添加 Skill', exact: true }).click();
    await page.locator('dialog[open]').waitFor(); check.match(await page.locator('dialog[open]').innerText(), /新建 Skill/);
  } },
  { id: 'ext-l-09', priority: 'P0', widths: [1440], title: '重新扫描后数据没变，清单 DOM 一个节点都不重绘（E-19：自动刷新不闪）', async run({ page, url, assert: check }) {
    await open(page, url, 'skills'); await selectRow(page, 'review-code');
    check.equal(await page.locator('.extension-list [role="table"], .extension-list[role="table"]').count() > 0, true, '这条用例针对 PR-5 的表格清单（旧 UI 没有表格语义，没有这条前置会在旧 UI 上空转通过）');
    await page.evaluate(() => { window.__mutations = 0; new MutationObserver(list => { window.__mutations += list.length; }).observe(document.querySelector('.extension-list'), { subtree: true, childList: true, attributes: true, characterData: true }); });
    for (let i = 0; i < 2; i++) { await page.getByRole('button', { name: '重新扫描扩展', exact: true }).click(); await page.waitForTimeout(700); }
    check.equal(await page.evaluate(() => window.__mutations), 0, '清单 DOM 变动次数');
  } },
  { id: 'ext-l-16', priority: 'P0', title: 'MCP 配置损坏：只出横幅，列表区不再叠一个「还没有 MCP 服务」空状态（空清单只是读不出来的表象）', async run({ page, url, assert: check, fixture }) {
    const file = path.join(fixture.agents, 'mcp/servers.json'), good = await fs.readFile(file, 'utf8');
    await open(page, url, 'mcp');
    try {
      await fs.writeFile(file, '{ "schemaVersion": 1, "servers": [ ');
      await page.getByRole('button', { name: '重新扫描扩展', exact: true }).evaluate(el => el.click());
      await page.locator('[data-config-banner="MCP_FORMAT"]').waitFor();
      check.equal(await page.locator('.extension-empty-state').count(), 0, '横幅已说明原因，不应再出现空状态');
      check.equal(await page.getByText('还没有 MCP 服务').count(), 0);
    } finally { await fs.writeFile(file, good); }
    await page.getByRole('button', { name: '重新扫描扩展', exact: true }).evaluate(el => el.click()); await page.locator('[data-config-banner]').waitFor({ state: 'detached' });
  } },
];

const activeId = page => page.evaluate(() => document.activeElement?.closest?.('.extension-row')?.querySelector('[data-extension-id]')?.dataset.extensionId || null);
const hashHas = (page, key) => page.evaluate(k => new URLSearchParams(location.hash.split('&').slice(1).join('&')).has(k), key);
const hashId = page => page.evaluate(() => new URLSearchParams(location.hash.split('&').slice(1).join('&')).get('id'));
const ids = page => page.locator('.extension-row-open').evaluateAll(els => els.map(el => el.dataset.extensionId));
const stepB = [
  { id: 'ext-l-10', priority: 'P0', widths: [1440], title: 'roving tabindex：清单里只有一行是 Tab 停靠点，Tab 键不会逐行逐个开关地走完整个清单（E-14）', async run({ page, url, assert: check }) {
    await open(page, url, 'skills'); const all = await ids(page);
    const stops = await page.locator('.extension-row-open').evaluateAll(els => els.map(el => el.tabIndex));
    check.equal(stops.filter(value => value === 0).length, 1, '只有一个 tabindex=0：' + stops); check.equal(stops[0], 0, '默认第一行');
    const strays = await page.locator('.extension-list .extension-row').evaluateAll(rows => rows.slice(1).flatMap(row => [...row.querySelectorAll('input, button, a[href]')].filter(el => el.tabIndex >= 0).map(el => el.tagName)));
    check.equal(strays.length, 0, '非当前行里的开关/按钮都是 tabindex=-1：' + strays);
    await page.locator('.extension-row-open').first().focus();
    const seen = new Set();
    for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); const id = await activeId(page); if (id) seen.add(id); }
    check.deepEqual([...seen].filter(id => id !== all[0]), [], 'Tab 8 次只会经过第一行自己的控件：' + [...seen]);
    // 点击/聚焦别的行的开关后，那一行成为新的停靠点
    await page.locator('.extension-row').nth(3).locator('input[role=switch]').first().focus();
    check.equal(await page.locator('.extension-row-open').nth(3).evaluate(el => el.tabIndex), 0, '聚焦第 4 行的开关后第 4 行成为停靠点');
    check.equal(await page.locator('.extension-row-open').first().evaluate(el => el.tabIndex), -1);
  } },
  { id: 'ext-l-11', priority: 'P0', widths: [1440], title: '方向键：↓↑ 移动一行，Home/End 跳首尾，到头不循环；检查器没打开时不改路由', async run({ page, url, assert: check }) {
    await open(page, url, 'skills'); const all = await ids(page);
    await page.locator('.extension-row-open').first().focus();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); check.equal(await activeId(page), all[2]);
    check.equal(await page.locator('.extension-row-open').nth(2).evaluate(el => el.tabIndex), 0, '停靠点跟着焦点走');
    await page.keyboard.press('ArrowUp'); check.equal(await activeId(page), all[1]);
    await page.keyboard.press('End'); check.equal(await activeId(page), all.at(-1));
    await page.keyboard.press('ArrowDown'); check.equal(await activeId(page), all.at(-1), '到末尾不循环');
    await page.keyboard.press('Home'); check.equal(await activeId(page), all[0]); await page.keyboard.press('ArrowUp'); check.equal(await activeId(page), all[0]);
    check.equal(await hashHas(page, 'id'), false, '检查器没打开时只移动焦点，不改路由');
    check.equal(await page.locator('.extension-detail:not([hidden])').count(), 0);
  } },
  { id: 'ext-l-12', priority: 'P0', widths: [1240, 1440], title: '检查器已打开：方向键让选中行和详情跟着走（replaceState，不堆历史）；Return 进检查器；Esc 收起并把焦点还给那一行', async run({ page, url, assert: check }) {
    await open(page, url, 'skills'); const all = await ids(page); const target = all[1], next = all[2];
    await page.locator(`.extension-row-open[data-extension-id="${target}"]`).click(); await detail(page).waitFor();
    const history = await page.evaluate(() => history.length);
    await page.locator(`.extension-row-open[data-extension-id="${target}"]`).focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(id => new URLSearchParams(location.hash.split('&').slice(1).join('&')).get('id') === id, next);
    check.equal(await page.evaluate(() => history.length), history, '方向键移动选中行用 replaceState，不增加历史');
    check.equal(await page.locator('.extension-row.selected').count(), 1); check.equal(await activeId(page), next, '焦点仍在清单行上');
    const nextName = await page.locator(`.extension-row-open[data-extension-id="${next}"] strong`).innerText();
    await page.waitForFunction(name => document.querySelector('.extension-detail')?.textContent?.includes(name) && !document.querySelector('.extension-detail')?.textContent?.includes('正在读取详情'), nextName, { timeout: 4000 });
    await page.keyboard.press('Enter');
    check.equal(await page.evaluate(() => document.activeElement?.classList.contains('extension-detail')), true, 'Return 把焦点放到检查器');
    check.equal(await hashId(page), next, '焦点进检查器不改变选中');
    await page.locator(`.extension-row-open[data-extension-id="${next}"]`).focus(); await page.keyboard.press('Escape');
    await page.locator('.extension-detail').waitFor({ state: 'hidden' });
    check.equal(await hashHas(page, 'id'), false, 'Esc 收起检查器');
    check.equal(await activeId(page), next, 'Esc 后焦点还在刚才那一行');
    await page.locator(`.extension-row-open[data-extension-id="${next}"]`).click(); await detail(page).waitFor();
    await detail(page).locator('button').first().focus(); await page.keyboard.press('Escape'); await page.locator('.extension-detail').waitFor({ state: 'hidden' });
    check.equal(await activeId(page), next, '焦点在检查器里按 Esc，焦点回到那一行');
  } },
  { id: 'ext-l-13', priority: 'P0', widths: [760], widthLocked: true, title: '760：打开覆盖层后焦点进入「‹ 返回清单」；Esc 和点按钮都关闭覆盖层并把焦点还给触发行', async run({ page, url, assert: check }) {
    await open(page, url, 'skills'); const id = (await ids(page))[1];
    await page.locator(`.extension-row-open[data-extension-id="${id}"]`).focus(); await page.keyboard.press('Enter');
    await detail(page).waitFor(); await page.waitForFunction(() => document.activeElement?.classList.contains('extension-back'), null, { timeout: 4000 });
    await page.keyboard.press('Escape'); await page.locator('.extension-detail').waitFor({ state: 'hidden' });
    check.equal(await activeId(page), id, 'Esc 后焦点回到触发行');
    await page.locator(`.extension-row-open[data-extension-id="${id}"]`).click(); await detail(page).waitFor();
    await page.waitForFunction(() => document.activeElement?.classList.contains('extension-back'));
    await page.keyboard.press('Enter'); await page.locator('.extension-detail').waitFor({ state: 'hidden' });
    check.equal(await activeId(page), id, '点「返回清单」后焦点回到触发行');
  } },
  { id: 'ext-l-14', priority: 'P1', widths: [1440], title: '⌘F / Ctrl+F 聚焦并全选搜索框；有对话框时不抢焦点', async run({ page, url, assert: check }) {
    await open(page, url, 'skills'); const search = page.getByRole('searchbox', { name: '搜索扩展' });
    await search.fill('review'); await page.locator('.extension-row-open').first().focus();
    for (const chord of ['Control+f', 'Meta+f']) {
      await page.locator('.extension-row-open').first().focus(); await page.keyboard.press(chord);
      check.equal(await page.evaluate(() => document.activeElement?.type), 'search', chord + ' 聚焦搜索框');
      check.equal(await search.evaluate(el => el.selectionStart === 0 && el.selectionEnd === el.value.length), true, chord + ' 全选');
    }
    await page.getByRole('button', { name: '清除搜索', exact: true }).click();
    await page.locator('.extension-row-open').first().click(); await detail(page).waitFor(); await detail(page).locator('[data-edit]').click(); await page.locator('dialog[open]').waitFor();
    await page.keyboard.press('Control+f');
    check.equal(await page.evaluate(() => document.activeElement?.closest('dialog') !== null), true, '对话框打开时 ⌘F 不抢焦点');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    check.equal(await hashHas(page, 'id'), true, 'Esc 只关闭对话框，不收起检查器');
  } },
  { id: 'ext-l-15', priority: 'P1', widths: [1440], title: '搜索框里按 Esc 只清除搜索，不收起检查器；点清单里的行不会让焦点丢到 body', async run({ page, url, assert: check }) {
    await open(page, url, 'skills'); await page.locator('.extension-row-open').first().click(); await detail(page).waitFor();
    check.equal(await page.locator('.extension-row[role="row"]').count() > 0, true, '这条用例针对 PR-5 的表格清单（旧 UI 没有 role=row，没有这条前置会在旧 UI 上空转通过）');
    const search = page.getByRole('searchbox', { name: '搜索扩展' }); await search.fill('re'); await search.press('Escape');
    check.equal(await search.inputValue(), ''); check.equal(await hashHas(page, 'id'), true, '检查器仍然打开');
    await search.press('Escape'); check.equal(await hashHas(page, 'id'), true, '搜索框里的 Esc 不收起检查器');
    await page.locator('.extension-row-open').nth(1).click();
    check.equal(await page.evaluate(() => document.activeElement?.tagName), 'BUTTON', '点行后焦点还在行按钮上（不是 body）');
  } },
  { id: 'ext-l-17', priority: 'P0', title: '能力统一到 extensions.*：镜像里的 extensions.reveal / extensions.restoreBackup 决定「在访达中显示」「从备份恢复…」；缺 reveal（不支持访达）时仍有「复制路径」；非 true 值一律不显示；旧的顶层镜像仍兼容', async run({ page, url, assert: check, fixture }) {
    const file = path.join(fixture.agents, 'mcp/servers.json'), good = await fs.readFile(file, 'utf8');
    let capabilities; const rescan = async () => { const done = page.waitForResponse(response => /\/api\/extensions\/refresh/.test(response.url())); await page.getByRole('button', { name: '重新扫描扩展', exact: true }).evaluate(el => el.click()); await done; await page.waitForTimeout(300); };   // 等到刷新响应并渲染完，再断言「没有按钮」——否则上一轮的旧 DOM 会让否定断言空过（PR-6 反向验证发现）
    const banner = () => page.locator('[data-config-banner="MCP_FORMAT"]'), names = async () => (await banner().getByRole('button').allInnerTexts()).map(text => text.trim());
    await page.route(/\/api\/extensions\/(state|refresh)(\?.*)?$/, async route => {
      const response = await route.fetch(), body = await response.json(); body.capabilities = capabilities; await route.fulfill({ response, json: body });
    });
    capabilities = { extensions: { reveal: true, restoreBackup: true } };
    await open(page, url, 'mcp');
    try {
      await fs.writeFile(file, '{ "schemaVersion": 1, "servers": [ '); await rescan(); await banner().waitFor();
      check.deepEqual(await names(), ['重新扫描', '在访达中显示', '从备份恢复…'], 'extensions.reveal / restoreBackup 为 true：两个按钮都在，没有「复制路径」');
      capabilities = { extensions: { restoreBackup: true } }; await rescan(); await page.waitForFunction(() => !document.querySelector('[data-extension-reveal]'));
      check.deepEqual(await names(), ['重新扫描', '复制路径', '从备份恢复…'], '没有 extensions.reveal（不支持访达）：改用「复制路径」，仍可从备份恢复');
      capabilities = { extensions: { reveal: 'true', restoreBackup: 1 } }; await rescan(); await page.waitForFunction(() => !document.querySelector('[data-extension-restore-backup]'));
      check.deepEqual(await names(), ['重新扫描', '复制路径'], '字符串 "true" / 数字 1 都不算支持');
      capabilities = undefined; await rescan(); await page.waitForFunction(() => !document.querySelector('[data-extension-restore-backup]'));
      check.deepEqual(await names(), ['重新扫描', '复制路径'], '没有 capabilities：只有基础按钮');
      // PR-6（Jevis 决定 1）：只读嵌套的 extensions.*，顶层扁平键不再兜底。同一用例在 PR-5 的构建（仍兼容扁平镜像）上也成立，所以按构建分支。
      const nestedOnly = (await page.locator('[data-staging-bar]').count()) > 0;
      capabilities = { restoreBackup: true, reveal: true }; await rescan();
      if (nestedOnly) { await page.waitForFunction(() => !document.querySelector('[data-extension-reveal]') && !document.querySelector('[data-extension-restore-backup]')); check.deepEqual(await names(), ['重新扫描', '复制路径'], '顶层扁平键 capabilities.reveal / restoreBackup 不再算数（PR-6：只认 extensions.*）'); }
      else { await page.waitForFunction(() => document.querySelector('[data-extension-reveal]')); check.deepEqual(await names(), ['重新扫描', '在访达中显示', '从备份恢复…'], '旧的顶层镜像（#36 498c48f 及之前的形状）仍然兼容（PR-5 构建）'); }
      capabilities = { extensions: { reveal: true, restoreBackup: true }, reveal: false, restoreBackup: false }; await rescan(); await page.waitForFunction(() => document.querySelector('[data-extension-reveal]'));
      check.deepEqual(await names(), ['重新扫描', '在访达中显示', '从备份恢复…'], '嵌套为 true 时，扁平键写 false 也不影响');
    } finally { await fs.writeFile(file, good); }
    capabilities = {}; await rescan(); await page.locator('[data-config-banner]').waitFor({ state: 'detached' });
  } },
];
export default [...stepA, ...stepB];
