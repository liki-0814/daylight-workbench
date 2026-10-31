// 0.8 R1：组件库的 DOM 行为用例（单测在 node 里跑不了 DOM，这里在真实页面里挂载组件）：
//   mount → 用户操作 → 恰好一次 ui:change 且 detail 合法；update（morph 重绘）一次也不派发；cancelable 回滚；select / dialog 键盘；<link> 顺序打乱后计算值不变。
const host = `(async () => {
  const [{ morph }, events, html] = await Promise.all([import('/ui/core/morph.js'), import('/ui/core/events.js'), import('/ui/core/html.js')]);
  window.__ui = { morph, ...events, ...html, seen: [], mount(markup) { const el = document.createElement('div'); el.id = 'ui-host'; Object.assign(el.style, { position: 'fixed', top: '120px', left: '420px', zIndex: '9999', background: 'white', padding: '8px' }); document.body.append(el); el.innerHTML = String(markup); return el; } };
  addEventListener('ui:change', e => window.__ui.seen.push({ type: e.type, detail: e.detail, cancelable: e.cancelable, bubbles: e.bubbles, target: e.target.getAttribute('name') || e.target.className }), true);
  for (const verb of ['select', 'open', 'close', 'dismiss']) addEventListener('ui:' + verb, e => window.__ui.seen.push({ type: e.type, detail: e.detail, cancelable: e.cancelable }), true);
})()`;
const prepare = async (page, url) => { await page.goto(`${url}/#today`); await page.evaluate(host); };
// CSP 禁 eval：组件用 (模块, 导出名, props) 调用；render(extra) 以合并后的 props 重新生成标记，供 morph 使用
const mount = (page, module, name, props) => page.evaluate(async ([module, name, props]) => {
  const mod = await import(module); window.__ui.render = extra => mod[name]({ ...props, ...extra });
  window.__ui.el = window.__ui.mount(window.__ui.render({})); return true;
}, [module, name, props]);
const seen = page => page.evaluate(() => window.__ui.seen);
const clear = page => page.evaluate(() => { window.__ui.seen.length = 0; });
const assertChange = async (page, check, expected, label) => {
  const events = (await seen(page)).filter(e => e.type === 'ui:change');
  check.equal(events.length, 1, `${label}: 恰好一次 ui:change，实际 ${events.length}`);
  const bad = await page.evaluate(detail => window.__ui.detailErrors(detail), events[0].detail);
  check.deepEqual(bad, [], `${label}: detail 不合法 ${bad}`);
  check.equal(events[0].cancelable, true, `${label}: ui:change 可取消`);
  check.ok(['user', 'keyboard'].includes(events[0].detail.source), `${label}: source`);
  for (const [key, value] of Object.entries(expected)) check.deepEqual(events[0].detail[key], value, `${label}: detail.${key}`);
};
const updateSilently = async (page, check, label, props) => {
  await clear(page);
  await page.evaluate(props => window.__ui.morph(window.__ui.el, window.__ui.render(props)), props);
  check.equal((await seen(page)).length, 0, `${label}: update（morph 重绘）不应派发任何 ui:* 事件`);
};

