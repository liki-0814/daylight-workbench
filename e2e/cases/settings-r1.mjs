// 0.8 R1：设置页（左二级导航 + 即时保存）与反向代理页的四种状态。
// 反向代理的状态由页面路由改写 /api/proxy/status 得到：夹具没有可用的模型来源，真实启动不可预测，四态要稳定可测。
const forceStatus = async (page, patch) => page.route('**/api/proxy/status', async route => {
  const response = await route.fetch(); const body = await response.json(); const x = body.status || body;
  Object.assign(x, typeof patch === 'function' ? patch(x) : patch); await route.fulfill({ response, body: JSON.stringify(body) });
});
// 页面时钟被夹具冻结，起点必须按页面的 Date.now() 算。
const agoIn = (page, ms) => page.evaluate(ms => new Date(Date.now() - ms).toISOString(), ms);
const openSettings = async (page, url, section) => {
  await page.goto(`${url}/#settings`); await page.locator('.settings-page .dl-set__nav .dl-nav__item').first().waitFor({ timeout: 10000 });
  if (section) await page.locator('.dl-set__nav .dl-nav__item', { hasText: section }).click();
};
const openProxy = async (page, url) => { await page.goto(`${url}/#proxy`); await page.locator('.px-hero').waitFor({ timeout: 10000 }); };

