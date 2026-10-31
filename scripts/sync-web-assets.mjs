#!/usr/bin/env node
// 保证 public/ui/** 里每个 html/js/css/svg 都登记在 core/web-assets.json（否则线上 404），
// 且登记的 /ui/ 条目都指向真实存在的文件。
//   node scripts/sync-web-assets.mjs --check   有差异就失败（接入 npm run check）
//   node scripts/sync-web-assets.mjs --write   把缺的条目补进 web-assets.json（本地用）
// _candidates/ 目录（未选的候选主题）故意不登记：不被页面引用，打包时会被裁掉。
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const manifestFile = path.join(root, 'core/web-assets.json');
const servable = /\.(?:html|js|css|svg)$/;
const skipped = new Set(['_candidates']);

export function uiFiles(dir = path.join(publicDir, 'ui')) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!skipped.has(entry.name)) out.push(...uiFiles(path.join(dir, entry.name))); continue; }
    if (servable.test(entry.name)) out.push(path.relative(publicDir, path.join(dir, entry.name)).split(path.sep).join('/'));
  }
  return out.sort();
}

export function diff() {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const files = uiFiles();
  const missing = files.filter(file => manifest['/' + file] !== file);
  const dangling = Object.entries(manifest).filter(([key, value]) => key.startsWith('/ui/') && !existsSync(path.join(publicDir, value))).map(([key]) => key);
  return { manifest, files, missing, dangling };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes('--write');
  const { manifest, missing, dangling } = diff();
  if (write && missing.length) {
    for (const file of missing) manifest['/' + file] = file;
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`sync-web-assets: registered ${missing.length} file(s)`);
    process.exit(dangling.length ? 1 : 0);
  }
  for (const file of missing) console.error(`✗ public/${file} 没有登记到 core/web-assets.json（运行 node scripts/sync-web-assets.mjs --write）`);
  for (const key of dangling) console.error(`✗ core/web-assets.json 登记了不存在的文件：${key}`);
  if (missing.length || dangling.length) process.exit(1);
  console.log('sync-web-assets: ok');
}
