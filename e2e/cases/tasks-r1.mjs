// 0.8 R1：任务页 + 新建任务面板（设计 README v3/v5 的列宽与尺寸；创建流程；键盘；错误提示不自动消失）。
const go = async (page, url, hash = 'all') => { await page.goto(`${url}/#${hash}`); await page.locator('#task-page .dl-row').first().waitFor({ timeout: 10000 }); };
const box = async locator => { const b = await locator.boundingBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
const openComposer = async page => { await page.keyboard.press('Meta+k'); await page.locator('#new-task-dialog[open]').waitFor(); };

export default [
  { id: 'shell-pr3-01', priority: 'P0', widths: [1240, 1440], title: '任务行固定列宽：行 44 / 分组头 40 / 工具栏 56；复选 16、编号 56、优先级 20（居中）、截止 76（左对齐）、专注 76；列在所有行里对齐', async run({ page, url, assert: check, shot }) {
    await go(page, url);
    check.equal(Math.round((await box(page.locator('#task-page .dl-row').first())).h), 44, '行高 44');
    check.equal(Math.round((await box(page.locator('#task-page .dl-group').first())).h), 40, '分组头高 40');
    check.equal(Math.round((await box(page.locator('#task-page .dl-toolbar'))).h), 56, '工具栏高 56');
    const cols = await page.locator('#task-page .dl-row').evaluateAll(rows => rows.map(row => [...row.children].map(c => { const r = c.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; })));
    const widths = cols[0].map(c => c[1]);
    const grid = (await page.locator('#task-page .dl-row').first().evaluate(r => getComputedStyle(r).gridTemplateColumns)).split(' ');
    grid[2] = '*'; check.equal(grid.join(' '), '16px 56px * 20px 76px 76px', '网格列 16 / 56 / 弹性 / 20 / 76 / 76');
    check.equal(widths[0], 16, '复选框列 16');
    check.equal(widths[1], 56, '编号列 56'); check.equal(widths[3], 11, '优先级图标 11 宽，居中于 20 宽的列'); check.equal(widths[4], 76, '截止列 76'); check.equal(widths[5], 76, '专注列 76');
    for (const row of cols) check.deepEqual(row.map(c => c[0]), cols[0].map(c => c[0]), '每一行的列左边缘一致');
    const align = await page.locator('#task-page .dl-row').first().evaluate(row => ({ due: getComputedStyle(row.querySelector('.dl-row__due')).textAlign, tabular: getComputedStyle(row.querySelector('.dl-row__due')).fontVariantNumeric, id: getComputedStyle(row.querySelector('.dl-row__id')).fontFamily }));
    check.equal(align.due, 'left'); check.ok(/tabular-nums/.test(align.tabular)); check.ok(/mono/i.test(align.id), '编号用等宽字体：' + align.id);
    await shot('tasks');
  } },
  { id: 'shell-pr3-02', priority: 'P0', title: '点行选中并在右侧检查器显示详情；专注按钮平时不可见、选中后出现；再点同一行不取消', async run({ page, url, assert: check, shot }) {
    await go(page, url);
    const row = page.locator('#task-page .dl-row').first();
    check.equal(await row.locator('.dl-row__action .dl-chip').evaluate(el => getComputedStyle(el).visibility), 'hidden', '未选中且未悬停时专注按钮不可见');
    await page.mouse.move(0, 0);
    await row.click();
    await page.locator('#task-page .dl-insp__title').waitFor();
    check.equal(await page.locator('#task-page .dl-insp__title').textContent(), await row.locator('.dl-row__title').textContent());
    check.ok(await row.evaluate(el => el.classList.contains('is-selected')), '行带选中态');
    await page.mouse.move(0, 0);
    check.equal(await row.locator('.dl-row__action .dl-chip').evaluate(el => getComputedStyle(el).visibility), 'visible', '选中后专注按钮可见');
    await shot('selected');
  } },
  { id: 'shell-pr3-03', priority: 'P0', title: '在搜索框里连续输入时焦点、输入内容和光标不丢；列表随输入过滤', async run({ page, url, assert: check }) {
    await go(page, url);
    const search = page.locator('#task-page input[name="search"]');
    await search.click(); await page.keyboard.type('任务 3', { delay: 30 });
    await page.waitForFunction(() => document.querySelectorAll('#task-page .dl-row').length === 1);
    check.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'search', '焦点仍在搜索框');
    check.equal(await search.inputValue(), '任务 3');
    await page.keyboard.type('x');
    check.equal(await search.inputValue(), '任务 3x', '继续输入没有被重置');
  } },
  { id: 'shell-pr3-04', priority: 'P0', title: '新建任务：⌘K 打开 680 宽居中面板；项目菜单向下展开且可超出面板；⌘↵ 创建；「继续新建」保持打开并清空标题', async run({ page, url, assert: check, shot }) {
    await go(page, url);
    const before = await page.locator('#task-page .dl-row').count();
    await openComposer(page);
    const dlg = page.locator('#new-task-dialog');
    const b = await box(dlg);
    check.equal(Math.round(b.w), 680, '面板宽 680');
    const vw = page.viewportSize().width;
    check.ok(Math.abs(b.x + b.w / 2 - vw / 2) <= 1, '水平居中');
    check.equal(await page.locator('#new-task-dialog [aria-label*="语音"], #new-task-dialog [aria-label*="麦克风"]').count(), 0, '没有麦克风按钮');
    await shot('composer');
    // 项目菜单
    await dlg.locator('[data-name="project"] .dl-chip').click();
    const menu = dlg.locator('[data-name="project"] .dl-menu'); await menu.waitFor();
    const m = await box(menu), t = await box(dlg.locator('[data-name="project"] .dl-chip'));
    check.ok(m.y >= t.y + t.h - 1, '菜单向下展开');
    check.ok(m.y + m.h > b.y + b.h, '菜单可以超出面板底边');
    await shot('composer-menu');
    await page.keyboard.press('Escape');
    check.ok(await menu.isHidden(), 'Esc 收起菜单');
    check.ok(await dlg.evaluate(el => el.open), 'Esc 只收起菜单，面板仍然打开');
    await dlg.locator('[data-name="project"] .dl-chip').click(); await dlg.locator('[data-name="project"] .dl-chip').click();
    check.ok(await dlg.evaluate(el => el.open), '再次点击触发器收起菜单，面板仍然打开');
    // 创建：⌘↵
    await dlg.locator('input[name="title"], textarea[name="title"]').fill('新建流程测试一');
    await page.keyboard.press('Meta+Enter');
    await page.locator('#new-task-dialog').waitFor({ state: 'detached' });
    await page.waitForFunction(n => document.querySelectorAll('#task-page .dl-row').length === n + 1, before);
    // 继续新建
    await openComposer(page);
    await page.locator('#new-task-dialog [data-name="keepOpen"]').click();
    await page.locator('#new-task-dialog [name="title"]').fill('新建流程测试二');
    await page.locator('#new-task-dialog [data-action="create-task"]').click();
    await page.waitForFunction(n => document.querySelectorAll('#task-page .dl-row').length === n + 2, before);
    check.ok(await page.locator('#new-task-dialog').evaluate(el => el.open), '继续新建：面板保持打开');
    check.equal(await page.locator('#new-task-dialog [name="title"]').inputValue(), '', '标题已清空');
    check.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'title', '焦点回到标题');
  } },
  { id: 'shell-pr3-05', priority: 'P0', widths: [1440], title: '新建任务保存失败：错误提示不会自动消失，面板保留输入；成功提示会自动收起', async run({ page, url, assert: check }) {
    await go(page, url);
    await openComposer(page);
    await page.locator('#new-task-dialog [name="title"]').fill('会失败的任务');
    await page.route('**/api/state', route => route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '磁盘已满，无法保存' }) }) : route.continue());
    await page.route('**/api/task-actions', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '磁盘已满，无法保存' }) }));
    await page.keyboard.press('Meta+Enter');
    const toast = page.locator('.dl-toast--error'); await toast.waitFor();
    check.equal(await toast.getAttribute('role'), 'alert');
    await page.clock.fastForward(30000);
    check.equal(await toast.count(), 1, '30 秒后错误提示仍在');
    check.equal(await page.locator('#new-task-dialog [name="title"]').inputValue(), '会失败的任务', '输入保留');
  } },
  { id: 'shell-pr3-06', priority: 'P1', title: '侧栏：项目、日历入口可达；点击切换视图并高亮（aria-current）；每次只有一项高亮', async run({ page, url, assert: check }) {
    await go(page, url);
    await page.locator('.dl-nav--sidebar [data-view^="project:"]').first().click();
    await page.waitForFunction(() => document.querySelector('.dl-nav--sidebar [aria-current]')?.dataset.view.startsWith('project:'));
    check.equal(await page.locator('.dl-nav--sidebar [aria-current]').count(), 1);
    await page.locator('.dl-nav--sidebar [data-view="calendar"]').click();
    await page.waitForFunction(() => document.querySelector('.dl-nav--sidebar [aria-current]')?.dataset.view === 'calendar');
    check.equal(await page.locator('.dl-nav--sidebar [aria-current]').count(), 1);
  } },
  { id: 'shell-pr3-07', priority: 'P0', title: '详情栏：属性下方紧跟「开始专注」「完成」两个主按钮和「更多」菜单；其余操作在菜单里；备注 / 子任务 / 动态分区；子任务可添加、勾选；无文字被截断', async run({ page, url, assert: check, shot }) {
    await go(page, url);
    await page.locator('#task-page .dl-row').first().click();
    await page.locator('#task-page .dl-insp__title').waitFor();
    const geo = await page.evaluate(() => { const r = s => document.querySelector(s).getBoundingClientRect(); const p = r('.dl-insp__props'), a = r('.dl-insp__primary'), b = r('.dl-insp__body'), i = r('.dl-insp'); return { propsBottom: p.bottom, primaryTop: a.top, primaryBottom: a.bottom, bodyTop: b.top, panelBottom: i.bottom, buttons: [...document.querySelectorAll('.dl-insp__primary > .dl-btn')].map(e => e.textContent.trim()), rows: new Set([...document.querySelectorAll('.dl-insp__primary > *')].map(e => Math.round(e.getBoundingClientRect().top))).size }; });
    check.ok(geo.primaryTop - geo.propsBottom <= 24 && geo.primaryTop >= geo.propsBottom, '操作行紧跟属性：' + (geo.primaryTop - geo.propsBottom));
    check.deepEqual(geo.buttons, ['开始专注', '完成'], '只有两个主按钮');
    check.equal(geo.rows, 1, '主按钮和更多在同一行');
    check.ok(geo.primaryBottom <= geo.bodyTop && geo.panelBottom - geo.bodyTop > 0, '分区在操作行下面');
    check.equal(await page.locator('.dl-insp__actions').count(), 0, '没有钉在底部的操作区');
    await page.locator('.dl-insp [data-name="more"] .dl-menubtn__trigger').click();
    const items = await page.locator('.dl-insp [data-name="more"] .dl-menu__item').allTextContents();
    check.deepEqual(items.map(t => t.trim()), ['加入今天', '编辑', '讨论', '相关对话', '删除'], '更多菜单里的其他操作');
    await shot('more-menu');
    await page.locator('.dl-insp [data-name="more"] .dl-menu__item', { hasText: '加入今天' }).click();
    await page.waitForFunction(() => /已加入|今天/.test(document.querySelector('.dl-insp__props').textContent) && !/未加入/.test(document.querySelector('.dl-insp__props').textContent));
    check.deepEqual(await page.locator('.dl-insp .dl-insp__section h3').allTextContents().then(a => a.map(t => t.replace(/\s+/g, ''))), ['备注', '子任务', '动态'].map((t, i) => t), '三个分区');
    const input = page.locator('#subtask-input');
    await input.click(); await page.keyboard.type('买咖啡豆'); await page.keyboard.press('Enter');
    await page.locator('.dl-sub').first().waitFor();
    check.equal(await page.locator('.dl-sub').count(), 1);
    await page.locator('.dl-sub .dl-check').first().click();
    await page.waitForFunction(() => document.querySelector('.dl-sub').classList.contains('is-done'));
    const clipped = await page.evaluate(() => [...document.querySelectorAll('.dl-insp *')].filter(e => e.children.length === 0 && e.offsetWidth > 1 && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1) && e.tagName !== 'INPUT').map(e => e.className));
    check.deepEqual(clipped, [], '详情栏没有被截断的文字');
  } },
];
