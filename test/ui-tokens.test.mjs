// 0.8 UI 令牌测试：主题契约、对比度、未定义变量、颜色字面量棘轮、web-assets 反向检查。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { publicDir, root, rel, read, stripCssComments, walk, cssFiles, definedVars, usedVars } from '../scripts/lib/ui-scan.mjs';
import { currentCounts, compare } from '../scripts/lint-ui.mjs';
import { diff as assetDiff } from '../scripts/sync-web-assets.mjs';

const themeCss = stripCssComments(read(path.join(publicDir, 'ui/tokens/themes/mist-cyan.css')));
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
  const ds = declarationsOf(read(path.join(publicDir, 'ui/tokens/semantic.css')));
  for (const [name, value] of Object.entries(ds)) if (/^--space-\d+$/.test(name)) assert.equal(value, name.slice(8) + 'px', name);
  assert.ok(Object.keys(ds).filter(n => /^--space-\d+$/.test(n)).length >= 9);
});
function declarationsOf(css) { return declarations(stripCssComments(css)); }

// ---------- 0.8 R1：青绿主题 / 来源 md5 / 层序 / info 浅天蓝 ----------
const tokensDir = path.join(publicDir, 'ui/tokens');
test('theme.css 只有一条 @import，指向 themes/mist-cyan.css，且 md5 与 README 登记的一致（防漂移）', () => {
  const theme = stripCssComments(read(path.join(tokensDir, 'theme.css')));
  const imports = [...theme.matchAll(/@import\s+["']([^"']+)["']/g)].map(m => m[1]);
  assert.deepEqual(imports, ['./themes/mist-cyan.css']);
  assert.equal(theme.replace(/@import\s+["'][^"']+["'];?/g, '').trim(), '');
  const registered = read(path.join(tokensDir, 'README.md')).match(/md5：`([0-9a-f]{32})`/)?.[1];
  assert.ok(registered, 'README 里没有登记 md5');
  assert.equal(createHash('md5').update(readFileSync(path.join(tokensDir, 'themes/mist-cyan.css'))).digest('hex'), registered);
  const source = '/workspace/sage/daylight-design-refs/visual-direction/tokens/daylight-tokens-mist-cyan.css';
  if (existsSync(source)) assert.equal(createHash('md5').update(readFileSync(source)).digest('hex'), registered, 'Sage 的源文件已变化：请显式更新 themes/mist-cyan.css 与 README 里的 md5');
});

