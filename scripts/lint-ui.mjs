#!/usr/bin/env node
// 0.8 UI lint：颜色字面量「下降棘轮」。
// 规则：public/**/*.{css,js} 里的原始颜色（#hex / rgb() / hsl()）只能少、不能多。
// 主题文件 public/ui/tokens/themes/** 豁免（那是颜色的唯一合法家园）。
//   node scripts/lint-ui.mjs            对比 scripts/lint-ui-baseline.json，任何文件变多（或新文件出现）就失败
//   node scripts/lint-ui.mjs --update   把当前计数写回基线（只在「变少了」时使用；评审会看基线 diff）
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { root, cssFiles, jsFiles, rel, read, stripCssComments, countColors, isThemeFile } from './lib/ui-scan.mjs';

const baselineFile = path.join(root, 'scripts/lint-ui-baseline.json');

export function currentCounts() {
  const counts = {};
  for (const file of [...cssFiles(), ...jsFiles()]) {
    if (isThemeFile(file)) continue;
    const text = file.endsWith('.css') ? stripCssComments(read(file)) : read(file);
    const n = countColors(text);
    if (n) counts[rel(file)] = n;
  }
  return counts;
}

export function compare(current, baseline) {
  const worse = [], better = [];
  for (const [file, n] of Object.entries(current)) if (n > (baseline[file] ?? 0)) worse.push({ file, was: baseline[file] ?? 0, now: n });
  for (const [file, n] of Object.entries(baseline)) if ((current[file] ?? 0) < n) better.push({ file, was: n, now: current[file] ?? 0 });
  return { worse, better };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const current = currentCounts();
  if (process.argv.includes('--update')) {
    const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(baselineFile, JSON.stringify(sorted, null, 2) + '\n');
    console.log(`lint-ui: baseline updated (${Object.values(sorted).reduce((a, b) => a + b, 0)} literals in ${Object.keys(sorted).length} files)`);
  } else {
    const { worse, better } = compare(current, JSON.parse(readFileSync(baselineFile, 'utf8')));
    for (const w of worse) console.error(`✗ ${w.file}: 颜色字面量 ${w.was} → ${w.now}（页面请改用 var(--color-*) 令牌）`);
    if (better.length) console.log(`lint-ui: ${better.length} 个文件的字面量比基线少，运行 node scripts/lint-ui.mjs --update 收紧基线`);
    if (worse.length) process.exit(1);
    console.log(`lint-ui: ok (${Object.values(current).reduce((a, b) => a + b, 0)} literals in ${Object.keys(current).length} files)`);
  }
}
