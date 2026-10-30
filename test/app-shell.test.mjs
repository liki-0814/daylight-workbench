import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialState } from '../public/model.js';
import { sidebarContent } from '../public/components/sidebar.js';

const css = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

test('sidebar keeps a readable name for every control when the 64px icon rail hides the labels', () => {
  const html = sidebarContent({ state: initialState(), view: 'today', updateAvailable: true });
  const buttons = html.match(/<button[^>]*data-view="[^"]+"[^>]*>/g) || [];
  assert.equal(buttons.length, 8);
  for (const tag of buttons) assert.match(tag, /title="[^"]+"/, `${tag} needs a title for the icon rail`);
  assert.equal((html.match(/class="nav-label"/g) || []).length, 8, 'labels stay in the DOM (visually hidden in the rail)');
  assert.match(html, /<span class="capture-label">新建任务<\/span>/);
  assert.match(html, /class="brand-text"/);
  assert.match(html, /data-app-update/);
});

test('shell tokens: 224 / 208 / 64 sidebar tiers, 52px toolbar, opaque fallbacks for the material', () => {
  const ds = css('design-system.css');
  assert.match(ds, /--sidebar-width: 224px;/);
  assert.match(ds, /--toolbar-height: 52px;/);
  assert.match(ds, /@media \(max-width: 1339px\) \{\s*:root \{ --sidebar-width: 208px; \}/);
  assert.match(ds, /@media \(max-width: 999px\) \{\s*:root \{ --sidebar-width: 64px; \}/);
  assert.match(ds, /:root\[data-reduce-transparency\] \{ --material: var\(--bg\); --material-filter: none; \}/);
  assert.match(ds, /@media \(prefers-reduced-transparency: reduce\)/);
  assert.match(ds, /@supports not \(\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\)/);
  const reduce = ds.indexOf(':root[data-reduce-transparency]');
  assert.ok(reduce > ds.lastIndexOf('prefers-color-scheme: dark'), 'fallbacks come after the dark token block so they win');
});

test('toolbar is a sticky 52px material bar with the -webkit- prefix written next to the standard property', () => {
  const style = css('style.css');
  const bar = style.match(/\.topbar \{[^}]*\}/)[0];
  assert.match(bar, /height: var\(--toolbar-height\)/);
  assert.match(bar, /position: sticky/);
  assert.match(bar, /background: var\(--material\)/);
  assert.match(bar, /-webkit-backdrop-filter: var\(--material-filter\)/);
  assert.match(bar, /\n  backdrop-filter: var\(--material-filter\)/);
  assert.doesNotMatch(style + css('ai.css'), /calc\(100dvh - 76px\)|height: 76px/, 'no leftover 76px toolbar anchors');
  assert.match(css('ai.css'), /top: calc\(var\(--toolbar-height\) \+ 24px\)/);
});

test('every backdrop-filter is paired with -webkit-backdrop-filter and honours reduce-transparency', () => {
  for (const name of ['style.css', 'quick.css', 'design-system.css']) {
    const text = css(name);
    const plain = (text.match(/(^|[^-])backdrop-filter:/gm) || []).length;
    const prefixed = (text.match(/-webkit-backdrop-filter:/g) || []).length;
    assert.equal(plain, prefixed, `${name}: backdrop-filter count ${plain} vs prefixed ${prefixed}`);
  }
  assert.match(css('quick.css'), /html\[data-reduce-transparency\] \.quick-shell/);
  assert.match(css('style.css'), /:root\[data-reduce-transparency\] dialog::backdrop/);
});
