import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// The Swift shell cannot be compiled or run here (no Swift toolchain), so these tests pin the source wiring only.
// Everything below is UNVERIFIED at runtime until the app is built and tried on a Mac.
const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const [picker, main, launcher, build, doc] = await Promise.all(['native/NativeFolderPicker.swift', 'native/main.swift', 'native/Launcher.swift', 'scripts/build-native.py', 'docs/native-folder-picker.md'].map(read));

test('native folder picker: message name and event name are the documented bridge API', () => {
  assert.match(picker, /static let messageName = "pickFolder", eventName = "daylight-folder-picked"/);
  assert.match(picker, /final class NativeFolderPicker: NSObject, WKScriptMessageHandler/);
  for (const text of ['`pickFolder`', "CustomEvent('daylight-folder-picked')", 'window.webkit.messageHandlers.pickFolder.postMessage({requestId})', '{requestId, ok: true, path:', '{requestId, ok: false, cancelled: true}', '{requestId, ok: false, error:']) assert.ok(doc.includes(text), 'docs mention ' + text);
});

test('native folder picker: the panel is folders only, single selection, a sheet on the main window, and the page supplies nothing but requestId', () => {
  assert.match(picker, /panel\.canChooseDirectories = true; panel\.canChooseFiles = false; panel\.allowsMultipleSelection = false; panel\.canCreateDirectories = false/);
  assert.match(picker, /panel\.beginSheetModal\(for: window\)/);
  assert.doesNotMatch(picker, /runModal\(\)|directoryURL|allowedContentTypes|allowedFileTypes/);
  assert.match(picker, /Set\(body\.keys\) == Set\(\["requestId"\]\)/);
  assert.match(picker, /matches\(id, "\^\[a-zA-Z0-9_-\]\{8,100\}\$"\)/);
  assert.match(picker, /guard pending == nil else \{ reply\(id, \["ok": false, "error": "[^"]+"\]\); return \}/);
});

test('native folder picker: only the main frame of the local page may ask, and the answer only goes back to the local page', () => {
  assert.match(picker, /message\.frameInfo\.isMainFrame,\s*origin\.protocol == "http", origin\.host == "127\.0\.0\.1", origin\.port == port, message\.webView === web/);
  assert.match(picker, /url\.scheme == "http", url\.host == "127\.0\.0\.1", url\.port == port/);
  assert.match(picker, /path\.hasPrefix\("\/"\), !path\.contains\("\\0"\)/);
  // the answer is exactly one of: {ok:true,path}, {ok:false,cancelled:true}, {ok:false,error}
  assert.match(picker, /self\.reply\(id, \["ok": false, "cancelled": true\]\)/);
  assert.match(picker, /self\.reply\(id, \["ok": true, "path": path\]\)/);
});

test('native folder picker: the reply script dispatches daylight-folder-picked with the detail', () => {
  const [, expression] = /web\.evaluateJavaScript\("([^"]*)"\)/.exec(picker);
  assert.match(expression, /\\\(NativeFolderPicker\.eventName\)/);
  const script = expression.replace('\\(NativeFolderPicker.eventName)', 'daylight-folder-picked').replace('\\(literal)', JSON.stringify({ requestId: 'abcdefgh', ok: true, path: '/Users/x/skill' }));
  const seen = [];
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } }
  vm.runInNewContext(script, { CustomEvent, window: { dispatchEvent: event => seen.push(event) } });
  assert.equal(seen.length, 1); assert.equal(seen[0].type, 'daylight-folder-picked'); assert.deepEqual({ ...seen[0].detail }, { requestId: 'abcdefgh', ok: true, path: '/Users/x/skill' });
});

test('native folder picker: registered on the main window only (not the Launcher panel), torn down on quit, and compiled by build-native', () => {
  assert.match(main, /config\.userContentController\.add\(folderPicker, name: NativeFolderPicker\.messageName\)/);
  assert.match(main, /folderPicker\.attach\(web\)/);
  assert.match(main, /folderPicker\?\.stop\(\)/);
  assert.equal((main.match(/NativeFolderPicker\(/g) || []).length, 1);
  assert.doesNotMatch(launcher, /NativeFolderPicker|pickFolder/);
  assert.match(build, /'NativeReveal\.swift', 'NativeFolderPicker\.swift'/);
  assert.match(doc, /未验证/);
});
