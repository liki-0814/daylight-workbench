import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extensionCapability } from '../public/extensions/capabilities.js';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('extensions.* in the capabilities mirror is the only source; only a literal true counts', () => {
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

test('the flat mirror (the old shape) is no longer read: no extensions.* means no button', () => {
  assert.equal(extensionCapability({ restoreBackup: true, reveal: true }, 'reveal'), false);
  assert.equal(extensionCapability({ restoreBackup: true, reveal: true }, 'restoreBackup'), false);
  assert.equal(extensionCapability({ extensions: { other: true }, reveal: true }, 'reveal'), false, 'extensions present but without this key: the flat key is ignored too');
  assert.equal(extensionCapability({ extensions: { reveal: false }, reveal: true }, 'reveal'), false);
  assert.equal(extensionCapability({ extensions: { reveal: true }, reveal: false }, 'reveal'), true);
});

test('mcpConflictCompare is read the same way (only a literal true)', () => {
  assert.equal(extensionCapability({ extensions: { mcpConflictCompare: true } }, 'mcpConflictCompare'), true);
  assert.equal(extensionCapability({ extensions: { mcpConflictCompare: 'yes' } }, 'mcpConflictCompare'), false);
  assert.equal(extensionCapability({ mcpConflictCompare: true }, 'mcpConflictCompare'), false);
});

test('capabilities.js has no flat-key fallback left in its code', () => {
  const code = read('public/extensions/capabilities.js').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /capabilities\??\.\[name\]|capabilities\?\.\[/, 'no read of capabilities[name]');
  assert.match(code, /extensions\[name\] === true/);
});

test('page.js gates through capabilities.js and the asset is registered', () => {
  const page = read('public/extensions/page.js');
  assert.match(page, /import \{ extensionCapability \} from '\.\/capabilities\.js'/);
  assert.match(page, /extensionCapability\(state\?\.capabilities, name\)/);
  assert.doesNotMatch(page, /state\?\.capabilities\?\.\[name\]/, 'the old flat read is gone');
  assert.equal(JSON.parse(read('core/web-assets.json'))['/extensions/capabilities.js'], 'extensions/capabilities.js');
});

test('skillConflict goes through the same gate: conflictSupported reads capabilities.js, and page.js asks it before drawing any conflict UI', () => {
  const conflict = read('public/extensions/conflict.js'), page = read('public/extensions/page.js');
  assert.match(conflict, /import \{ extensionCapability \} from '\.\/capabilities\.js'/);
  assert.match(conflict, /conflictSupported = capabilities => extensionCapability\(capabilities, 'skillConflict'\)/);
  assert.doesNotMatch(conflict.replace(/^\s*\/\/.*$/gm, ''), /skillConflict\s*(!==|===)/, 'no private comparison next to the shared helper');
  assert.match(page, /!conflictSupported\(state\?\.capabilities\)\) return ''/, 'conflict markup is skipped when the gate is closed');
  for (const value of [true]) assert.equal(extensionCapability({ extensions: { skillConflict: value } }, 'skillConflict'), true);
  for (const value of [false, 'true', 1, undefined, null, {}]) assert.equal(extensionCapability({ extensions: { skillConflict: value } }, 'skillConflict'), false, String(value));
});
