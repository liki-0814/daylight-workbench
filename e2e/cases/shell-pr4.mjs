// 0.7 PR-4 (frontend) cases: app shell — sidebar tiers (224 / 208 / 64 rail), 52px sticky material toolbar, reduce-transparency fallback.
// The native side (#24) only sets <html data-reduce-transparency>; here the attribute is toggled by hand, exactly as the injected user script would.
const go = async (page, url, hash = 'today') => { await page.goto(`${url}/#${hash}`); await page.locator('.dl-nav--sidebar').first().waitFor({ timeout: 10000 }); };
const px = value => Number.parseFloat(value);
const alpha = color => { const m = color.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[,/ ]+/).filter(Boolean); return p.length > 3 ? Number(p[3]) : 1; };

export default [
  { id: 'shell-pr4-01', priority: 'P0', title: '侧栏宽度分三档：1440 → 224px、1240 → 208px、760 → 64px 图标栏；图标栏下每个入口仍有可访问名称，页面无横向溢出', async run({ page, url, width, assert: check }) {
    await go(page, url);
    const expected = width >= 1340 ? 224 : width >= 1000 ? 208 : 64;
    const box = await page.locator('.dl-nav--sidebar').first().boundingBox();
    check.equal(Math.round(box.width), expected, `${width}px 视口侧栏应为 ${expected}px，实际 ${box.width}`);
    const nav = await page.locator('.dl-nav--sidebar [data-view]').evaluateAll(els => els.map(el => ({ view: el.dataset.view, name: (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim(), w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })));
    check.equal(nav.filter(item => !item.view.startsWith('project:')).length, 10, '10 个页面入口（任务 / 今天 / 日历 / 专注统计 + 5 个工具 + 设置）');
    for (const item of nav) check.ok(item.name.length > 0, `入口 ${item.view} 没有名称`);
    if (expected === 64) {
      for (const item of nav) check.ok(item.w >= 36 && item.h >= 36, `图标栏入口 ${item.view} 点击区域 ${item.w}×${item.h} 应 ≥ 36`);
      const visibleLabels = await page.locator('.dl-nav--sidebar .dl-nav__label, .dl-nav--sidebar .dl-nav__brand-text').evaluateAll(els => els.filter(el => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== 'hidden'; }).length);
      check.equal(visibleLabels, 0, '图标栏下文字标签只做视觉隐藏');
    } else {
      check.ok(await page.locator('.dl-nav--sidebar .dl-nav__label').first().isVisible(), '宽屏下文字标签可见');
    }
    check.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, '无横向滚动');
  } },
  { id: 'shell-pr4-02', priority: 'P0', title: '顶部工具栏高 52px、粘在窗口顶部（滚动后 top=0）、背景是半透明材质并带 backdrop-filter', async run({ page, url, assert: check }) {
    await go(page, url, 'extensions&tab=mcp');
    await page.locator('.extension-row').first().waitFor({ timeout: 10000 });
    const bar = page.locator('.topbar').first();
    check.equal(Math.round((await bar.boundingBox()).height), 52, '工具栏高度 52px');
    await page.evaluate(() => { const s = document.createElement('div'); s.id = 'e2e-spacer'; s.style.cssText = 'height:3000px;width:1px'; ([...document.querySelectorAll('main')].find(m => m.getClientRects().length) || document.body).append(s); window.scrollTo(0, 400); });
    await page.waitForFunction(() => window.scrollY > 100 || document.documentElement.scrollTop > 100);
    const style = await bar.evaluate(el => { const c = getComputedStyle(el); return { top: el.getBoundingClientRect().top, position: c.position, bg: c.backgroundColor, filter: c.backdropFilter || c.webkitBackdropFilter }; });
    check.equal(style.position, 'sticky');
    check.equal(Math.round(style.top), 0, '滚动后工具栏仍贴着窗口顶部：' + style.top);
    check.ok(alpha(style.bg) < 1 && alpha(style.bg) > 0.5, '背景是半透明材质：' + style.bg);
    check.ok(/blur/.test(style.filter), 'backdrop-filter 含 blur：' + style.filter);
  } },
  { id: 'shell-pr4-03', priority: 'P0', widths: [1440], title: '降低透明度：<html data-reduce-transparency> 出现时工具栏、对话框遮罩立即变不透明且无 backdrop-filter；属性移除后恢复材质', async run({ page, url, assert: check }) {
    await go(page, url, 'extensions&tab=mcp');
    const read = () => page.locator('.topbar').first().evaluate(el => { const c = getComputedStyle(el); return { bg: c.backgroundColor, filter: c.backdropFilter || c.webkitBackdropFilter }; });
    const before = await read();
    check.ok(alpha(before.bg) < 1 && /blur/.test(before.filter), '默认是材质：' + JSON.stringify(before));
    await page.evaluate(() => { document.documentElement.setAttribute('data-reduce-transparency', ''); window.dispatchEvent(new CustomEvent('daylight-display-accessibility', { detail: { reduceTransparency: true } })); });
    const reduced = await read();
    check.equal(alpha(reduced.bg), 1, '降低透明度后背景不透明：' + reduced.bg);
    check.equal(reduced.filter, 'none', '降低透明度后无 backdrop-filter');
    const scrim = await page.evaluate(() => { const c = getComputedStyle(document.documentElement); return c.getPropertyValue('--material').trim(); });
    check.ok(scrim.length > 0, '--material 仍有值（回退到 var(--bg)）：' + scrim);
    await page.evaluate(() => document.documentElement.removeAttribute('data-reduce-transparency'));
    const after = await read();
    check.deepEqual(after, before, '属性移除后恢复原材质');
  } },
];
