#!/usr/bin/env node
// 0.8 依赖方向 lint（接入 npm run check）。复用 scripts/lib/ui-scan.mjs 的 walk / read。
// 层次（只能向左依赖）：core ← components ← patterns ← pages
//   1. public/ui/** 不得 import ui/ 之外的任何东西（含裸模块名）。
//   2. core 不依赖 components / patterns；components 不依赖 patterns；patterns 可以依赖 components。
//      跨组件 / 跨 pattern 只能引用对方的入口文件 ui/<层>/<n>/<n>.js。
//   3. 页面（public/pages/**）只能 import 组件 / pattern 的入口文件、ui/core/*、以及 pages/ 内部文件；不能 import 内部实现或旧 components/。
//   4. 旧 public/components/* 逐步变成纯 re-export 垫片（shim）：非垫片文件数有棘轮（scripts/lint-deps-baseline.json），只降不升，PR-Z 前清零。
//   5. 组件 / pattern 派发事件只能经 core/events.js 的 emit()：禁止 .dispatchEvent( / new CustomEvent( / new Event(；emit 的动词必须是 ui:* 约定内的动词。
//   6. ui/ 与 pages/ 的标记里不得写 style="…"（CSP style-src 'self'）。
//   node scripts/lint-deps.mjs [--root <dir>]     --root 指向含 public/ 与 scripts/ 的目录（测试夹具用）
//   node scripts/lint-deps.mjs --update           把非垫片数量写回基线（只在变少时使用）
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk, read } from './lib/ui-scan.mjs';

