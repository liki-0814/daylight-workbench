import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildRuntime } from '../scripts/build-runtime.mjs';
import { buildNativeCore } from '../scripts/build-native-core.mjs';
import { trimRuntime } from '../scripts/trim-runtime.mjs';

test('packaging removes unreachable files while retaining both windows, native APIs, dynamic MCP and licenses', async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const resources = await mkdtemp(path.join(os.tmpdir(), 'daylight-trim-'));
  t.after(() => rm(resources, { recursive: true, force: true }));
  for (const folder of ['public', 'proxy', 'ai', 'cli', 'licenses', 'core']) {
    await cp(path.join(root, folder), path.join(resources, folder), { recursive: true });
  }
  await cp(path.join(root, 'agent-api.mjs'), path.join(resources, 'agent-api.mjs'));
  await cp(path.join(root, 'native/tray-model.mjs'), path.join(resources, 'tray-model.mjs'));
  await writeFile(path.join(resources, 'package.json'), '{"type":"module"}');
  await mkdir(path.join(resources, 'proxy/test-cache'));
  await writeFile(path.join(resources, 'proxy/test-cache/unused.json'), '{}');
  await writeFile(path.join(resources, 'ai/unused.mjs'), 'throw Error("must not enter the App");');
  await buildNativeCore(resources);
  const bundle = await buildRuntime(resources);
  const nativeModel = await readFile(path.join(resources, 'public/model.js'), 'utf8');
  const report = await trimRuntime(resources);
  assert.ok(report.removed.includes('ai/unused.mjs'));
  assert.ok(report.removed.includes('proxy/test-cache/unused.json'));
  assert.ok(report.removed.includes('ai/adapters/qoder-events.mjs'), 'SDK adapter dependencies are already compiled into the runtime bundle');
  for (const file of ['native-core.js', 'public/index.html', 'public/quick.html', 'public/components/button.css', 'public/components/section.js', 'public/components/purify.js', 'ai/mcp-server.mjs', 'proxy/sidecar.mjs', 'ai/sidecar.mjs', 'agent-api.mjs', 'tray-model.mjs', bundle.entry]) {
    assert.ok(report.files.includes(file), 'Missing runtime entry/dependency: ' + file);
    await access(path.join(resources, file));
  }
  for (const pkg of bundle.packages) {
    await access(path.join(resources, 'licenses/npm', pkg.name.replaceAll('/', '__')));
  }
  await assert.rejects(access(path.join(resources, 'proxy/test-cache')));
  assert.equal((await readFile(path.join(resources, bundle.entry))).length, bundle.bytes);
  assert.equal(await readFile(path.join(resources, 'public/model.js'), 'utf8'), nativeModel);
  assert.ok(report.minified.afterBytes < report.minified.beforeBytes);
  // Loading the actual retained AI and proxy services outside the checkout
  // detects imports that would otherwise be accidentally satisfied by npm.
  execFileSync(process.execPath, ['--input-type=module', '-e',
    'const ai=await import(process.argv[1]);const proxy=await import(process.argv[2]);if(typeof ai.createAIService!=="function"||typeof proxy.createProxyService!=="function")throw Error("service entry");',
    pathToFileURL(path.join(resources, 'ai/service.mjs')).href,
    pathToFileURL(path.join(resources, 'proxy/service.js')).href],
    { cwd: resources, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } });
});
