import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extensionCapability } from '../public/extensions/capabilities.js';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('extensions.* in the capabilities mirror is the source; only a literal true counts', () => {
  assert.equal(extensionCapability({ extensions: { reveal: true, restoreBackup: true } }, 'reveal'), true);
  assert.equal(extensionCapability({ extensions: { reveal: true, restoreBackup: true } }, 'restoreBackup'), true);
  assert.equal(extensionCapability({ extensions: { restoreBackup: true } }, 'reveal'), false, 'reveal is absent where Finder cannot be opened');
  for (const value of [false, 'true', 1, null, {}]) assert.equal(extensionCapability({ extensions: { reveal: value } }, 'reveal'), false, JSON.stringify(value));
});

test('missing or malformed mirrors hide both buttons', () => {
  for (const capabilities of [undefined, null, {}, [], 'x', { extensions: null }, { extensions: [] }]) {
    assert.equal(extensionCapability(capabilities, 'reveal'), false, JSON.stringify(capabilities));
    assert.equal(extensionCapability(capabilities, 'restoreBackup'), false, JSON.stringify(capabilities));
  }
});

test('the nested value wins; the flat mirror (what #36 498c48f returns today) is only a fallback when extensions is absent', () => {
  assert.equal(extensionCapability({ extensions: { reveal: false }, reveal: true }, 'reveal'), false);
  assert.equal(extensionCapability({ extensions: { reveal: true }, reveal: false }, 'reveal'), true);
  assert.equal(extensionCapability({ restoreBackup: true, reveal: true }, 'reveal'), true);
  assert.equal(extensionCapability({ restoreBackup: true }, 'reveal'), false);
  assert.equal(extensionCapability({ extensions: { other: true }, reveal: true }, 'reveal'), true, 'extensions present but without this key: fall back to the flat key');
});

test('page.js gates through capabilities.js and the asset is registered', () => {
  const page = read('public/extensions/page.js');
  assert.match(page, /import \{ extensionCapability \} from '\.\/capabilities\.js'/);
  assert.match(page, /extensionCapability\(state\?\.capabilities, name\)/);
  assert.doesNotMatch(page, /state\?\.capabilities\?\.\[name\]/, 'the old flat read is gone');
  assert.equal(JSON.parse(read('core/web-assets.json'))['/extensions/capabilities.js'], 'extensions/capabilities.js');
});
