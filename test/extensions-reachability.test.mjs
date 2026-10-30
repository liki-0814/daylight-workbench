import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// 打包时 scripts/trim-runtime.mjs 用 esbuild 的依赖图删除“不可达”的文件。
// 这里用同样的入口（index.html / quick.html 引用的 js/css）和同样的 esbuild 参数在源码树上算一遍，
// 保证扩展页的每个前端模块（尤其是新加的 staging.js）都能从页面入口被 import 到——否则打包会把它 trim 掉，页面在 App 里直接崩。
const root = fileURLToPath(new URL('../public', import.meta.url));

async function reachable() {
  const entries = [];
  for (const file of ['index.html', 'quick.html']) {
    const html = await readFile(path.join(root, file), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="\/([^"#?]+)"/g)) if (/\.(?:js|mjs|css)$/.test(match[1])) entries.push(match[1]);
  }
  const result = await build({ absWorkingDir: root, entryPoints: entries, bundle: true, packages: 'external', platform: 'browser', format: 'esm', write: false, metafile: true, outdir: '.graph', loader: { '.svg': 'file' }, logLevel: 'silent' });
  return new Set(Object.keys(result.metafile.inputs).map(file => path.resolve(root, file)));
}

test('every public/extensions module is reachable from the page entries (so packaging cannot trim it)', async () => {
  const graph = await reachable();
  const files = (await readdir(path.join(root, 'extensions'))).filter(name => /\.(?:js|css)$/.test(name));
  assert.ok(files.includes('staging.js'), 'staging.js exists');
  const missing = files.filter(name => !graph.has(path.join(root, 'extensions', name)));
  assert.deepEqual(missing, [], '这些扩展页模块没有被任何入口 import / 引用到，打包会把它们删掉：' + missing.join(', '));
});

test('every public/extensions module is registered in core/web-assets.json, and every registered one exists', async () => {
  const assets = JSON.parse(await readFile(new URL('../core/web-assets.json', import.meta.url), 'utf8'));
  const files = (await readdir(path.join(root, 'extensions'))).filter(name => /\.(?:js|css)$/.test(name));
  const unregistered = files.filter(name => assets['/extensions/' + name] !== 'extensions/' + name);
  assert.deepEqual(unregistered, [], '没有登记到 core/web-assets.json：' + unregistered.join(', '));
  const dangling = Object.keys(assets).filter(key => key.startsWith('/extensions/')).filter(key => !files.includes(key.slice('/extensions/'.length)));
  assert.deepEqual(dangling, [], 'web-assets.json 登记了不存在的文件：' + dangling.join(', '));
});

test('the reachability check itself notices an unreferenced module', async () => {
  const graph = await reachable();
  assert.equal(graph.has(path.join(root, 'extensions', 'no-such-module.js')), false);
  assert.equal(graph.has(path.join(root, 'extensions', 'page.js')), true);
});
