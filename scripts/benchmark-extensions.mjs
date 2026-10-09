import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createWorkbench } from '../server.mjs';
import { fixtureState } from '../test/fixtures.mjs';

const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'daylight-extension-benchmark-'))), agentsRoot = path.join(temporary, 'agents');
let server;
try {
  for (let offset = 0; offset < 1000; offset += 40) await Promise.all(Array.from({ length: 40 }, async (_, index) => {
    const name = 'skill-' + (offset + index), directory = path.join(agentsRoot, 'skills', name);
    await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'SKILL.md'), '---\nname: ' + name + '\ndescription: 合成规模验收\n---\nPublic fixture');
  }));
  await fs.mkdir(path.join(agentsRoot, 'mcp'), { recursive: true });
  await fs.writeFile(path.join(agentsRoot, 'mcp', 'servers.json'), JSON.stringify({ schemaVersion: 1, servers: Array.from({ length: 100 }, (_, index) => ({ id: 'server-' + index, name: 'Server ' + index, transport: 'http', url: 'http://127.0.0.1:1/mcp', headerRefs: {} })) }));
  const dataDir = path.join(temporary, 'data'); await fs.mkdir(dataDir); await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ version: 0, state: fixtureState() }));
  server = await createWorkbench({ dataDir, extensionsOptions: { agentsRoot, clientRoots: Object.fromEntries(['codex', 'qoder', 'pi'].map(id => [id, path.join(temporary, id)])), environment: { PATH: '' }, cacheMs: 60000 } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port, token = (await (await fetch(base + '/api/state')).json()).token;
  const read = async (route, body) => { const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'X-Workbench-Token': token, Origin: base }, ...(body ? { body: JSON.stringify(body) } : {}) }); const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result; };
  const p95 = values => [...values].sort((a, b) => a - b)[Math.floor(values.length * .95)];
  const sample = async (route, count = 100) => { const times = []; for (let index = 0; index < count; index++) { const start = performance.now(); await read(route); times.push(performance.now() - start); } return times; };
  await sample('/api/state', 20); const baseline = await sample('/api/state', 200);
  const started = performance.now(); const state = await read('/api/extensions/state'); const coldMs = performance.now() - started;
  const cached = await sample('/api/extensions/state', 60);
  const focusPlan = await read('/api/focus/prepare', { action: { type: 'focus.start', phase: 'work', taskId: 'task-1' } });
  await read('/api/focus/actions', { requestId: 'extension-benchmark-focus', expectedVersion: focusPlan.focusVersion, expectedTaskVersion: focusPlan.taskVersion, action: focusPlan.normalizedAction, expiresAt: focusPlan.expiresAt });
  const refresh = read('/api/extensions/refresh', {}), loaded = await sample('/api/state', 300); await refresh;
  const focus = await read('/api/focus/state');
  const report = { skills: state.skills.length, mcp: state.servers.length, coldMs, cachedP95Ms: p95(cached), taskBaselineP95Ms: p95(baseline), taskScanningP95Ms: p95(loaded), taskP95ChangePercent: (p95(loaded) / p95(baseline) - 1) * 100, focusVersion: focus.version, focusSessionRetained: focus.current?.taskId === 'task-1', measuredAt: new Date().toISOString(), scope: 'Node HTTP, synthetic sources, no MCP execution; native helper startup and browser interaction latency not timed' };
  const output = path.resolve(process.argv[2] || 'docs/verification/extensions/performance.json'); await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await server?.closeProxy(); if (server?.listening) await new Promise(resolve => server.close(resolve)); await fs.rm(temporary, { recursive: true, force: true }); }
