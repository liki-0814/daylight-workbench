#!/usr/bin/env node
// Produces the in-app update assets for a built app: Daylight-<version>-arm64.zip, latest-mac.json and its Ed25519 signature.
// Usage: node scripts/release/package-update.mjs [--app dist/native/Daylight.app] [--out dist/update] [--key ~/.daylight-signing/update-ed25519.pem]
//        [--min-os 13.0] [--downgradeable] [--tag v0.7.0]
// The DMG stays the first-install and fallback download. Upload the DMG, the zip, latest-mac.json and latest-mac.json.sig to the same GitHub release.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestAssetName, signatureAssetName, packageAssetName, parseUpdateManifest } from '../../core/app-update.js';
import { buildManifest, rawPublicKeyBase64, sha256File, signBytes, verifyBytes } from './lib.mjs';
import { versionReport } from './check-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const option = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
const app = path.resolve(option('--app') || path.join(root, 'dist/native/Daylight.app'));
const out = path.resolve(option('--out') || path.join(root, 'dist/update'));
const keyFile = option('--key') || path.join(os.homedir(), '.daylight-signing/update-ed25519.pem');
const fail = message => { console.error(message); process.exit(1); };

const report = await versionReport({ app, tag: option('--tag') });
if (!report.ok) fail(`版本号不一致：${JSON.stringify(report.found)}`);
const version = report.found['package.json'];

// The bundle must verify and, when it will be installed over an existing app, keep one signing identity.
execFileSync('codesign', ['--verify', '--strict', '--deep', app], { stdio: 'inherit' });
const publicKey = (await readFile(path.join(root, 'build/update-public-key.txt'), 'utf8')).trim();
const privatePem = await readFile(keyFile, 'utf8');
if (rawPublicKeyBase64(privatePem) !== publicKey) fail('签名私钥与 build/update-public-key.txt 不匹配，已停止');
const embedded = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :DaylightUpdatePublicKey', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
if (embedded !== publicKey) fail('App 内嵌的更新公钥与 build/update-public-key.txt 不一致，请重新构建');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const zip = path.join(out, packageAssetName(version));
execFileSync('ditto', ['-c', '-k', '--keepParent', app, zip]);
const { size } = await stat(zip);
const manifestText = buildManifest({ version, size, sha256: await sha256File(zip), minOS: option('--min-os') || '13.0', downgradeable: process.argv.includes('--downgradeable') });
const signature = signBytes(privatePem, manifestText);
if (!verifyBytes(publicKey, manifestText, signature)) fail('签名自检失败');
if (!parseUpdateManifest(manifestText, version).ok) fail('清单自检失败');
await writeFile(path.join(out, manifestAssetName), manifestText);
await writeFile(path.join(out, signatureAssetName), `${signature}\n`);

// Round-trip: unzip the artifact into a scratch directory and verify it as the updater will.
const scratch = path.join(os.tmpdir(), `daylight-package-check-${process.pid}`);
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch);
try {
  execFileSync('ditto', ['-x', '-k', zip, scratch]);
  execFileSync('codesign', ['--verify', '--strict', '--deep', path.join(scratch, 'Daylight.app')], { stdio: 'inherit' });
} finally { await rm(scratch, { recursive: true, force: true }); }
console.log(`${zip}\n${path.join(out, manifestAssetName)}\n${path.join(out, signatureAssetName)}`);
console.log(`版本 ${version}，${size} 字节。请连同 DMG 一起上传到同一个 GitHub Release。`);
