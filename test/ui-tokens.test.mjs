// 0.8 UI 令牌测试：主题契约、对比度、未定义变量、颜色字面量棘轮、web-assets 反向检查。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { publicDir, root, rel, read, stripCssComments, walk, cssFiles, definedVars, usedVars } from '../scripts/lib/ui-scan.mjs';
import { currentCounts, compare } from '../scripts/lint-ui.mjs';
import { diff as assetDiff } from '../scripts/sync-web-assets.mjs';

const themeCss = stripCssComments(read(path.join(publicDir, 'ui/tokens/themes/mist.css')));
const blocks = (css, selectorStart) => {
  const out = [];
  for (const m of css.matchAll(/(^|\n)([^{}\n@][^{}]*)\{([^{}]*)\}/g)) if (m[2].trim().startsWith(selectorStart)) out.push(m[3]);
  return out;
};
const declarations = body => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const light = declarations(blocks(themeCss, ':root, [data-theme="light"]')[0]);
const dark = declarations(blocks(themeCss, '[data-theme="dark"]')[0]);

// ---------- WCAG ----------
const parse = value => {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) return { r: parseInt(hex[1].slice(0, 2), 16), g: parseInt(hex[1].slice(2, 4), 16), b: parseInt(hex[1].slice(4), 16), a: 1 };
  const rgba = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)$/);
  if (rgba) return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: rgba[4] === undefined ? 1 : +rgba[4] };
  throw new Error('cannot parse colour ' + value);
};
const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
const lum = ({ r, g, b }) => [r, g, b].map(c => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((s, c, i) => s + c * [.2126, .7152, .0722][i], 0);
const ratio = (fg, bg) => { const base = parse(bg), top = over(parse(fg), base), a = lum(top), b = lum(base); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };

test('主题文件：light / dark 两套的 --color-* 名字完全一致', () => {
  const names = vars => Object.keys(vars).filter(n => n.startsWith('--color-')).sort();
  const missing = names(light).filter(n => !(n in dark)), extra = names(dark).filter(n => !(n in light));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
});

test('语义层与旧名别名引用的变量都有定义（主题 / semantic / 旧名）', () => {
  const defined = definedVars();
  const refs = ['semantic.css', 'legacy-aliases.css'].flatMap(file =>
    [...stripCssComments(read(path.join(publicDir, 'ui/tokens', file))).matchAll(/var\(\s*(--[\w-]+)/g)].map(m => file + ' ' + m[1]));
  const bad = refs.filter(ref => !defined.has(ref.split(' ')[1]));
  assert.deepEqual(bad, []);
});

test('Mist 提供全部「毛玻璃」与信息色变量（Sage v2 之后）', () => {
  for (const name of ['--material-sidebar-bg', '--material-toolbar-bg', '--material-popover-bg', '--material-toolbar-filter', '--material-toolbar-solid',
    '--color-info', '--color-info-subtle', '--color-info-text', '--color-switch-off', '--color-switch-off-border']) assert.ok(name in light, name + ' 缺失（light）');
});

test('对比度：正文 ≥ 4.5:1，控件边界 / 开关 ≥ 3:1（light）', () => {
  const bgs = ['--color-bg-app', '--color-bg-surface', '--color-bg-sunken', '--color-bg-sidebar'].map(n => [n, light[n]]);
  const text = ['--color-text-primary', '--color-text-secondary', '--color-text-tertiary', '--color-accent-text', '--color-success-text', '--color-warning-text', '--color-error-text', '--color-info-text'];
  for (const [bgName, bg] of bgs) for (const name of text) assert.ok(ratio(light[name], bg) >= 4.5, `${name} on ${bgName}: ${ratio(light[name], bg).toFixed(2)}`);
  assert.ok(ratio(light['--color-text-on-accent'], light['--color-accent']) >= 4.5, 'on-accent / accent');
  assert.ok(ratio(light['--color-control-border'], light['--color-bg-surface']) >= 3, 'control-border / surface');
  assert.ok(ratio(light['--color-switch-off-border'], light['--color-switch-off']) >= 3, 'switch-off-border / switch-off');
  assert.ok(ratio(light['--color-switch-off-border'], light['--color-bg-surface']) >= 3, 'switch-off-border / surface');
  // 焦点环：内圈 accent 对页面底 ≥ 3:1（semantic.css 的 --shadow-focus 内圈）
  assert.ok(ratio(light['--color-accent'], light['--color-bg-app']) >= 3, 'focus inner ring / app');
});

test('对比度：dark 主题文字（为日后启用深色守住底线）', () => {
  for (const name of ['--color-text-primary', '--color-text-secondary', '--color-text-tertiary', '--color-accent-text', '--color-info-text'])
    assert.ok(ratio(dark[name], dark['--color-bg-surface']) >= 4.5, `${name} dark: ${ratio(dark[name], dark['--color-bg-surface']).toFixed(2)}`);
});

test('日光刻度当前线 --daylight-now 在四个时段色上 ≥ 3:1（线 + 光晕）', () => {
  const now = light['--color-text-primary'];
  for (const sun of ['--sun-night', '--sun-dawn', '--sun-noon', '--sun-dusk'])
    assert.ok(ratio(now, light[sun]) >= 3 || ratio(light['--color-bg-app'], light[sun]) >= 3, `${sun}: line ${ratio(now, light[sun]).toFixed(2)} halo ${ratio(light['--color-bg-app'], light[sun]).toFixed(2)}`);
  assert.match(read(path.join(publicDir, 'ui/tokens/semantic.css')), /--daylight-now:\s*var\(--color-text-primary\)/);
});

test('强制浅色：theme-boot 同步固定 data-theme=light，并已挂到两张入口页', () => {
  const dataset = {};
  new Function('document', read(path.join(publicDir, 'ui/theme-boot.js')))({ documentElement: { dataset } });
  assert.equal(dataset.theme, 'light');
  for (const page of ['index.html', 'quick.html']) assert.match(read(path.join(publicDir, page)), /<script src="\/ui\/theme-boot\.js"><\/script>/);
});

test('降低透明度：原生壳设置的是空值属性，semantic.css 补上了回退', () => {
  assert.match(read(path.join(publicDir, 'ui/tokens/semantic.css')), /:root:root\[data-reduce-transparency\]\s*\{[^}]*--material-toolbar-bg:\s*var\(--material-toolbar-solid\)/);
});

test('未定义变量：public 下没有 var(--x)（无后备值）指向任何地方都没声明的名字', () => {
  const defined = definedVars();
  const bad = [...new Set(usedVars().filter(u => !defined.has(u.name)).map(u => `${u.name} @ ${u.file}`))];
  assert.deepEqual(bad, []);
});

test('lint-ui：颜色字面量只降不升（基线 scripts/lint-ui-baseline.json）', () => {
  const baseline = JSON.parse(readFileSync(path.join(root, 'scripts/lint-ui-baseline.json'), 'utf8'));
  assert.deepEqual(compare(currentCounts(), baseline).worse, []);
});

test('lint-ui 自检：新增字面量会被棘轮抓住', () => {
  assert.equal(compare({ 'a.css': 3 }, { 'a.css': 2 }).worse.length, 1);
  assert.equal(compare({ 'new.css': 1 }, {}).worse.length, 1);
  assert.equal(compare({ 'a.css': 1 }, { 'a.css': 2 }).worse.length, 0);
});

test('web-assets 反向检查：public/ui 下每个文件都登记，登记的 /ui/ 条目都存在', () => {
  const { missing, dangling } = assetDiff();
  assert.deepEqual({ missing, dangling }, { missing: [], dangling: [] });
});

test('web-assets 反向检查：页面 CSS @import 链上的文件都登记了（否则打包后 404）', () => {
  const assets = JSON.parse(readFileSync(path.join(root, 'core/web-assets.json'), 'utf8'));
  const seen = new Set(), queue = [...read(path.join(publicDir, 'index.html')).matchAll(/href="(\/[^"]+\.css)"/g)].map(m => m[1]);
  const problems = [];
  while (queue.length) {
    const url = queue.pop();
    if (seen.has(url)) continue; seen.add(url);
    if (!assets[url]) { problems.push(url); continue; }
    const file = path.join(publicDir, assets[url]);
    for (const m of stripCssComments(read(file)).matchAll(/@import\s+(?:url\()?["']([^"']+)["']/g)) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(url), m[1])));
  }
  assert.deepEqual(problems, []);
});

test('未选候选主题不会被任何 @import 引用', () => {
  for (const file of cssFiles()) assert.doesNotMatch(read(file), /_candidates/, rel(file));
});

test('--space-N 重命名（PR-C）：N 就是像素值；用到的 --space-N 都是 Mist 的像素刻度', () => {
  const files = walk(publicDir, f => /\.(css|js|html)$/.test(f) && !rel(f).startsWith('ui/'));
  const px = new Set(Object.keys(light).filter(n => /^--space-\d+$/.test(n)));
  const stray = [...new Set(files.flatMap(f => [...read(f).matchAll(/--space-\d+(?![\w-])/g)].filter(m => !px.has(m[0])).map(m => m[0] + ' @ ' + rel(f))))];
  assert.deepEqual(stray, [], '用到了 Mist 没有的 --space-N（旧序号写法？）');
  const ds = declarationsOf(read(path.join(publicDir, 'design-system.css')));
  for (const [name, value] of Object.entries(ds)) if (/^--space-\d+$/.test(name)) assert.equal(value, name.slice(8) + 'px', name);
  assert.ok(Object.keys(ds).filter(n => /^--space-\d+$/.test(n)).length >= 9);
});
function declarationsOf(css) { return declarations(stripCssComments(css)); }
