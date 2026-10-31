import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

// 原生窗口 minSize 是 760，主窗口永远到不了 ≤650；这些文件只在主窗口（index.html）里加载，stacked 布局是死代码，PR-5 清理。
test('main-window stylesheets no longer carry the unreachable ≤650 stacked layout', () => {
  for (const name of ['style.css', 'proxy.css', 'cli-config.css', 'update.css']) assert.doesNotMatch(read(name), /max-width:\s*650px/, name);
  assert.doesNotMatch(read('style.css'), /min-width:\s*651px/, 'the icon rail applies to every width ≤999 now');
});

// 这两个文件还被快速面板（quick.html，宽 400–1000，默认 600）加载，≤650 在那里是活的，不能清。
test('shared stylesheets keep ≤650 because the quick panel (default 600px wide) loads them', () => {
  const quick = read('quick.html');
  assert.match(quick, /\/ui\/ui\.css/); assert.match(read('ui/ui.css'), /design-system\.css"\) layer\(legacy\)/, 'design-system.css reaches quick.html through ui.css (@layer legacy)');
  for (const name of ['ai.css', 'design-system.css', 'ui/tokens/semantic.css']) assert.match(read(name), /max-width:\s*650px/, name);
  assert.match(quick, /\/ai\.css/);
});

// ≤930 在 760–930 之间是活的（760 窗口下的单列），不属于死布局。
test('≤930 rules stay: they are reachable between 760 and 930', () => {
  assert.match(read('style.css'), /max-width:\s*930px/); assert.match(read('proxy.css'), /max-width:\s*930px/);
});
