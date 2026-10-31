import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintDeps, importsOf, isShim } from '../scripts/lint-deps.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lint-deps-'));
  for (const [name, text] of Object.entries(files)) { const file = path.join(dir, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); }
  return dir;
}
const rules = result => result.violations.map(v => `${v.rule}:${v.file}`).sort();

test('仓库本身依赖方向干净（scripts/lint-deps.mjs 0 违规）', () => {
  const result = lintDeps({ root });
  assert.deepEqual(result.violations, []);
});

test('故意写反的夹具：core → components、components → patterns、ui → ui 之外、跨组件深引用，都会失败', () => {
  const dir = fixture({
    'public/ui/core/x.js': "import { button } from '../components/button/button.js';\n",
    'public/ui/components/button/button.js': "import { row } from '../../patterns/row/row.js';\nimport '../../../app-helpers.js';\nimport { y } from '../chip/chip-internal.js';\n",
    'public/ui/components/chip/chip.js': 'export const chip = 1;\n',
    'public/ui/components/chip/chip-internal.js': 'export const y = 1;\n',
    'public/ui/patterns/row/row.js': "import { chip } from '../../components/chip/chip.js';\nexport const row = chip;\n",
  });
  try {
    const result = lintDeps({ root: dir });
    assert.deepEqual(rules(result), [
      'entry-only:ui/components/button/button.js',
      'layer:ui/components/button/button.js',
      'layer:ui/core/x.js',
      'outside-ui:ui/components/button/button.js',
    ].sort());
    const cli = spawnSync(process.execPath, [path.join(root, 'scripts/lint-deps.mjs'), '--root', dir], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /components may not depend on patterns/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('正向依赖（patterns → components 入口、components → core）通过', () => {
  const dir = fixture({
    'public/ui/core/events.js': 'export const emit = 1;\n',
    'public/ui/components/chip/chip.js': "import { emit } from '../../core/events.js';\nexport const chip = emit;\n",
    'public/ui/patterns/row/row.js': "import { chip } from '../../components/chip/chip.js';\nexport const row = chip;\n",
    'public/pages/tasks.js': "import { row } from '../ui/patterns/row/row.js';\nimport { chip } from '../ui/components/chip/chip.js';\nimport { esc } from '../ui/core/html.js';\n",
  });
  try { assert.deepEqual(lintDeps({ root: dir }).violations, []); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('页面只能 import 组件 / pattern 入口、ui/core 和 pages 内部；不能深引用，也不能碰旧 components/', () => {
  const dir = fixture({
    'public/ui/components/chip/chip.js': 'export const chip = 1;\n',
    'public/ui/components/chip/chip-internal.js': 'export const y = 1;\n',
    'public/pages/a.js': "import { y } from '../ui/components/chip/chip-internal.js';\nimport { x } from '../components/select.js';\nimport { esc } from '../ui/core/html.js';\n",
  });
  try { assert.deepEqual(rules(lintDeps({ root: dir })), ['pages-entry:pages/a.js', 'pages-entry:pages/a.js']); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('事件只能经 emit()：直接 dispatchEvent / new CustomEvent、未知动词、内联 style 都被拦下', () => {
  const dir = fixture({
    'public/ui/components/chip/chip.js': "import { emit } from '../../core/events.js';\nel.dispatchEvent(new CustomEvent('ui:change'));\nemit(el, 'toggle', {});\nconst s = `<i style=\"color:red\"></i>`;\nemit(el, 'change', {});\n",
    'public/ui/core/events.js': 'export const emit = 1;\n',
  });
  try { assert.deepEqual(rules(lintDeps({ root: dir })), ['emit-only:ui/components/chip/chip.js', 'event-verb:ui/components/chip/chip.js', 'inline-style:ui/components/chip/chip.js']); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('旧 components/* 垫片棘轮：新增带逻辑的文件失败，纯 re-export 垫片通过', () => {
  const dir = fixture({
    'scripts/lint-deps-baseline.json': JSON.stringify({ nonShims: ['old.js'] }),
    'public/components/old.js': 'export const a = () => 1;\n',
    'public/components/shim.js': "// 垫片\nexport { chip } from '../ui/components/chip/chip.js';\nexport * from '../ui/core/html.js';\n",
    'public/components/fresh.js': 'export function brandNew() { return 1; }\n',
  });
  try { assert.deepEqual(rules(lintDeps({ root: dir })), ['shim-ratchet:components/fresh.js']); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('import 解析与垫片判定', () => {
  assert.deepEqual(importsOf("import a from './a.js'; import {b} from \"../b.js\"; export * from './c.js'; const m = await import('./d.js'); // import x from 'nope'\n"), ['./a.js', '../b.js', './c.js', './d.js']);
  assert.equal(isShim("export { a } from './a.js';\n"), true);
  assert.equal(isShim("import { a } from './a.js';\nexport { a };\n"), false);
  assert.equal(isShim('export const a = 1;\n'), false);
});

test('lint-deps 已接入 npm run check', async () => {
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(path.join(root, 'scripts/check.mjs'), 'utf8'), /scripts\/lint-deps\.mjs/);
});