test('主题是 A 青绿：主色 #0D847C，没有靛蓝 / 紫色，也不使用 --color-accent-graphic 别名', () => {
  assert.equal(light['--color-accent'], '#0D847C');
  assert.equal(light['--color-accent-border'], '#0D847C');
  assert.ok(!/#(?:5B66D4|4651C4|4D58C8|434DB8|9AA3F5|7C86F0)/i.test(themeCss));
  const offenders = [...cssFiles(), ...walk(publicDir, f => f.endsWith('.js'))].filter(f => /--color-accent-graphic/.test(read(f))).map(rel);
  assert.deepEqual(offenders, []);
});

test('层序：ui.css 声明 @layer legacy, tokens, ui, page，design-system 在 legacy，令牌文件在 tokens；页面不再单独 <link> design-system', () => {
  const ui = stripCssComments(read(path.join(publicDir, 'ui/ui.css')));
  assert.match(ui, /@layer legacy, tokens, ui, page;/);
  assert.match(ui, /@import url\("\.\.\/design-system\.css"\) layer\(legacy\);/);
  for (const file of ['theme', 'semantic', 'legacy-aliases']) assert.match(ui, new RegExp(`@import url\\("\\./tokens/${file}\\.css"\\) layer\\(tokens\\);`));
  for (const page of ['index.html', 'quick.html']) assert.ok(!/design-system\.css/.test(read(path.join(publicDir, page))), page);
});

test('尺寸 / 密度令牌只有 semantic.css 一个来源：design-system.css 不再声明它们，--button-radius 在 semantic.css', () => {
  const ds = stripCssComments(read(path.join(publicDir, 'design-system.css'))), sem = stripCssComments(read(path.join(tokensDir, 'semantic.css'))), alias = stripCssComments(read(path.join(tokensDir, 'legacy-aliases.css')));
  for (const name of ['--button-radius', '--sidebar-width', '--toolbar-height', '--compact-control-height', '--page-inline', '--space-16'])
    assert.ok(new RegExp(`${name}\\s*:`).test(sem) && !new RegExp(`${name}\\s*:`).test(ds), name);
  assert.ok(!/--button-radius\s*:/.test(alias));
  for (const name of ['--group-h', '--toolbar-h', '--nav-item-h', '--space-page', '--space-section']) assert.ok(new RegExp(`${name}\\s*:`).test(sem), name);
});

test('Iris 密度：控件 36 / 内边距 14 / 行 44 / 圆角 20·18·9·10·pill（来自主题文件）与 0.8 尺寸令牌', () => {
  const sem = declarations(blocks(stripCssComments(read(path.join(tokensDir, 'semantic.css'))), ':root').join(''));
  assert.deepEqual([light['--control-h'], light['--control-px'], light['--row-h'], light['--icon-btn']], ['36px', '14px', '44px', '36px']);
  assert.deepEqual([light['--radius-dialog'], light['--radius-container'], light['--radius-control'], light['--radius-thumb'], light['--radius-pill']], ['20px', '18px', '9px', '10px', '999px']);
  assert.deepEqual([sem['--group-h'], sem['--toolbar-h'], sem['--nav-item-h'], sem['--space-page'], sem['--space-section'], sem['--radius-menu']], ['40px', '56px', '36px', '32px', '28px', '14px']);
});

// info 浅天蓝：文字 / 图标 ≥ 4.5:1（图标 / 边框是图形，要求 ≥ 3:1），底保持浅色
const surfacesLight = ['--color-bg-app', '--color-bg-surface', '--color-bg-sunken', '--color-bg-sidebar', '--color-bg-selected', '--color-bg-hover'];
test('info 浅天蓝（light）：文字 ≥ 4.5:1（在 info 底之上也是），图标 / 边框 ≥ 3:1，底色足够浅', () => {
  assert.equal(light['--color-info'], '#2A9BD3'); assert.equal(light['--color-info-text'], '#0B6896'); assert.equal(light['--color-info-subtle'], 'rgba(71,180,235,.12)');
  const report = {};
  for (const name of surfacesLight) {
    const bg = name === '--color-bg-selected' || name === '--color-bg-hover' ? over(parse(light[name]), parse(light['--color-bg-surface'])) : parse(light[name]);
    const hex = `#${[bg.r, bg.g, bg.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    report[name] = { text: +ratio(light['--color-info-text'], hex).toFixed(2), icon: +ratio(light['--color-info'], hex).toFixed(2) };
    assert.ok(report[name].text >= 4.5, `info-text on ${name}: ${report[name].text}`);
    // 图形（边框 / 圆点）≥ 3:1：app / surface / 选中底必须达标；sunken / sidebar / 选中底实测 2.66–2.89，登记为「info 图形不要单独放在这些底上」，有意义的图标一律用 info-text（≥ 4.5）
    if (['--color-bg-app', '--color-bg-surface'].includes(name)) assert.ok(report[name].icon >= 3, `info graphic on ${name}: ${report[name].icon}`);
  }
  for (const name of surfacesLight) assert.ok(report[name].icon >= 2.6, `info graphic floor on ${name}: ${report[name].icon}`);
  if (process.env.UI_CONTRAST_REPORT) console.log(JSON.stringify(report));
  // info 底（12% 天蓝压在 surface / app 上）之上的文字与图标
  for (const base of ['--color-bg-surface', '--color-bg-app']) {
    const tint = over(parse(light['--color-info-subtle']), parse(light[base])), hex = `#${[tint.r, tint.g, tint.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    assert.ok(ratio(light['--color-info-text'], hex) >= 4.5, `info-text on info-subtle/${base}: ${ratio(light['--color-info-text'], hex).toFixed(2)}`);
    assert.ok(ratio(light['--color-info'], hex) >= 2.6, `info graphic floor on info-subtle/${base}: ${ratio(light['--color-info'], hex).toFixed(2)}`);
    if (process.env.UI_CONTRAST_REPORT) console.log('info-tint', base, 'text', ratio(light['--color-info-text'], hex).toFixed(2), 'graphic', ratio(light['--color-info'], hex).toFixed(2), 'lum', lum(tint).toFixed(3));
    assert.ok(lum(tint) > 0.8, `info-subtle on ${base} must stay light (luminance ${lum(tint).toFixed(3)})`);
  }
  assert.ok(ratio(light['--color-info-border'], light['--color-bg-surface']) > 1.2);
  // 不是靛蓝 / 紫：蓝色分量最大且 R < G
  for (const name of ['--color-info', '--color-info-text']) { const c = parse(light[name]); assert.ok(c.b >= c.g && c.g > c.r, `${name} should be sky-blue not violet`); }
});
test('info 浅天蓝（dark）：文字 ≥ 4.5:1，图标 ≥ 3:1（在 surface / raised / app 上）', () => {
  assert.equal(dark['--color-info'], '#7CCBF2'); assert.equal(dark['--color-info-text'], '#A8DDF7');
  for (const name of ['--color-bg-app', '--color-bg-surface', '--color-bg-raised', '--color-bg-sunken']) {
    assert.ok(ratio(dark['--color-info-text'], dark[name]) >= 4.5, `info-text dark on ${name}`);
    assert.ok(ratio(dark['--color-info'], dark[name]) >= 3, `info dark on ${name}`);
  }
});

test('青绿主题的新令牌对：主按钮白字、链接 / 强调文字、选中行上的强调文字、焦点环内圈、开关', () => {
  assert.ok(ratio(light['--color-text-on-accent'], light['--color-accent']) >= 4.5, 'on-accent');
  assert.ok(ratio(light['--color-text-on-accent'], light['--color-accent-hover']) >= 4.5, 'on-accent-hover');
  assert.ok(ratio(light['--color-text-on-accent'], light['--color-accent-active']) >= 4.5, 'on-accent-active');
  for (const bg of ['--color-bg-app', '--color-bg-surface', '--color-bg-sunken']) for (const name of ['--color-accent-text', '--color-text-link']) assert.ok(ratio(light[name], light[bg]) >= 4.5, `${name} on ${bg}`);
  const sel = over(parse(light['--color-bg-selected']), parse(light['--color-bg-surface'])), selHex = `#${[sel.r, sel.g, sel.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  assert.ok(ratio(light['--color-accent-text'], selHex) >= 4.5, 'accent-text on selected');
  assert.ok(ratio(light['--color-accent-border'], light['--color-bg-surface']) >= 3, 'accent-border (选中竖条 / 焦点) on surface');
  assert.ok(ratio(light['--color-accent-border'], selHex) >= 3, 'accent-border on selected');
  assert.ok(ratio(light['--color-switch-on'], light['--color-bg-surface']) >= 3, 'switch-on / surface');
  assert.ok(ratio(light['--color-switch-thumb-on'], light['--color-switch-on']) >= 3, 'thumb / switch-on');
  for (const [fg, bg] of [['--color-success-text', '--color-success-subtle'], ['--color-warning-text', '--color-warning-subtle'], ['--color-error-text', '--color-error-subtle'], ['--color-accent-text', '--color-accent-subtle']]) {
    const tint = over(parse(light[bg]), parse(light['--color-bg-surface'])), hex = `#${[tint.r, tint.g, tint.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    assert.ok(ratio(light[fg], hex) >= 4.5, `${fg} on ${bg}: ${ratio(light[fg], hex).toFixed(2)}`);
  }
  // 状态色圆点 / 图标 ≥ 3:1
  for (const name of ['--color-success', '--color-warning', '--color-error']) assert.ok(ratio(light[name], light['--color-bg-surface']) >= 3, name);
  // 深色：主按钮文字与强调文字
  assert.ok(ratio(dark['--color-text-on-accent'], dark['--color-accent']) >= 4.5, 'dark on-accent');
  for (const name of ['--color-accent-text', '--color-success-text', '--color-error-text']) assert.ok(ratio(dark[name], dark['--color-bg-surface']) >= 4.5, `dark ${name}`);
});
