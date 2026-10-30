// R13（设计规格：清单行 min-height 56px）：行高写在 CSS 里，页面测试里没有真实布局，这里先把样式表读出来守住数值；
// 真实渲染高度由 e2e ext-r13（#29 补丁，三种宽度下量 getBoundingClientRect）负责。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../public/extensions/extensions.css', import.meta.url), 'utf8');
const rules = selector => [...css.matchAll(/(^|\n)([^{}\n@][^{}]*)\{([^}]*)\}/g)].filter(match => match[2].split(',').map(part => part.trim()).includes(selector)).map(match => match[3]);
const minHeights = selector => rules(selector).map(body => /min-height:\s*(\d+)px/.exec(body)?.[1]).filter(Boolean).map(Number);
test('R13: .extension-row has min-height 56px and its open button 56px (44px only inside the narrow container query)', () => {
  assert.deepEqual(minHeights('.extension-row'), [56]);
  const wide = css.split('@container (max-width: 560px)')[0];
  assert.match(wide, /\.extension-row-open \{[^}]*min-height: 56px/);
  const narrow = css.split('@container (max-width: 560px)')[1];
  assert.match(narrow, /\.extension-row-open \{ min-height: 44px; \}/);
});
test('R13: nothing else in the stylesheet lowers the row below 44px (a regression usually arrives as a later, shorter rule)', () => {
  for (const selector of ['.extension-row', '.extension-row-open', '.extension-table .extension-row']) for (const value of minHeights(selector)) assert.ok(value >= 44, `${selector} ${value}`);
});
test('R13: the guard itself fails on a 40px row (so the check is not vacuous)', () => {
  const broken = css.replace('.extension-row { min-height: 56px;', '.extension-row { min-height: 40px;');
  assert.notEqual(broken, css);
  const parse = text => [...text.matchAll(/(^|\n)([^{}\n@][^{}]*)\{([^}]*)\}/g)].filter(match => match[2].trim() === '.extension-row').map(match => /min-height:\s*(\d+)px/.exec(match[3])?.[1]).filter(Boolean).map(Number);
  assert.deepEqual(parse(broken), [40]);
});
