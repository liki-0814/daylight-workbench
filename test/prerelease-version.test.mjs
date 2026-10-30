import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compareVersions, decideUpdate, interpretRelease, parseVersion, parseRunningVersion, assetURL, packageAssetName } from '../core/app-update.js';
import { bundleVersion } from '../scripts/release/check-version.mjs';

// 0.7.0-beta.1 is the version of a beta build: it must compare with SemVer rules and never break the updater.

test('a prerelease is older than the same release and ordered by SemVer', () => {
  const order = ['0.6.1', '0.7.0-alpha', '0.7.0-alpha.1', '0.7.0-alpha.beta', '0.7.0-beta', '0.7.0-beta.2', '0.7.0-beta.11', '0.7.0-rc.1', '0.7.0', '0.7.1'];
  for (let a = 0; a < order.length; a += 1) for (let b = 0; b < order.length; b += 1) assert.equal(compareVersions(order[a], order[b]), Math.sign(a - b), `${order[a]} vs ${order[b]}`);
  assert.equal(compareVersions('v0.7.0-beta.1', '0.7.0-beta.1'), 0);
  assert.equal(compareVersions('0.7.0-beta.1+build5', '0.7.0-beta.1'), 0);
  assert.equal(compareVersions('0.7.0-beta.1', '0.6.9'), 1);
});

test('malformed versions still compare as unknown', () => {
  for (const bad of ['', null, '0.7', '0.7.0-', '0.7.0-beta..1', '0.7.0-01', '0.7.0.1', 'abc', '0.7.0 beta']) {
    assert.equal(compareVersions(bad, '0.7.0'), null, String(bad));
    assert.equal(compareVersions('0.7.0', bad), null, String(bad));
  }
  assert.equal(parseRunningVersion('0.7.0-beta.1').pre.join('.'), 'beta.1');
});

test('releases, manifests and asset URLs stay strictly x.y.z', () => {
  assert.equal(parseVersion('0.7.0-beta.1'), null);
  assert.equal(assetURL('0.7.0-beta.1', packageAssetName('0.7.0-beta.1')), null);
  assert.ok(assetURL('0.7.0', packageAssetName('0.7.0')));
});

test('a beta build is offered the stable release of the same x.y.z and nothing wrong', () => {
  const body = { tag_name: 'v0.7.0', name: 'Daylight 0.7.0', html_url: 'https://github.com/liki-0814/daylight-workbench/releases/tag/v0.7.0', assets: [] };
  assert.equal(interpretRelease('0.7.0-beta.1', 200, body).status, 'available');
  assert.equal(interpretRelease('0.7.0', 200, body).status, 'current');
  assert.equal(interpretRelease('0.7.1', 200, body).status, 'current');
  // a prerelease tag published without the prerelease flag is not an update candidate
  assert.equal(interpretRelease('0.6.1', 200, { ...body, tag_name: 'v0.7.0-beta.2' }).status, 'unrecognized');
  assert.equal(interpretRelease('0.7.0-beta.1', 200, { ...body, prerelease: true }).status, 'none');
});

test('decideUpdate lets a beta move to the release, refuses sideways/back moves and prerelease targets', () => {
  const sha = 'a'.repeat(64);
  const manifest = version => ({ version, url: assetURL('0.7.0', packageAssetName('0.7.0')), size: 1000, sha256: sha, minOS: '13.0', date: '2026-10-30T00:00:00Z', downgradeable: false });
  assert.equal(decideUpdate({ current: '0.7.0-beta.1', manifest: manifest('0.7.0') }).ok, true);
  assert.equal(decideUpdate({ current: '0.7.0', manifest: manifest('0.7.0') }).code, 'same-version');
  assert.equal(decideUpdate({ current: '0.7.0', manifest: manifest('0.7.0-beta.1') }).code, 'version-unrecognized');
  assert.equal(decideUpdate({ current: '0.7.0-beta.1', manifest: manifest('0.6.1') }).code, 'downgrade-refused');
});

test('bundle versions: numeric core for CFBundle keys, full version kept separately', async () => {
  assert.equal(bundleVersion('0.7.0-beta.1'), '0.7.0');
  assert.equal(bundleVersion('0.7.0'), '0.7.0');
  assert.equal(bundleVersion('0.7.0-rc.1+b2'), '0.7.0');
  assert.equal(bundleVersion('0.7'), undefined);
  const source = await readFile(new URL('../scripts/build-native.py', import.meta.url), 'utf8');
  assert.match(source, /'CFBundleShortVersionString': bundle_version, 'CFBundleVersion': bundle_version, 'DaylightVersion': version/);
  for (const file of ['Updater.swift', 'UpdaterHelper.swift', 'Server.swift']) assert.match(await readFile(new URL('../native/' + file, import.meta.url), 'utf8'), /DaylightVersion/, file);
});
