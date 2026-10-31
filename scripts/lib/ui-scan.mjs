// 0.8 UI 扫描工具：lint-ui、未定义变量测试、契约测试共用。纯 node，无依赖。
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const publicDir = path.join(root, 'public');

export function walk(dir, filter, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}
export const rel = file => path.relative(publicDir, file).split(path.sep).join('/');
export const read = file => readFileSync(file, 'utf8');
export const stripCssComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

// 页面真正使用的 CSS / JS（排除未选候选主题）
export const isCandidate = file => rel(file).includes('/_candidates/');
export const cssFiles = () => walk(publicDir, f => f.endsWith('.css') && !isCandidate(f)).sort();
export const jsFiles = () => walk(publicDir, f => f.endsWith('.js') && !isCandidate(f)).sort();

// 原始颜色字面量：#rgb/#rrggbb/#rrggbbaa 与 rgb()/rgba()/hsl()/hsla()。
export const colorLiteral = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|\b(?:rgba?|hsla?)\(/g;

export function countColors(text) {
  return (text.match(colorLiteral) || []).length;
}
// 主题文件本身是「颜色字面量」的唯一合法家园。
export const themeDir = 'ui/tokens/themes/';
export const isThemeFile = file => rel(file).startsWith(themeDir);

// 所有被声明的自定义属性：CSS 里的 `--x:` 声明 + JS 里 style.setProperty('--x') / '--x:' 内联写入。
export function definedVars() {
  const defined = new Set();
  for (const file of cssFiles()) for (const m of stripCssComments(read(file)).matchAll(/(^|[;{\s])(--[\w-]+)\s*:/g)) defined.add(m[2]);
  for (const file of jsFiles()) {
    const text = read(file);
    for (const m of text.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)) defined.add(m[1]);
    for (const m of text.matchAll(/['"`;\s](--[\w-]+)\s*:/g)) defined.add(m[1]);
  }
  return defined;
}

// 没有后备值的 var(--x)；返回 [{file, name}]
export function usedVars() {
  const used = [];
  for (const file of [...cssFiles(), ...jsFiles()]) {
    const text = file.endsWith('.css') ? stripCssComments(read(file)) : read(file);
    for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) if (m[2] === ')') used.push({ file: rel(file), name: m[1] });
  }
  return used;
}
