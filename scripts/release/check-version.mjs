#!/usr/bin/env node
// Fails when package.json, package-lock.json and (optionally) a built app or release manifest disagree on the version.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The numeric x.y.z core macOS accepts for CFBundleShortVersionString / CFBundleVersion.
export function bundleVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version ?? ''));
  return match ? match.slice(1, 4).join('.') : undefined;
}

export async function versionReport({ app, manifest, tag } = {}) {
  const found = { 'package.json': JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version };
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  found['package-lock.json'] = lock.version;
  found['package-lock.json packages[""]'] = lock.packages?.[''].version;
  const problems = [];
  if (app) {
    // A prerelease package version (0.7.0-beta.1) ships as numeric x.y.z in the two CFBundle keys and in full as DaylightVersion.
    const plist = path.join(app, 'Contents/Info.plist');
    const read = key => { try { return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; } };
    const core = bundleVersion(found['package.json']);
    for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) if (read(key) !== core) problems.push(`${key} 应为 ${core}，实际为 ${read(key)}`);
    found.DaylightVersion = read('DaylightVersion') ?? read('CFBundleShortVersionString');
  }
  if (manifest) found[path.basename(manifest)] = JSON.parse(await readFile(manifest, 'utf8')).version;
  if (tag) found['git tag'] = String(tag).replace(/^v/, '');
  const versions = new Set(Object.values(found));
  return { found, problems, ok: versions.size === 1 && !versions.has(undefined) && problems.length === 0 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const option = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
  const report = await versionReport({ app: option('--app'), manifest: option('--manifest'), tag: option('--tag') });
  for (const [name, version] of Object.entries(report.found)) console.log(`${name}: ${version}`);
  for (const problem of report.problems) console.error(problem);
  if (!report.ok) { console.error('版本号不一致'); process.exit(1); }
  console.log('版本号一致');
}