export const EVENT_VERBS = ['change', 'select', 'open', 'close', 'dismiss'];
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
export function importsOf(text) {
  const code = stripComments(text), out = [];
  for (const m of code.matchAll(/(?:^|[;\s}])(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return [...new Set(out)];
}
// 旧 components/ 垫片：只有注释和 `export … from '…'` / `export * from '…'`。
export function isShim(text) {
  const code = stripComments(text).trim();
  if (!code) return false;
  return code.split(/;\s*(?:\n|$)|\n/).map(s => s.trim()).filter(Boolean).every(s => /^export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"][^'"]+['"]$/.test(s));
}

function layerOf(rel) {   // rel 相对 public/，如 ui/components/button/button.js
  const m = rel.match(/^ui\/(core|components|patterns)\/([^/]+)/);
  if (m) return { layer: m[1], name: m[1] === 'core' ? null : m[2] };
  if (rel.startsWith('ui/')) return { layer: 'ui-root', name: null };
  if (rel.startsWith('pages/')) return { layer: 'pages', name: null };
  return { layer: 'other', name: null };
}
const isEntry = rel => { const m = rel.match(/^ui\/(components|patterns)\/([^/]+)\/([^/]+)\.js$/); return !!m && m[2] === m[3]; };

export function lintDeps({ root = defaultRoot } = {}) {
  const publicDir = path.join(root, 'public');
  const violations = [];
  const relOf = file => path.relative(publicDir, file).split(path.sep).join('/');
  const add = (file, rule, message) => violations.push({ file, rule, message });
  const scan = dir => existsSync(path.join(publicDir, dir)) ? walk(path.join(publicDir, dir), f => f.endsWith('.js') && !f.includes('/_candidates/')) : [];

  for (const file of [...scan('ui'), ...scan('pages')]) {
    const rel = relOf(file), text = read(file), from = layerOf(rel);
    for (const spec of importsOf(text)) {
      let target;
      if (spec.startsWith('.')) target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      else if (spec.startsWith('/')) target = spec.slice(1);
      else { add(rel, 'outside-ui', `bare / external import '${spec}'`); continue; }
      const to = layerOf(target);
      const sameFolder = from.layer === to.layer && from.name === to.name;
      if (from.layer !== 'pages' && from.layer !== 'other') {
        if (!target.startsWith('ui/')) { add(rel, 'outside-ui', `ui/ may not import outside ui/: '${spec}' → ${target}`); continue; }
        if (from.layer === 'core' && to.layer !== 'core') add(rel, 'layer', `core may not depend on ${to.layer}: '${spec}'`);
        if (from.layer === 'components' && to.layer === 'patterns') add(rel, 'layer', `components may not depend on patterns: '${spec}'`);
        if (from.layer === 'components' && to.layer === 'ui-root') add(rel, 'layer', `components may not depend on ui root files: '${spec}'`);
        if (!sameFolder && (to.layer === 'components' || to.layer === 'patterns') && !isEntry(target)) add(rel, 'entry-only', `cross-${to.layer.slice(0, -1)} imports must target the entry file ui/${to.layer}/<n>/<n>.js: '${spec}'`);
      }
      if (from.layer === 'pages') {
        const inPages = target.startsWith('pages/');
        const ok = inPages || /^ui\/core\/[^/]+\.js$/.test(target) || isEntry(target);
        if (!ok) add(rel, 'pages-entry', `pages may import only component/pattern entry files (ui/components/<n>/<n>.js), ui/core/*, or pages/*: '${spec}'`);
      }
    }
    if (from.layer === 'components' || from.layer === 'patterns') {
      if (/\.dispatchEvent\s*\(|new\s+CustomEvent\s*\(|new\s+Event\s*\(/.test(stripComments(text))) add(rel, 'emit-only', 'dispatch events only through emit() from ui/core/events.js');
      for (const m of stripComments(text).matchAll(/\bemit\(\s*[^,()]+,\s*['"]([^'"]+)['"]/g)) if (!EVENT_VERBS.includes(m[1])) add(rel, 'event-verb', `unknown ui:${m[1]} (allowed: ${EVENT_VERBS.map(v => 'ui:' + v).join(', ')})`);
    }
    if ((from.layer === 'components' || from.layer === 'patterns' || from.layer === 'pages') && /\sstyle\s*=\s*["'\\$]/.test(stripComments(text))) add(rel, 'inline-style', 'no inline style="…" attributes (CSP style-src self); use classes / CSSOM');
  }

  // 垫片棘轮
  const componentsDir = path.join(publicDir, 'components');
  const nonShims = existsSync(componentsDir)
    ? readdirSync(componentsDir).filter(n => n.endsWith('.js')).filter(n => !['marked.js', 'purify.js'].includes(n)).filter(n => !isShim(read(path.join(componentsDir, n)))).sort()
    : [];
  const baselineFile = path.join(root, 'scripts/lint-deps-baseline.json');
  const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')).nonShims ?? [] : [];
  for (const name of nonShims) if (!baseline.includes(name)) add(`components/${name}`, 'shim-ratchet', 'new logic in old public/components/*: only pure re-export shims are allowed there; build it in ui/');
  return { violations, nonShims, baseline };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootArg = process.argv.indexOf('--root');
  const root = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : defaultRoot;
  const { violations, nonShims, baseline } = lintDeps({ root });
  if (process.argv.includes('--update')) {
    writeFileSync(path.join(root, 'scripts/lint-deps-baseline.json'), JSON.stringify({ note: 'public/components/* files that are not yet pure re-export shims. Only shrinks; must be empty before PR-Z.', nonShims }, null, 2) + '\n');
    console.log(`lint-deps: baseline written (${nonShims.length} non-shim files)`);
    process.exit(0);
  }
  for (const v of violations) console.error(`✗ [${v.rule}] ${v.file}: ${v.message}`);
  const better = baseline.filter(n => !nonShims.includes(n));
  if (better.length) console.log(`lint-deps: ${better.length} component(s) became shims — run with --update to lower the ratchet (${better.join(', ')})`);
  console.log(`lint-deps: ${violations.length} violation(s); old components/ non-shim ratchet ${nonShims.length}/${baseline.length}`);
  process.exit(violations.length ? 1 : 0);
}
