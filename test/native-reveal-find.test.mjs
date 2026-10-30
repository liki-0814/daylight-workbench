import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// The Swift shell cannot be compiled or run here (no Swift toolchain), so these tests pin the source wiring only.
// Everything below is UNVERIFIED at runtime until the app is built and tried on a Mac.
const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const [reveal, server, proxy, main, build] = await Promise.all(['native/NativeReveal.swift', 'native/Server.swift', 'native/Proxy.swift', 'native/main.swift', 'scripts/build-native.py'].map(read));

test('native reveal: the helper resolves the path, the shell opens it with NSWorkspace and strips it from the reply', () => {
  assert.match(reveal, /NSWorkspace\.shared\.activateFileViewerSelecting\(\[url\]\)/);
  assert.match(reveal, /dictionary\.removeValue\(forKey: field\)/);
  assert.match(reveal, /static let environmentKey = "DAYLIGHT_REVEAL", environmentValue = "native", field = "hostReveal"/);
  // only an absolute, NUL-free, existing path from a 200 reply is opened; everything else is a 500 without echoing the path
  assert.match(reveal, /code == 200, let path = value as\? String, path\.hasPrefix\("\/"\), !path\.contains\("\\0"\), FileManager\.default\.fileExists\(atPath: path\)/);
  assert.doesNotMatch(reveal, /"error": "[^"]*\\\(/);
  assert.match(reveal, /return \(500, \["error": "[^"]+", "code": "EXTENSIONS_REVEAL_FAILED"\]\)/);
  assert.match(reveal, /static let route = "\/api\/extensions\/reveal"/);
});

test('native reveal: only the AI helper POST to the reveal route goes through finish, and only the AI helper gets the environment', () => {
  assert.match(server, /handler == "ai" && method == "POST" && path == NativeReveal\.route \? NativeReveal\.finish\(code, object\) : \(code, object\)/);
  assert.equal((server.match(/NativeReveal\./g) || []).length, 2);
  assert.match(proxy, /if helper == "ai" \{ env\[NativeReveal\.environmentKey\] = NativeReveal\.environmentValue \}/);
  assert.match(build, /'DisplayAccessibility\.swift', 'NativeReveal\.swift'/);
});

test('native menu: 编辑 › 查找 › 查找… is ⌘F and only raises daylight-find in the main web view', () => {
  assert.match(main, /let findItem = NSMenuItem\(title: "查找", action: nil, keyEquivalent: ""\); let findMenu = NSMenu\(title: "查找"\)/);
  assert.match(main, /findMenu\.addItem\(item\("查找…", key: "f"\) \{ self\.findInPage\(\) \}\)/);
  const edit = main.indexOf('let edit = NSMenuItem(title: "编辑"'), find = main.indexOf('let findItem'), set = main.indexOf('NSApp.mainMenu = menu');
  assert.ok(edit > 0 && edit < find && find < set, '查找 sits inside the 编辑 menu');
  const body = /func findInPage\(\) \{([\s\S]*?)\n    \}/.exec(main)[1];
  assert.match(body, /guard window\?\.isKeyWindow == true, web != nil else \{ return \}/);
  const script = /web\.evaluateJavaScript\("([^"]+)"\)/.exec(body)[1];
  assert.equal((body.match(/evaluateJavaScript/g) || []).length, 1);
  const seen = [];
  class CustomEvent { constructor(type) { this.type = type; } }
  vm.runInNewContext(script, { CustomEvent, window: { dispatchEvent: event => seen.push(event.type) } });
  assert.deepEqual(seen, ['daylight-find']);
});
