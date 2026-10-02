import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { buildRuntime } from '../scripts/build-runtime.mjs';

test('runtime is a deterministic, isolated bundle with complete dependency licenses', async t => {
  // Outside the checkout: import cannot silently fall back to its node_modules.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'daylight-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await buildRuntime(path.join(directory, 'first'));
  const second = await buildRuntime(path.join(directory, 'second'));
  assert.equal(first.sha256, second.sha256);
  assert.ok(first.bytes < 1_000_000, 'Runtime size regression: inspect dependency graph');
  const resources = path.join(directory, 'first');
  assert.ok(!(await readdir(resources)).includes('node_modules'));
  const code = await readFile(path.join(resources, first.entry));
  assert.equal(createHash('sha256').update(code).digest('hex'), first.sha256);
  assert.ok(first.packages.some(p => p.name === '@qoder-ai/qoder-agent-sdk'));
  assert.ok(first.packages.some(p => p.name === '@modelcontextprotocol/sdk'));
  for (const pkg of first.packages) {
    const license = path.join(resources, 'licenses/npm', pkg.name.replaceAll('/', '__'));
    assert.ok((await readdir(license)).length, 'Missing license for ' + pkg.name);
  }
  const entry = pathToFileURL(path.join(resources, first.entry)).href;
  execFileSync(process.execPath, ['--input-type=module', '-e',
    'const a=await import(process.argv[1]); for(const n of ["discover","run","permissions"]) if(typeof a[n]!=="function") throw new Error(n); const p=a.permissions({ask:async()=>({}),approve:async()=>true}); if((await p("Read",{},{})).behavior!=="allow") throw new Error("permission adapter");', entry],
    { cwd: directory, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } });
});