export default [
  { id: 'ui-lib-01', priority: 'P0', widths: [1440], title: 'switch / checkbox：用户点击 → 恰好一次 ui:change（合法 detail、可取消）；update 不派发，且按新 props 更新 aria-checked', async run({ page, url, assert: check }) {
    await prepare(page, url);
    await mount(page, '/ui/components/switch/switch.js', 'switchControl', { name: "s", label: "开关", checked: false });
    await page.locator('#ui-host [role=switch]').click();
    await assertChange(page, check, { value: true, previousValue: false, source: 'user' }, 'switch 点击');
    check.equal(await page.locator('#ui-host [role=switch]').getAttribute('aria-checked'), 'true');
    await clear(page);
    await page.locator('#ui-host [role=switch]').focus(); await page.keyboard.press('Space');
    await assertChange(page, check, { value: false, previousValue: true, source: 'keyboard' }, 'switch 空格');
    await page.evaluate(() => document.getElementById('ui-host').remove());
    await mount(page, '/ui/components/switch/switch.js', 'switchControl', { name: "s", label: "开关", checked: false });
    await updateSilently(page, check, 'switch', { checked: true });
    await page.evaluate(() => document.getElementById('ui-host').remove());
    await mount(page, '/ui/components/checkbox/checkbox.js', 'checkbox', { name: "c", label: "勾选", checked: false });
    await page.locator('#ui-host [role=checkbox]').click();
    await assertChange(page, check, { value: true, previousValue: false, source: 'user' }, 'checkbox');
    await updateSilently(page, check, 'checkbox', {});
  } },
  { id: 'ui-lib-02', priority: 'P0', widths: [1440], title: 'ui:change 被 preventDefault 时控件回滚到原值（switch / checkbox / segmented / select）', async run({ page, url, assert: check }) {
    await prepare(page, url);
    await page.evaluate(() => addEventListener('ui:change', e => e.preventDefault(), true));
    await mount(page, '/ui/components/switch/switch.js', 'switchControl', { name: "s", label: "开关", checked: false });
    await page.locator('#ui-host [role=switch]').click();
    check.equal(await page.locator('#ui-host [role=switch]').getAttribute('aria-checked'), 'false', 'switch 回滚');
    await page.evaluate(() => document.getElementById('ui-host').remove());
    await mount(page, '/ui/components/segmented/segmented.js', 'segmented', { name: "g", value: "a", label: "分段", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] });
    await page.locator('#ui-host [role=radio]').nth(1).click();
    check.equal(await page.locator('#ui-host [role=radio][aria-checked=true]').innerText(), 'A', 'segmented 回滚');
    await page.evaluate(() => document.getElementById('ui-host').remove());
    await mount(page, '/ui/components/select/select.js', 'select', { name: "p", value: "a", label: "选", options: [{ value: "a", label: "甲" }, { value: "b", label: "乙" }] });
    await page.locator('#ui-host .dl-select__trigger').click();
    await page.locator('#ui-host [role=option]').nth(1).click();
    check.match(await page.locator('#ui-host .dl-select__trigger').innerText(), /甲/, 'select 回滚到甲');
  } },
  { id: 'ui-lib-03', priority: 'P0', widths: [1440, 1240], title: 'segmented：方向键移动并选择 → 一次 ui:change；select：键盘打开 / 选择 / Esc 关闭、菜单向下展开、ui:open / ui:close / ui:change 各一次', async run({ page, url, assert: check }) {
    await prepare(page, url);
    await mount(page, '/ui/components/segmented/segmented.js', 'segmented', { name: "g", value: "a", label: "分段", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C" }] });
    await page.locator('#ui-host [role=radio][aria-checked=true]').focus();
    await page.keyboard.press('ArrowRight');
    await assertChange(page, check, { value: 'b', previousValue: 'a', source: 'keyboard' }, 'segmented →');
    await updateSilently(page, check, 'segmented', { value: 'c' });
    await page.evaluate(() => document.getElementById('ui-host').remove());
    await mount(page, '/ui/components/select/select.js', 'select', { name: "p", value: "a", label: "项目", options: [{ value: "a", label: "甲" }, { value: "b", label: "乙" }, { value: "c", label: "丙" }] });
    const trigger = page.locator('#ui-host .dl-select__trigger');
    await clear(page); await trigger.focus(); await page.keyboard.press('Enter');
    const box = await trigger.boundingBox(), menu = await page.locator('#ui-host .dl-menu').boundingBox();
    check.ok(menu.y >= box.y + box.height - 1, `菜单应在触发器下方：menu.y=${menu.y} trigger.bottom=${box.y + box.height}`);
    check.equal(await trigger.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await assertChange(page, check, { value: 'b', previousValue: 'a' }, 'select 键盘选择');
    const verbs = (await seen(page)).map(e => e.type);
    check.equal(verbs.filter(v => v === 'ui:open').length, 1, 'ui:open 一次：' + verbs); check.equal(verbs.filter(v => v === 'ui:close').length, 1, 'ui:close 一次：' + verbs);
    check.equal(await trigger.getAttribute('aria-expanded'), 'false'); check.equal(await page.evaluate(() => document.activeElement.className.includes('dl-select__trigger')), true, '关闭后焦点回到触发器');
    await clear(page); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
    check.equal((await seen(page)).filter(e => e.type === 'ui:change').length, 0, 'Esc 不改值');
    check.equal(await trigger.getAttribute('aria-expanded'), 'false', 'Esc 关闭');
    await updateSilently(page, check, 'select', { value: 'c' });
  } },
  { id: 'ui-lib-04', priority: 'P0', widths: [1440], title: 'input：change 一次 ui:change（previousValue 正确）；IME 组合中 live 输入不派发；update 不改正在聚焦的输入内容', async run({ page, url, assert: check }) {
    await prepare(page, url);
    await mount(page, '/ui/components/input/input.js', 'input', { name: "t", value: "旧", label: "标题" });
    const field = page.locator('#ui-host input');
    await field.fill('新值'); await field.press('Enter'); await field.blur();
    await assertChange(page, check, { value: '新值', previousValue: '旧' }, 'input');
    await updateSilently(page, check, 'input', { value: '外部值' });
    await page.evaluate(() => document.getElementById('ui-host').remove());
    await mount(page, '/ui/components/input/input.js', 'input', { name: "q", value: "", label: "搜索", live: true });
    await clear(page);
    const live = page.locator('#ui-host input');
    await live.focus();
    await live.evaluate(el => { el.dispatchEvent(new CompositionEvent('compositionstart')); el.value = 'ni'; el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); });
    check.equal((await seen(page)).length, 0, '组合输入中不派发');
    await live.evaluate(el => { el.value = '你'; el.dispatchEvent(new CompositionEvent('compositionend')); el.dispatchEvent(new InputEvent('input', { bubbles: true })); });
    await assertChange(page, check, { value: '你' }, 'live input 组合结束');
    await live.evaluate(el => { el.value = '草稿'; });
    await page.evaluate(() => window.__ui.morph(window.__ui.el, window.__ui.render({})));
    check.equal(await live.inputValue(), '草稿', 'morph 不覆盖正在聚焦的输入内容');
  } },
  { id: 'ui-lib-05', priority: 'P0', widths: [1440], title: 'dialog：Esc → 可取消的 ui:dismiss（取消则不关闭，否则关闭）；背景点击 → ui:dismiss；⌘↵ 触发 data-dialog-submit；焦点回到触发处', async run({ page, url, assert: check }) {
    await prepare(page, url);
    await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<button id="opener">open</button>'); document.getElementById('opener').focus(); });
    await page.evaluate(async () => {
      const { mountDialog } = await import('/ui/components/dialog/dialog.js'); const { html } = await import('/ui/core/html.js');
      window.__dlg = mountDialog({ id: 'e2e-dlg', label: '测试对话框', width: 480, children: html`<button class="x" data-dialog-submit data-action="submit">提交</button>` });
      window.__submitted = 0; document.addEventListener('click', e => { if (e.target.closest('[data-dialog-submit]')) window.__submitted++; });
      window.__dlg.open();
    });
    check.equal(await page.locator('dialog#e2e-dlg').evaluate(el => el.open), true);
    await page.evaluate(() => addEventListener('ui:dismiss', e => { if (window.__block) e.preventDefault(); }, true));
    await page.evaluate(() => { window.__block = true; });
    await clear(page); await page.keyboard.press('Escape');
    check.equal((await seen(page)).filter(e => e.type === 'ui:dismiss').length, 1, 'Esc → 一次 ui:dismiss');
    check.equal(await page.locator('dialog#e2e-dlg').evaluate(el => el.open), true, '被取消时不关闭');
    await page.keyboard.press('Control+Enter');
    check.equal(await page.evaluate(() => window.__submitted), 1, 'Ctrl+Enter 触发提交');
    await page.evaluate(() => { window.__block = false; });
    await page.keyboard.press('Escape');
    check.equal(await page.locator('dialog#e2e-dlg').evaluate(el => el.open), false, '未取消时关闭');
    check.equal(await page.evaluate(() => document.activeElement.id), 'opener', '焦点回到打开前的元素');
    const radius = await page.evaluate(() => { window.__dlg.open(); return getComputedStyle(document.getElementById('e2e-dlg')).borderRadius; });
    check.equal(radius, '20px', '对话框圆角 20');
    await page.mouse.click(5, 5);
    check.ok((await seen(page)).filter(e => e.type === 'ui:dismiss').length >= 2, '背景点击 → ui:dismiss');
  } },
  { id: 'ui-lib-06', priority: 'P0', widths: [1440], title: 'toast：错误 / 警告不自动消失（等待超过 6500ms 仍在），成功会自动消失；× 与操作按钮派发 ui:dismiss / ui:select', async run({ page, url, assert: check }) {
    await prepare(page, url);
    await page.evaluate(async () => {
      const { showToast } = await import('/ui/components/toast/toast.js');
      window.__t = { err: showToast({ message: '保存失败', tone: 'error', actions: [{ label: '重试', value: 'retry' }] }), ok: showToast({ message: '已保存', tone: 'success', timeout: 600 }) };
    });
    await page.waitForTimeout(900);
    check.equal(await page.locator('.dl-toast', { hasText: '已保存' }).count(), 0, '成功提示自动消失');
    check.equal(await page.locator('.dl-toast', { hasText: '保存失败' }).count(), 1);
    await page.waitForTimeout(6900);
    check.equal(await page.locator('.dl-toast', { hasText: '保存失败' }).count(), 1, '错误提示 6.9 秒后仍在');
    await clear(page);
    await page.locator('.dl-toast', { hasText: '保存失败' }).getByRole('button', { name: /关闭/ }).click();
    check.equal(await page.locator('.dl-toast', { hasText: '保存失败' }).count(), 0, '× 关闭');
    check.equal((await seen(page)).filter(e => e.type === 'ui:dismiss').length, 1, '× → 一次 ui:dismiss');
    await page.evaluate(async () => { const { showToast } = await import('/ui/components/toast/toast.js'); showToast({ message: '再试一次', tone: 'warning', actions: [{ label: '重试', value: 'retry' }] }); });
    await clear(page);
    await page.locator('.dl-toast', { hasText: '再试一次' }).getByRole('button', { name: '重试' }).click();
    const picked = (await seen(page)).filter(e => e.type === 'ui:select');
    check.equal(picked.length, 1, '操作按钮 → 一次 ui:select'); check.equal(picked[0].detail.value, 'retry');
  } },
  { id: 'ui-lib-07', priority: 'P0', widths: [1440], title: '令牌优先级由 @layer 决定，不由 <link> 顺序决定：打乱 ui.css / 其它样式的顺序后，令牌与组件的计算值完全一致', async run({ page, url, assert: check }) {
    await prepare(page, url);
    await mount(page, '/ui/components/button/button.js', 'button', { label: "按钮", variant: "primary" });
    const measure = () => page.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
      const root = getComputedStyle(document.documentElement), btn = getComputedStyle(document.querySelector('#ui-host .dl-btn'));
      const names = ['--color-bg-app', '--color-bg-surface', '--color-accent', '--color-info', '--button-radius', '--space-page', '--space-section', '--group-h', '--toolbar-h', '--nav-item-h', '--radius-dialog', '--radius-container', '--radius-menu', '--radius-control', '--control-h', '--min-target', '--motion-fast', '--motion-base', '--color-accent-border', '--sidebar-width'];
      return { tokens: Object.fromEntries(names.map(name => [name, root.getPropertyValue(name).trim()])), btn: { height: btn.height, radius: btn.borderRadius, bg: btn.backgroundColor, color: btn.color, padding: btn.paddingLeft } };
    });
    const reorder = order => page.evaluate(async order => {
      const links = [...document.querySelectorAll('link[rel=stylesheet]')]; const hrefs = links.map(l => l.getAttribute('href'));
      links.forEach(l => l.remove());
      const sorted = order === 'ui-first' ? [...hrefs.filter(h => h.startsWith('/ui/')), ...hrefs.filter(h => !h.startsWith('/ui/'))] : order === 'ui-last' ? [...hrefs.filter(h => !h.startsWith('/ui/')), ...hrefs.filter(h => h.startsWith('/ui/'))] : [...hrefs].reverse();
      await Promise.all(sorted.map(href => new Promise(resolve => { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href; link.onload = link.onerror = resolve; document.head.append(link); })));
    }, order);
    await reorder('ui-first'); const a = await measure();
    await reorder('ui-last'); const b = await measure();
    await reorder('reverse'); const c = await measure();
    check.deepEqual(b, a, 'ui.css 放最后与放最前，计算值应一致');
    check.deepEqual(c, a, '整体倒序后，计算值应一致');
    check.equal(a.tokens['--control-h'], '36px'); check.equal(a.btn.height, '36px', '按钮 36 高');
  } },
];
