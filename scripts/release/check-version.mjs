#!/usr/bin/env node
// Fails when package.json, package-lock.json and (optionally) a built app or release manifest disagree on the version.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function versionReport({ app, manifest, tag } = {}) {
  const found = { 'package.json': JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version };
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  found['package-lock.json'] = lock.version;
  found['package-lock.json packages[""]'] = lock.packages?.[''].version;
  if (app) {
    const plist = path.join(app, 'Contents/Info.plist');
    for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) found[`${key}`] = execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
  }
  if (manifest) found[path.basename(manifest)] = JSON.parse(await readFile(manifest, 'utf8')).version;
  if (tag) found['git tag'] = String(tag).replace(/^v/, '');
  const versions = new Set(Object.values(found));
  return { found, ok: versions.size === 1 && !versions.has(undefined) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const option = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
  const report = await versionReport({ app: option('--app'), manifest: option('--manifest'), tag: option('--tag') });
  for (const [name, version] of Object.entries(report.found)) console.log(`${name}: ${version}`);
  if (!report.ok) { console.error('版本号不一致'); process.exit(1); }
  console.log('版本号一致');
}
