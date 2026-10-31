#!/usr/bin/env node
// Syntax-check every tracked and untracked (non-ignored) JS/MJS source file, then run the domain contract checks.
// Files are discovered from git, so new modules are covered automatically.
import { execFileSync, spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Vendored third-party bundles are not ours to lint.
const vendored = new Set(['public/components/purify.js', 'public/components/marked.js']);
const excludedDirs = ['node_modules/', 'dist/', 'build/', '.local/', 'coverage/'];

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.js', '*.mjs'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean)
  .filter((file, index, all) => all.indexOf(file) === index)
  .filter(file => !vendored.has(file) && !excludedDirs.some(dir => file.startsWith(dir)));

const run = (args, label) => new Promise(resolve => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'inherit', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => { stderr += String(error); });
  child.on('close', code => resolve({ label, code, stderr }));
});

async function pool(items, limit, worker) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const item = items[next++]; results.push(await worker(item)); }
  }));
  return results;
}

const syntax = await pool(files, availableParallelism(), file => run(['--check', file], file));
const contracts = [];
for (const script of ['scripts/check-proxy.mjs', 'scripts/check-ai.mjs', 'scripts/check-focus.mjs', 'scripts/check-extensions.mjs']) contracts.push(await run([script], script));
contracts.push(await run(['scripts/sync-web-assets.mjs', '--check'], 'scripts/sync-web-assets.mjs --check'));

const failed = [...syntax, ...contracts].filter(result => result.code !== 0);
for (const { label, stderr } of failed) process.stderr.write(`✗ ${label}\n${stderr}\n`);
console.log(`check: ${files.length} files syntax-checked, ${contracts.length} contract scripts run, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
