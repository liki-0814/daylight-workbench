// Installed CLI discovery against disposable HOME/config roots, without inference.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { query, qodercliAuth } from '@qoder-ai/qoder-agent-sdk';
import { createExtensionsService } from '../extensions/service.mjs';

const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'daylight-extension-clients-')));
const home = path.join(temporary, 'home'), cwd = path.join(temporary, 'project');
await fs.mkdir(home); await fs.mkdir(cwd);
const environment = { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'), QODER_CONFIG_DIR: path.join(home, '.qoder'), QODER_CLI_HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'DAYLIGHT_AI_TOKEN', 'DAYLIGHT_QODER_TOKEN', 'DAYLIGHT_TOOL_TOKEN']) delete environment[key];
const agentsRoot = path.join(home, '.agents'), clientRoots = { codex: environment.CODEX_HOME, qoder: path.join(home, '.qoder'), pi: environment.PI_CODING_AGENT_DIR };
const binaries = {
  codex: process.env.DAYLIGHT_CODEX_EXECUTABLE || path.join(os.homedir(), '.npm-global/bin/codex'),
  qoder: process.env.DAYLIGHT_QODER_EXECUTABLE || path.join(os.homedir(), '.local/bin/qodercli'),
  pi: process.env.DAYLIGHT_PI_EXECUTABLE || path.join(os.homedir(), '.npm-global/bin/pi'),
};
const name = 'daylight-discovery-fixture', results = [];
const version = async binary => (await promisify(execFile)(binary, ['--version'], { env: environment, cwd, timeout: 10000 })).stdout.trim().split('\n')[0];
function rpc(binary, args) {
  const child = spawn(binary, args, { env: environment, cwd, stdio: ['pipe', 'pipe', 'ignore'] });
  let id = 0, buffer = ''; const requests = new Map();
  child.stdout.setEncoding('utf8');
  child.stdin.on('error', () => {});
  const rejectAll = failure => { for (const request of requests.values()) { clearTimeout(request.timer); request.reject(failure); } requests.clear(); };
  child.on('error', rejectAll); child.on('exit', () => rejectAll(new Error('CLI exited before discovery completed')));
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let result; try { result = JSON.parse(line); } catch { continue; }
      const request = requests.get(result.id); if (!request) continue;
      requests.delete(result.id); clearTimeout(request.timer);
      result.error || result.success === false ? request.reject(new Error('CLI rejected the discovery request')) : request.resolve(result.result || result.data);
    }
  });
  return {
    send: value => child.stdin.write(JSON.stringify(value) + '\n'),
    call(value) { const key = String(++id); return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(key); reject(new Error('Discovery timed out')); }, 20000);
      requests.set(key, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id: key, ...value }) + '\n');
    }); },
    async close() {
      if (child.exitCode !== null || child.signalCode) return;
      const exited = new Promise(resolve => child.once('exit', resolve)); child.stdin.end(); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000); await exited; clearTimeout(timer);
    },
  };
}
const service = await createExtensionsService({ agentsRoot, clientRoots, environment });
async function apply(action) { const plan = await service.prepare(action); return service.apply({ requestId: crypto.randomUUID(), expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction }); }
try {
  await apply({ type: 'skill.create', directory: name, content: `---\nname: ${name}\ndescription: Isolated installed-client discovery verification\n---\nThis fixture never runs a model or a business tool.\n` });
  const skill = (await service.state(true)).skills[0];
  for (const client of ['codex', 'pi']) {
    await apply({ type: 'binding.connect', id: skill.id, clientId: client });
    await assert.rejects(fs.stat(path.join(clientRoots[client], 'skills', name)), { code: 'ENOENT' });
  }
  await apply({ type: 'binding.connect', id: skill.id, clientId: 'qoder' });
  // Some CLIs require an existing custom config directory before starting.
  // These empty roots belong to the test harness, not the binding operation.
  for (const root of Object.values(clientRoots)) await fs.mkdir(root, { recursive: true });
  for (const client of ['codex', 'pi', 'qoder']) {
    let connection, installedVersion, phase = 'version', discoverySummary, authenticationRequired = false;
    try {
      installedVersion = await version(binaries[client]); phase = 'startup'; let discovered;
      if (client === 'codex') {
        connection = rpc(binaries.codex, ['app-server']);
        await connection.call({ method: 'initialize', params: { clientInfo: { name: 'daylight-extension-verification', version: '1' }, capabilities: { experimentalApi: true } } }); connection.send({ method: 'initialized' });
        const result = await connection.call({ method: 'skills/list', params: { cwds: [cwd], forceReload: true } });
        const skills = (result.data || []).flatMap(item => item.skills || []); discoverySummary = { total: skills.length, fixture: skills.filter(item => item.name === name).map(({ name, path }) => ({ name, path })) };
        discovered = skills.some(item => item.name === name && item.path === path.join(agentsRoot, 'skills', name, 'SKILL.md'));
      } else if (client === 'pi') {
        connection = rpc(binaries.pi, ['--mode', 'rpc', '--no-session', '--no-extensions']);
        const result = await connection.call({ type: 'get_commands' }); discovered = result.commands.some(item => item.source === 'skill' && item.name === 'skill:' + name && item.sourceInfo.path === path.join(agentsRoot, 'skills', name, 'SKILL.md'));
      } else {
        let release; const gate = new Promise(resolve => release = resolve);
        async function* empty() { await gate; }
        const q = query({ prompt: empty(), options: { pathToQoderCLIExecutable: binaries.qoder, auth: qodercliAuth(), cwd, env: environment, settingSources: ['user'], persistSession: false, stderr: data => { if (/login|auth|credential|access.token/i.test(data)) authenticationRequired = true; } } });
        connection = { async close() { release(); q.close(); } };
        const init = await Promise.race([q.initializationResult(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Discovery timed out')), 20000); timer.unref(); })]);
        discoverySummary = { total: (init.skills || []).length, fixture: (init.skills || []).filter(item => item.name === name).map(({ name }) => ({ name })) };
        discovered = (init.skills || []).some(item => item.name === name);
      }
      phase = 'discovery';
      assert.equal(discovered, true, 'The isolated source was not discovered');
      results.push({ client, version: installedVersion, status: 'passed', mechanism: client === 'qoder' ? 'individual Skill symlink' : 'native ~/.agents/skills; no added link' });
    } catch (failure) {
      const location = failure.stack?.match(/verify-extension-clients\.mjs:\d+:\d+/)?.[0];
      let reason = failure.code === 'ENOENT' ? 'executable missing' : ['Discovery timed out', 'CLI rejected the discovery request', 'CLI exited before discovery completed'].includes(failure.message) ? failure.message : /login|auth|credential|access.token/i.test(failure.message) ? 'isolated client requires authentication' : 'isolated client discovery failed';
      if (authenticationRequired) reason = 'isolated client requires authentication';
      if (reason === 'isolated client discovery failed') {
        let message = failure.message;
        for (const [key, value] of Object.entries(environment)) if (/token|key|secret|password/i.test(key) && value) message = message.split(value).join('[redacted]');
        reason = message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 300);
      }
      results.push({ client, version: installedVersion, status: 'not_verified', phase, discoverySummary, errorType: failure.name, location, reason });
    }
    finally { await connection?.close(); }
  }
  const output = path.resolve(process.argv[2] || 'docs/verification/extensions/clients.json');
  const report = { results, testedAt: new Date().toISOString(), scope: 'Installed CLI discovery; isolated HOME/config/project; no inference, no real source/config writes; MCP client discovery not tested' };
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  if (results.some(result => result.status !== 'passed')) process.exitCode = 1;
} finally { await service.close(); await fs.rm(temporary, { recursive: true, force: true }); }
