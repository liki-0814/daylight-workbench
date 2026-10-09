import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const entry = fileURLToPath(new URL('../server.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'daylight-web-')), bin = path.join(root, 'bin'), data = path.join(root, 'data'), browserLog = path.join(root, 'browser.json');
  await mkdir(bin);
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  await writeFile(path.join(bin, opener), `#!${process.execPath}\n(async () => { const args = process.argv.slice(2); const response = await fetch(args[0] + '/api/state'); require('node:fs').writeFileSync(${JSON.stringify(browserLog)}, JSON.stringify({args, status: response.status})); })().catch(() => process.exit(1));\n`, { mode: 0o755 });
  const children = [];
  const start = (args = [], port = '0') => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: root, env: { ...process.env, PORT: port, WORKBENCH_DATA_DIR: data, WORKBENCH_AGENTS_ROOT: path.join(root, 'agents'), WORKBENCH_EXTENSION_CLIENT_ROOTS: JSON.stringify({ codex: path.join(root, 'codex'), qoder: path.join(root, 'qoder'), pi: path.join(root, 'pi') }), PI_CODING_AGENT_DIR: path.join(root, 'pi'), PATH: bin + path.delimiter + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    const run = { child, output: '', errors: '', exit: new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }) };
    child.stdout.on('data', value => { run.output += value; }); child.stderr.on('data', value => { run.errors += value; }); children.push(run);
    return run;
  };
  const stop = async run => {
    if (run.child.exitCode !== null || run.child.signalCode !== null) return run.exit;
    run.child.kill('SIGTERM');
    const timer = setTimeout(() => run.child.kill('SIGKILL'), 5000);
    try { return await run.exit; } finally { clearTimeout(timer); }
  };
  t.after(async () => { await Promise.all(children.map(stop)); await rm(root, { recursive: true, force: true }); });
  return { root, data, browserLog, start, stop };
}
async function ready(run) {
  for (let i = 0; i < 400; i++) {
    const url = run.output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (url) return url;
    assert.equal(run.child.exitCode, null, run.errors); await delay(20);
  }
  throw new Error('Web service did not become ready: ' + run.errors);
}

test('Web opens only after HTTP readiness, serves repository assets and preserves data across mode restarts', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), run = f.start(['--open']), url = await ready(run);
  for (let i = 0; i < 100; i++) { try { await access(f.browserLog); break; } catch { await delay(20); } }
  assert.deepEqual(JSON.parse(await readFile(f.browserLog, 'utf8')), { args: [url], status: 200 });
  assert.equal((await fetch(url + '/')).status, 200);
  assert.equal((await fetch(url + '/extensions/page.js')).status, 200);
  const state = await (await fetch(url + '/api/state')).json();
  assert.equal((await fetch(url + '/api/ai/settings')).status, 403);
  const headers = { 'X-Workbench-Token': state.token, Origin: url, 'Content-Type': 'application/json' };
  const sources = await (await fetch(url + '/api/extensions/state', { headers })).json();
  assert.deepEqual(sources.skills, []);
  await assert.rejects(access(path.join(f.data, 'ai')));
  const response = await fetch(url + '/api/task-actions', { method: 'POST', headers, body: JSON.stringify({ requestId: 'web-entry-task', expectedVersion: state.version, action: { type: 'project.create', name: 'Web project' } }) });
  assert.equal(response.status, 200, await response.text());
  assert.equal((await f.stop(run)).code, 0);
  await assert.rejects(fetch(url + '/api/state'));
  await rm(f.browserLog);
  const restarted = f.start(['--open', '--no-open']), nextUrl = await ready(restarted);
  const next = await (await fetch(nextUrl + '/api/state')).json();
  assert.equal(next.version, 1); assert.equal(next.state.projects[0].name, 'Web project');
  assert.notEqual(next.token, state.token);
  assert.equal((await fetch(nextUrl + '/api/ai/settings', { headers: { 'X-Workbench-Token': next.token } })).status, 200);
  await delay(150); await assert.rejects(access(f.browserLog));
  assert.equal((await f.stop(restarted)).code, 0);
});

test('occupied Web port exits clearly before touching data, sources or browser', async t => {
  const occupied = http.createServer((req, res) => res.end('existing instance'));
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const f = await fixture(t), run = f.start(['--open'], String(occupied.address().port));
  assert.equal((await run.exit).code, 1);
  assert.match(run.errors, /端口 .* 已被占用/); assert.match(run.errors, /WORKBENCH_DATA_DIR/);
  assert.equal(run.output, '');
  await assert.rejects(access(f.data)); await assert.rejects(access(path.join(f.root, 'agents'))); await assert.rejects(access(f.browserLog));
  assert.equal(await (await fetch(`http://127.0.0.1:${occupied.address().port}`)).text(), 'existing instance');
});

test('invalid Web port fails before initialization', async t => {
  const f = await fixture(t);
  for (const port of ['-1', '65536', '4318bad']) {
    const run = f.start([], port);
    assert.equal((await run.exit).code, 1); assert.match(run.errors, /PORT 必须/);
    await assert.rejects(access(f.data));
  }
});
