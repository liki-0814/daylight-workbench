import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createProbes } from '../extensions/mcp-probes.mjs';
import { createExtensionsService } from '../extensions/service.mjs';

const fixture = fileURLToPath(new URL('../fixtures/extensions/mcp-server.mjs', import.meta.url));
const wait = async (probes, id) => { for (let i = 0; i < 150; i++) { const value = probes.get(id); if (value.finishedAt) return value; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('probe did not clean up'); };
test('real stdio MCP handshake paginates tools without tool invocation and exits only its own child', async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'daylight-mcp-')); const log = path.join(dir, 'requests');
  const probes = createProbes({ environment: { PATH: '' }, timeoutMs: 2000 }); t.after(async () => { await probes.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const started = probes.start({ id: 'fixture', command: path.basename(process.execPath), args: [fixture, log], transport: 'stdio', envRefs: {} });
  const result = await wait(probes, started.id); assert.equal(result.status, 'succeeded', JSON.stringify(result)); assert.equal(result.toolCount, 2); assert.equal(result.serverVersion, '1.0.0');
  assert.equal(await fs.readFile(log, 'utf8'), 'tools/list\ntools/list\n');
  const pid = Number(await fs.readFile(log + '.pid', 'utf8')); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('timeout, cancellation, missing executable/environment and concurrency limits all close owned transports', async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'daylight-mcp-cancel-')), probes = createProbes({ environment: { PATH: process.env.PATH }, timeoutMs: 700 });
  t.after(async () => { await probes.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const server = id => ({ id, command: process.execPath, args: [fixture, path.join(dir, id), 'slow'], transport: 'stdio', envRefs: {} });
  const a = probes.start(server('first')), b = probes.start(server('second'));
  assert.throws(() => probes.start(server('third')), /最多/);
  const confirmed = probes.start(server('confirmed'), 'approved-probe-id', { confirmed: true });
  assert.equal(confirmed.status, 'failed'); assert.match(confirmed.message, /没有启动/);
  assert.deepEqual(probes.start(server('confirmed'), confirmed.id, { confirmed: true }), confirmed);
  await assert.rejects(fs.stat(path.join(dir, 'confirmed') + '.pid'), { code: 'ENOENT' });
  await new Promise(resolve => setTimeout(resolve, 250)); await probes.cancel(b.id);
  assert.equal((await wait(probes, b.id)).status, 'cancelled'); assert.equal((await wait(probes, a.id)).status, 'timed_out');
  for (const id of ['first', 'second']) { const pid = Number(await fs.readFile(path.join(dir, id) + '.pid', 'utf8')); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); }
  const missing = probes.start({ ...server('missing'), command: path.join(dir, 'not-installed') }); assert.equal((await wait(probes, missing.id)).status, 'failed');
  const noEnv = probes.start({ ...server('environment'), envRefs: { TOKEN: 'DOES_NOT_EXIST' } }); assert.match((await wait(probes, noEnv.id)).message, /DOES_NOT_EXIST/);
  const privateProbes = createProbes({ environment: { PATH: process.env.PATH, DAYLIGHT_AI_TOKEN: 'private-fixture-token', ALIAS: 'private-fixture-token' } }); t.after(() => privateProbes.close());
  const isolated = privateProbes.start({ ...server('private'), envRefs: { TOKEN: 'ALIAS' } }), refused = await wait(privateProbes, isolated.id);
  assert.equal(refused.status, 'failed'); assert.match(refused.message, /内部凭据/); assert.ok(!JSON.stringify(refused).includes('private-fixture-token'));
  await assert.rejects(fs.stat(path.join(dir, 'private') + '.pid'), { code: 'ENOENT' });
});
test('real Streamable HTTP MCP handshake lists tools; failed authorization contains no raw secret error', async t => {
  const opened = [], transports = []; let businessCalls = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/denied') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'credential-secret-must-not-appear' })); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const sdk = new Server({ name: 'http-fixture', version: '2.0.0' }, { capabilities: { tools: {} } }), transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    opened.push(sdk); transports.push(transport);
    sdk.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'http-tool', inputSchema: { type: 'object' } }] }));
    sdk.setRequestHandler(CallToolRequestSchema, async () => { businessCalls++; return { content: [] }; });
    await sdk.connect(transport); await transport.handleRequest(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const probes = createProbes({ timeoutMs: 1500 });
  t.after(async () => { await probes.close(); await Promise.all(opened.map(sdk => sdk.close())); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const started = probes.start({ id: 'http', name: 'HTTP', transport: 'http', url: url + '/mcp', headerRefs: {} }); const result = await wait(probes, started.id);
  assert.equal(result.status, 'succeeded', JSON.stringify(result)); assert.equal(result.toolCount, 1); assert.match(result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/); assert.equal(businessCalls, 0);
  const denied = probes.start({ id: 'denied', transport: 'http', url: url + '/denied', headerRefs: {} }); const failed = await wait(probes, denied.id); assert.equal(failed.status, 'failed'); assert.ok(!JSON.stringify(failed).includes('credential-secret'));
});
test('editing or archiving a MCP cancels only its obsolete diagnostic and marks old reports stale', async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'daylight-mcp-config-change-')));
  const service = await createExtensionsService({ agentsRoot: path.join(dir, 'agents'), clientRoots: Object.fromEntries(['codex', 'qoder', 'pi'].map(id => [id, path.join(dir, id)])), environment: { PATH: process.env.PATH }, probeTimeoutMs: 10000 });
  t.after(async () => { await service.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const apply = async action => { const plan = await service.prepare(action); return service.apply({ requestId: crypto.randomUUID(), expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction }); };
  const server = id => ({ id, name: id, transport: 'stdio', command: process.execPath, args: [fixture, path.join(dir, id), 'slow'], envRefs: {} });
  await apply({ type: 'mcp.save', server: server('changing') }); await apply({ type: 'mcp.save', server: server('unrelated') });
  const first = await apply({ type: 'mcp.probe', id: 'changing' }), other = await apply({ type: 'mcp.probe', id: 'unrelated' });
  assert.equal((await service.detail('changing')).lastProbe.stale, false);
  await apply({ type: 'mcp.save', server: { ...server('changing'), name: 'new config' } });
  assert.equal(service.probes.get(first.probeId).status, 'cancelled'); assert.ok(service.probes.get(first.probeId).finishedAt);
  assert.equal((await service.detail('changing')).lastProbe.stale, true); assert.equal(service.probes.get(other.probeId).status, 'running');
  const second = await apply({ type: 'mcp.probe', id: 'changing' }); await apply({ type: 'mcp.archive', id: 'changing' });
  assert.equal(service.probes.get(second.probeId).status, 'cancelled'); assert.equal(service.probes.get(other.probeId).status, 'running');
});