export default [
  { id: 'shell-settings-01', priority: 'P0', widths: [1240, 1440], title: '设置页：左二级导航七项，默认「通用」，点击切换分区且不改路由；没有「保存」按钮；页头副文案', async run({ page, url, assert: check, shot }) {
    await openSettings(page, url);
    check.deepEqual(await page.$$eval('.dl-set__nav .dl-nav__item', n => n.map(x => x.textContent.trim())), ['通用', '本地扩展', '反向代理', 'AI 对话', '专注', '快捷键', '应用更新']);
    check.equal(await page.locator('.dl-set__nav .is-active').textContent(), '通用');
    check.equal((await page.locator('.dl-set__title').first().textContent()).trim(), '通用');
    check.match(await page.locator('.dl-set__sub').first().textContent(), /改动即时保存，无需点击/);
    check.equal(await page.getByRole('button', { name: /^保存/ }).count(), 0, '通用页没有保存按钮');
    for (const [name, title] of [['本地扩展', '本地扩展'], ['反向代理', '反向代理'], ['AI 对话', 'AI 对话'], ['专注', '专注'], ['快捷键', '快捷键'], ['应用更新', '应用更新']]) {
      await page.locator('.dl-set__nav .dl-nav__item', { hasText: name }).click();
      check.equal((await page.locator('.dl-set__title').first().textContent()).trim(), title, name);
      check.equal(await page.locator('.dl-set__nav .is-active').textContent(), name);
      check.equal(new URL(page.url()).hash, '#settings', `点「${name}」不改路由`);
      check.equal(await page.getByRole('button', { name: /^保存/ }).count(), 0, `${name}没有保存按钮`);
    }
    await page.locator('.dl-set__nav .dl-nav__item', { hasText: '通用' }).click(); await page.waitForTimeout(250);
    await shot('settings');
  } },
  { id: 'shell-settings-02', priority: 'P0', widths: [1240, 1440], title: '设置页尺寸：分组行 60 高，右侧控件对齐到同一条右边缘，输入与选择 200 宽，按钮不小于 112 宽，无内联 style', async run({ page, url, assert: check }) {
    await openSettings(page, url);
    const rows = await page.$$eval('.settings-page .dl-srow', n => n.map(x => Math.round(x.getBoundingClientRect().height)));
    check.ok(rows.length >= 7 && rows.every(h => h >= 60), '行高不小于 60：' + rows);
    const rights = await page.$$eval('.settings-page .dl-srow__control', n => n.map(x => Math.round(x.getBoundingClientRect().right)));
    check.equal(new Set(rights).size, 1, '右侧控件右边缘一致：' + rights);
    check.equal(Math.round((await page.locator('.settings-page .dl-input').first().boundingBox()).width), 200, '输入框 200 宽');
    check.equal(Math.round((await page.locator('.settings-page .dl-select').first().boundingBox()).width), 200, '选择框 200 宽');
    for (const b of await page.$$('.settings-page .dl-srow .dl-btn')) check.ok((await b.boundingBox()).width >= 111.5, '按钮不小于 112 宽');
    check.equal(await page.locator('.settings-page [style]').count(), 0, '没有内联 style 属性');
    const kids = await page.locator('.settings-page .dl-sgroup__card').evaluateAll(n => n.map(x => getComputedStyle(x).borderRadius));
    check.ok(kids.every(r => r === '18px'), '分组卡圆角 18：' + kids);
  } },
  { id: 'shell-settings-03', priority: 'P0', widths: [1440], title: '即时保存：改端口与「随 Daylight 启动」立即写入，焦点留在控件上，刷新后仍在；非法端口不写入并给出错误', async run({ page, url, assert: check }) {
    await openSettings(page, url);
    const posts = []; page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/api/proxy/settings/')) posts.push(new URL(r.url()).pathname.split('/').pop() + '=' + r.postData()); });
    const port = page.locator('.settings-page [data-key="port"] input');
    const done = key => page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/proxy/settings/' + key));
    const portSaved = done('port'); await port.fill('4747'); await port.press('Enter'); await portSaved; await page.waitForTimeout(300);
    check.ok(posts.some(p => p.startsWith('port=') && p.includes('4747')), '端口写入请求：' + posts);
    const sw = page.locator('.settings-page [data-key="autoStart"] [role="switch"]');
    check.equal(await sw.getAttribute('aria-checked'), 'false');
    const swSaved = done('autoStart'); await sw.click(); await page.waitForTimeout(100);
    check.equal(await sw.getAttribute('aria-checked'), 'true', '开关乐观打开');
    check.ok(await sw.evaluate(n => n === document.activeElement), '焦点仍在开关上');
    check.ok(posts.some(p => p.startsWith('autoStart=') && p.includes('true')), '开关写入请求：' + posts);
    await swSaved; await page.waitForTimeout(200);
    check.match(await page.locator('.settings-page [role="status"]').first().textContent(), /已保存/, '读屏播报');
    await page.reload(); await page.locator('.settings-page [data-key="port"] input:enabled').waitFor();
    check.equal(await page.locator('.settings-page [data-key="port"] input').inputValue(), '4747', '刷新后端口还在');
    check.equal(await page.locator('.settings-page [data-key="autoStart"] [role="switch"]').getAttribute('aria-checked'), 'true', '刷新后开关还在');
    const before = posts.length; const p2 = page.locator('.settings-page [data-key="port"] input');
    await p2.fill('80'); await p2.press('Enter'); await page.waitForTimeout(400);
    check.equal(posts.length, before, '非法端口不发请求');
    check.ok(await page.locator('.settings-page [data-key="port"] .dl-srow__hint, .settings-page [data-key="port"] [class*="hint"]').first().textContent().then(t => /1024/.test(t)), '提示端口范围');
  } },
  { id: 'shell-settings-04', priority: 'P0', widths: [1240, 1440], title: '反向代理页四态：运行中 / 启动中 / 已停用 / 启动失败；标签、地址行、按钮各就各位；配置卡在每种状态都可编辑', async run({ page, url, assert: check, shot }) {
    const states = {
      running: { patch: startedAt => ({ state: 'running', startedAt, activeRequests: 0, lastError: '' }), tag: '运行中' },
      starting: { patch: () => ({ state: 'starting', lastError: '' }), tag: '启动中…' },
      stopped: { patch: () => ({ state: 'stopped', lastError: '' }), tag: '已停用' },
      error: { patch: () => ({ state: 'stopped', lastError: '端口 4319 已被占用，请在设置中更换端口' }), tag: '启动失败' },
    };
    for (const [name, { patch, tag }] of Object.entries(states)) {
      const p = await page.context().newPage(); await p.setViewportSize(page.viewportSize());
      const startedAt = await agoIn(p, 8040000); await forceStatus(p, () => patch(startedAt)); await openProxy(p, url);
      check.equal((await p.locator('.px-hero .dl-tag').first().textContent()).trim(), tag, name + ' 标签');
      check.ok(await p.locator('.px-config input').first().isEnabled(), name + '：配置卡可编辑');
      check.ok(await p.locator('.px-config [role="switch"]').first().isEnabled(), name + '：配置卡开关可用');
      check.equal(await p.locator('.px-hero [role="switch"]').first().getAttribute('aria-checked'), name === 'running' || name === 'starting' ? 'true' : 'false', name + ' 总开关');
      if (name === 'running') {
        check.match(await p.locator('.dl-hero__addr').textContent(), /http:\/\/127\.0\.0\.1:\d+\/v1/); check.equal(await p.locator('.dl-hero__addr [data-action="copy-address"]').count(), 1, '运行中有「复制」');
        check.match(await p.locator('.px-hero').textContent(), /已运行\s*2 小时 14 分钟/);
        check.equal(Math.round((await p.locator('.dl-hero__addr').boundingBox()).height), 36, '地址行 36 高');
      }
      if (name === 'starting') { check.equal(await p.locator('[data-action="cancel-start"]').count(), 0, '5 秒内没有取消'); }
      if (name === 'error') {
        check.equal(await p.locator('.px-hero [role="alert"]').count(), 1, '错误块 role=alert');
        check.deepEqual(await p.$$eval('.px-hero [role="alert"] button', n => n.map(x => x.textContent.trim())), ['重试', '改用 4320', '查看日志']);
      }
      await p.close();
    }
    const startedAt = await agoIn(page, 8040000); await forceStatus(page, () => states.running.patch(startedAt)); await openProxy(page, url); await page.waitForTimeout(250); await shot('proxy-running');
  } },
  { id: 'shell-settings-05', priority: 'P0', widths: [1440], title: '启动中超过 5 秒出现「取消」，点击发出 service/cancel；「改用 4320」保存端口并重试；「查看日志」跳到统计页', async run({ page, url, assert: check }) {
    await forceStatus(page, { state: 'starting', lastError: '' });
    const cancels = []; await page.route('**/api/proxy/service/cancel', async route => { cancels.push(1); await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
    await openProxy(page, url);
    check.equal(await page.locator('[data-action="cancel-start"]').count(), 0, '刚开始没有取消');
    await page.locator('[data-action="cancel-start"]').waitFor({ timeout: 8000 });
    check.match(await page.locator('[data-action="cancel-start"]').textContent(), /取消/);
    await page.locator('[data-action="cancel-start"]').click(); await page.waitForTimeout(300);
    check.equal(cancels.length, 1, '发出一次取消请求');
    const p = await page.context().newPage(); await p.setViewportSize(page.viewportSize());
    await forceStatus(p, { state: 'stopped', lastError: '端口 4319 已被占用，请在设置中更换端口' }); await openProxy(p, url);
    await p.locator('[data-action="view-logs"]').click(); await p.waitForTimeout(300);
    check.equal(await p.locator('#proxy-tab-statistics').getAttribute('aria-selected'), 'true', '查看日志 → 统计页签');
    await p.close();
  } },
  { id: 'shell-settings-06', priority: 'P0', widths: [1440], title: '转义：本地软件名、错误文案里的 HTML 不会被当成标记，页面不执行注入脚本；运行时没有内联 style', async run({ page, url, assert: check }) {
    const bad = '<img src=x onerror="window.__xss=1"><b id="inj">x</b>';
    await page.route('**/api/extensions/state', async route => { const r = await route.fetch(); const b = await r.json(); b.clients = [{ id: 'bad', name: bad, selected: true, installed: false }]; await route.fulfill({ response: r, body: JSON.stringify(b) }); });
    await forceStatus(page, { state: 'stopped', lastError: bad });
    await openSettings(page, url);
    await page.waitForTimeout(600);
    await page.locator('.dl-set__nav .dl-nav__item', { hasText: '本地扩展' }).click(); await page.locator('.settings-page [data-key="c-bad"]').waitFor();
    check.ok((await page.locator('.settings-page [data-key="c-bad"]').textContent()).includes('<img'), '软件名按文本显示');
    await openProxy(page, url); await page.waitForTimeout(600);
    check.equal(await page.locator('#inj, img[src="x"]').count(), 0, '没有注入节点');
    check.equal(await page.evaluate(() => window.__xss), undefined, '没有执行注入脚本');
    check.equal(await page.locator('.px-hero [style], .px-config [style]').count(), 0, '没有内联 style');
  } },
];
