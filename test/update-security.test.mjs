import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assetURL, compareVersions, decideUpdate, digestsMatch, interpretRelease, isTrustedAssetURL, isTrustedRedirectHost,
  manifestAssetName, normalizeDigest, osAtLeast, packageAssetName, parseUpdateManifest, signatureAssetName,
} from '../core/app-update.js';
import { resolveRoute } from '../core/contracts.js';
import { buildManifest, publicKeyFromBase64, rawPublicKeyBase64, sha256File, signBytes, verifyBytes } from '../scripts/release/lib.mjs';
import { versionReport } from '../scripts/release/check-version.mjs';
import { createWorkbench } from '../server.mjs';

const keys = () => generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const sha = 'a'.repeat(64);
const manifestText = (extra = {}) => JSON.stringify({ schema: 1, version: '0.9.0', url: assetURL('0.9.0', packageAssetName('0.9.0')), size: 1000, sha256: sha, minOS: '13.0', date: '2026-10-19T00:00:00Z', downgradeable: false, ...extra });

test('versions compare numerically and reject anything but three numeric parts (plus an optional SemVer prerelease)', () => {
  assert.equal(compareVersions('0.9.9', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0', 'v0.99.99'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  for (const bad of ['', '1', '1.2', '1.2.3.4', '1.2.3-', '1.2.x', null, undefined]) assert.equal(compareVersions('1.0.0', bad), null, String(bad));
});

test('update asset names and URLs are pinned to this repository release for exactly that tag', () => {
  assert.equal(packageAssetName('v0.9.0'), 'Daylight-0.9.0-arm64.zip');
  const url = assetURL('0.9.0', 'Daylight-0.9.0-arm64.zip');
  assert.equal(url, 'https://github.com/liki-0814/daylight-workbench/releases/download/v0.9.0/Daylight-0.9.0-arm64.zip');
  assert.equal(isTrustedAssetURL(url, '0.9.0', 'Daylight-0.9.0-arm64.zip'), true);
  for (const evil of [
    'https://github.com/other/daylight-workbench/releases/download/v0.9.0/Daylight-0.9.0-arm64.zip',
    'https://github.com/liki-0814/daylight-workbench/releases/download/v0.8.0/Daylight-0.9.0-arm64.zip',
    'https://evil.example/liki-0814/daylight-workbench/releases/download/v0.9.0/Daylight-0.9.0-arm64.zip',
    `${url}?x=1`, `${url}#x`, `${url}/..`, 'http://github.com/liki-0814/daylight-workbench/releases/download/v0.9.0/Daylight-0.9.0-arm64.zip',
    'https://user@github.com/liki-0814/daylight-workbench/releases/download/v0.9.0/Daylight-0.9.0-arm64.zip', '', null,
  ]) assert.equal(isTrustedAssetURL(evil, '0.9.0', 'Daylight-0.9.0-arm64.zip'), false, String(evil));
  assert.equal(assetURL('0.9.0', '../x'), null);
  assert.equal(assetURL('0.9.0', 'a/b.zip'), null);
  assert.equal(assetURL('bad', 'x.zip'), null);
  for (const host of ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'GitHub.com']) assert.equal(isTrustedRedirectHost(host), true, host);
  for (const host of ['evil.example', 'github.com.evil.example', 'githubusercontent.com', 'api.github.com', '', null]) assert.equal(isTrustedRedirectHost(host), false, String(host));
});

test('digests accept GitHub sha256: prefixes and compare case-insensitively', () => {
  assert.equal(normalizeDigest(`sha256:${sha.toUpperCase()}`), sha);
  assert.equal(digestsMatch(`sha256:${sha}`, sha), true);
  assert.equal(digestsMatch(sha, 'b'.repeat(64)), false);
  assert.equal(digestsMatch(null, sha), false);
  assert.equal(digestsMatch('sha1:abc', 'sha1:abc'), false);
});

test('manifests are validated field by field before anything is downloaded', () => {
  const ok = parseUpdateManifest(manifestText(), '0.9.0');
  assert.equal(ok.ok, true);
  assert.equal(ok.manifest.sha256, sha);
  assert.equal(parseUpdateManifest(manifestText(), 'v0.9.0').ok, true);
  const code = (text, expected) => { const result = parseUpdateManifest(text, expected); assert.equal(result.ok, false); return result.code; };
  assert.equal(code('{not json', null), 'manifest-malformed');
  assert.equal(code('[]', null), 'manifest-malformed');
  assert.equal(code('null', null), 'manifest-malformed');
  assert.equal(code(manifestText({ schema: 2 }), null), 'manifest-schema');
  assert.equal(code(manifestText({ version: '0.9' }), null), 'manifest-malformed');
  assert.equal(code(manifestText({ version: 'v0.9.0' }), null), 'manifest-malformed');
  assert.equal(code(manifestText({ version: '00.9.0' }), null), 'manifest-malformed');
  assert.equal(code(manifestText(), '0.9.1'), 'manifest-version');
  assert.equal(code(manifestText({ url: 'https://evil.example/Daylight-0.9.0-arm64.zip' }), '0.9.0'), 'manifest-url');
  assert.equal(code(manifestText({ size: 0 }), null), 'manifest-malformed');
  assert.equal(code(manifestText({ size: 1.5 }), null), 'manifest-malformed');
  assert.equal(code(manifestText({ size: 10 ** 12 }), null), 'manifest-malformed');
  assert.equal(code(manifestText({ sha256: 'xyz' }), null), 'manifest-malformed');
  assert.equal(code(manifestText({ sha256: sha.toUpperCase() }), null), 'manifest-malformed');
  assert.equal(code(manifestText({ minOS: 'latest' }), null), 'manifest-malformed');
  assert.equal(code(manifestText({ date: 'yesterday' }), null), 'manifest-malformed');
  assert.equal(code(manifestText({ downgradeable: 'no' }), null), 'manifest-malformed');
  assert.equal(code(manifestText({ downgradeable: undefined }), null), 'manifest-malformed');
});

test('update decisions refuse downgrades, same versions, old systems and disagreeing digests', () => {
  const manifest = parseUpdateManifest(manifestText(), '0.9.0').manifest;
  const decide = (extra = {}) => decideUpdate({ current: '0.5.1', manifest, release: { digest: `sha256:${sha}`, size: 1000 }, os: '14.2.1', ...extra });
  assert.deepEqual(decide(), { ok: true, code: 'ok', message: '' });
  assert.equal(decide({ current: '0.9.0' }).code, 'same-version');
  assert.equal(decide({ current: '1.0.0' }).code, 'downgrade-refused');
  assert.equal(decide({ current: '1.0.0', allowDowngrade: true }).code, 'downgrade-refused');
  const downgradeable = { ...manifest, downgradeable: true };
  assert.equal(decide({ current: '1.0.0', manifest: downgradeable }).code, 'downgrade-refused');
  assert.equal(decide({ current: '1.0.0', manifest: downgradeable, allowDowngrade: true }).ok, true);
  assert.equal(decide({ current: 'bad' }).code, 'version-unrecognized');
  assert.equal(decide({ os: '12.6' }).code, 'os-too-old');
  assert.equal(decide({ release: { digest: `sha256:${'b'.repeat(64)}` } }).code, 'digest-mismatch');
  assert.equal(decide({ release: { size: 999 } }).code, 'size-mismatch');
  assert.equal(decide({ release: null }).ok, true);
  assert.equal(osAtLeast('14.0', '13.0.1'), true);
  assert.equal(osAtLeast('13.0', '13.0.1'), false);
  assert.equal(osAtLeast('x', '13.0'), false);
});

test('Ed25519 manifest signatures verify only for the exact bytes and the matching key', () => {
  const pair = keys(), other = keys();
  const publicKey = rawPublicKeyBase64(pair.privateKey);
  assert.equal(Buffer.from(publicKey, 'base64').length, 32);
  const text = buildManifest({ version: '0.9.0', size: 1000, sha256: sha, date: '2026-10-19T00:00:00Z' });
  const signature = signBytes(pair.privateKey, text);
  assert.equal(verifyBytes(publicKey, text, signature), true);
  assert.equal(verifyBytes(publicKey, text.replace('1000', '1001'), signature), false, 'tampered manifest');
  assert.equal(verifyBytes(publicKey, `${text} `, signature), false, 'whitespace is part of the signed bytes');
  assert.equal(verifyBytes(rawPublicKeyBase64(other.privateKey), text, signature), false, 'wrong key');
  assert.equal(verifyBytes(publicKey, text, signature.slice(0, -4) + 'AAAA'), false, 'corrupted signature');
  assert.equal(verifyBytes(publicKey, text, ''), false);
  assert.equal(verifyBytes(publicKey, text, 'not base64 !!'), false);
  assert.equal(verifyBytes('short', text, signature), false);
  assert.throws(() => publicKeyFromBase64('AAAA'), /32 字节/);
  assert.equal(parseUpdateManifest(text, '0.9.0').ok, true);
});

test('release manifests are built from a validated version and sha256 of the real file', async () => {
  assert.throws(() => buildManifest({ version: 'nightly', size: 1, sha256: sha }), /版本号无效/);
  assert.throws(() => buildManifest({ version: '0.9.0', size: 0, sha256: sha }), /文件大小/);
  assert.throws(() => buildManifest({ version: '0.9.0', size: 1, sha256: 'zz' }), /校验值/);
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-sha-'));
  try {
    const file = path.join(dir, 'a.bin');
    await writeFile(file, 'daylight');
    assert.equal(await sha256File(file), 'c8ccaa4383657cd5e791388d7e5bdac754d834bd2509a22017e0419fb1f2344e');
  } finally { await rm(dir, { recursive: true, force: true }); }
  assert.equal(manifestAssetName, 'latest-mac.json');
  assert.equal(signatureAssetName, 'latest-mac.json.sig');
});

test('release assets are only usable when the zip, manifest and signature are all present on the tag', () => {
  const base = 'https://github.com/liki-0814/daylight-workbench/releases/download/v0.9.0/';
  const assets = names => names.map(name => ({ name, browser_download_url: `${base}${name}`, size: 10, digest: `sha256:${sha}` }));
  const body = assets => ({ tag_name: 'v0.9.0', name: '0.9.0', draft: false, prerelease: false, html_url: 'https://github.com/liki-0814/daylight-workbench/releases/tag/v0.9.0', body: '说明', assets });
  const all = interpretRelease('0.5.1', 200, body(assets(['Daylight-0.9.0-arm64.zip', 'latest-mac.json', 'latest-mac.json.sig', 'Daylight-0.9.0-arm64.dmg'])));
  assert.equal(all.latest.update.zip.url, `${base}Daylight-0.9.0-arm64.zip`);
  assert.equal(all.latest.update.zip.digest, sha);
  assert.ok(all.latest.update.manifest && all.latest.update.signature);
  assert.equal(interpretRelease('0.5.1', 200, body(assets(['Daylight-0.9.0-arm64.zip', 'latest-mac.json']))).latest.update, null);
  const evil = body([...assets(['latest-mac.json', 'latest-mac.json.sig']), { name: 'Daylight-0.9.0-arm64.zip', browser_download_url: 'https://evil.example/Daylight-0.9.0-arm64.zip', size: 10 }]);
  assert.equal(interpretRelease('0.5.1', 200, evil).latest.update, null);
  assert.equal(all.latest.body, '说明');
});

test('the updater endpoint is gated and the web edition reports it cannot install', async () => {
  assert.deepEqual(resolveRoute('/api/app/updater', 'GET'), { auth: 'web', handler: 'appUpdater' });
  assert.deepEqual(resolveRoute('/api/app/updater', 'POST'), { auth: 'webOrigin', handler: 'appUpdater' });
  assert.equal(resolveRoute('/api/app/updater', 'DELETE').handler, 'missing');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'daylight-updater-'));
  const server = await createWorkbench({ dataDir, appVersion: '0.5.1', releaseFetch: async () => new Response('{}', { status: 404 }), proxyOptions: { includeGateway: false, includeAgy: false, includeGrok: false } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const { token } = await (await fetch(`${url}/api/state`)).json();
    const headers = { 'x-workbench-token': token };
    assert.equal((await fetch(`${url}/api/app/updater`)).status, 403);
    const status = await (await fetch(`${url}/api/app/updater`, { headers })).json();
    assert.equal(status.supported, false);
    assert.equal(status.reason, 'web');
    assert.equal(status.phase, 'idle');
    assert.equal(status.current.version, '0.5.1');
    const post = await fetch(`${url}/api/app/updater`, { method: 'POST', headers: { ...headers, origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'download' }) });
    assert.equal(post.status, 409);
    assert.equal((await post.json()).code, 'web-edition');
    assert.equal((await fetch(`${url}/api/app/updater`, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{}' })).status, 403);
  } finally {
    await server.closeProxy();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('package.json and package-lock.json agree on the version', async () => {
  const report = await versionReport({});
  assert.equal(report.ok, true, JSON.stringify(report.found));
  assert.equal((await versionReport({ tag: 'v0.0.1' })).ok, false);
});
