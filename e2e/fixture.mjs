// fixture-v1: a disposable Daylight workbench with synthetic Skills / MCP servers / clients.
// Every root lives inside a fresh temp directory; the real home (~/.agents, ~/.codex, …) is never read or written.
//
//   Skills (15):  13 shared (review-code, pdf-reports, ui-copywriting, a long-name one, 8 plain ones,
//                 broken-skill with invalid frontmatter) + 2 client-local (Codex codex-local-notes, and the Qoder directory
//                 api-design that conflicts with the shared api-design). i18n-check is already linked into Qoder.
//   MCP (6):      fixture-mcp (probe succeeds), missing-env-mcp (credential ref not set), broken-cmd (command not found),
//                 slow-mcp (probe takes ~1 s), disabled-one (disabled), github-remote (http, unreachable).
//   Clients (3):  Codex, Qoder, Pi.
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_VERSION = 'fixture-v1';
export const FIXTURE_EXPECTED = Object.freeze({ skills: 15, mcpServers: 6, clients: 3 });
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_SECRET = 'e2e-secret-value-must-never-render';

export async function startFixture({ prefix = 'daylight-e2e-' } = {}) {
  const { createWorkbench } = await import(path.join(REPO, 'server.mjs'));
  const { fixtureState } = await import(path.join(REPO, 'test/fixtures.mjs'));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const agents = path.join(dir, 'agents'), roots = Object.fromEntries(['codex', 'qoder', 'pi'].map(id => [id, path.join(dir, id)]));
  const shared = path.join(agents, 'skills');
  const skill = async (base, name, description, body = '按步骤执行。', extra = '') => { const folder = path.join(base, name); await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${extra}---\n\n${body}\n`); };
  await fs.mkdir(path.join(agents, 'daylight'), { recursive: true });
  await fs.writeFile(path.join(agents, 'daylight/clients.json'), JSON.stringify({ schemaVersion: 1, clients: [], selectedClients: ['codex', 'qoder', 'pi'] }));
  await skill(shared, 'review-code', '审查代码改动，检查架构边界、真实测试和回归影响。', '检查来源，理解用途，再预览变更。');
  await skill(shared, 'pdf-reports', '读取 PDF 并生成结构化周报。', '先读 PDF，再整理要点。', 'metadata:\n  mcp-dependencies: [github-remote, missing-server]\n');
  await skill(shared, 'ui-copywriting', '为界面撰写简洁中文文案，统一按钮、空状态和错误提示的语气。', '保持克制。', 'metadata:\n  mcp-dependencies: []\n');
  await skill(shared, 'long-path-example-with-a-very-long-directory-name-for-wrapping', '用于验证较长的中文用途说明、软件接入状态与窄窗口显示，说明文字故意写得很长，看看列表是否会被截断或换行，以及右侧开关位置是否稳定。');
  for (const name of ['api-design', 'db-migration', 'release-notes', 'test-triage', 'security-audit', 'meeting-minutes', 'i18n-check', 'perf-profiling']) await skill(shared, name, `${name} 的示例 Skill，用于填充列表。`);
  await fs.mkdir(path.join(shared, 'broken-skill'), { recursive: true });
  await fs.writeFile(path.join(shared, 'broken-skill/SKILL.md'), '没有 frontmatter 的 Skill\n');
  await skill(path.join(roots.codex, 'skills'), 'codex-local-notes', 'Codex 本地专有 Skill。');
  await fs.mkdir(path.join(roots.qoder, 'skills/api-design'), { recursive: true });
  await fs.writeFile(path.join(roots.qoder, 'skills/api-design/SKILL.md'), '---\nname: api-design\ndescription: 同名实体目录（制造冲突）\n---\n');
  await fs.mkdir(path.join(roots.pi, 'agent/skills'), { recursive: true });
  await fs.symlink(path.relative(path.join(roots.qoder, 'skills'), path.join(shared, 'i18n-check')), path.join(roots.qoder, 'skills/i18n-check'));
  await fs.mkdir(path.join(agents, 'mcp'), { recursive: true });
  const script = path.join(REPO, 'fixtures/extensions/mcp-server.mjs');
  const servers = [
    { id: 'fixture-mcp', name: '本地 MCP 测试服务', transport: 'stdio', enabled: true, command: process.execPath, args: [script, path.join(dir, 'mcp-ok'), 'normal'], envRefs: {} },
    { id: 'missing-env-mcp', name: '缺少凭据的服务', transport: 'stdio', enabled: true, command: process.execPath, args: [script, path.join(dir, 'mcp-env'), 'normal'], envRefs: { E2E_MISSING_TOKEN: 'E2E_MISSING_TOKEN' } },
    { id: 'slow-mcp', name: '慢速 MCP（检测耗时演练）', transport: 'stdio', enabled: true, command: process.execPath, args: [script, path.join(dir, 'mcp-slow'), 'delayed'], envRefs: {} },
    { id: 'broken-cmd', name: '命令不存在的服务', transport: 'stdio', enabled: true, command: '/nonexistent/binary', args: [], envRefs: {} },
    { id: 'disabled-one', name: '已停用的服务', transport: 'stdio', enabled: false, command: process.execPath, args: ['-v'], envRefs: {} },
    { id: 'github-remote', name: 'GitHub（HTTP，不可达）', transport: 'http', enabled: true, url: 'http://127.0.0.1:9/mcp', headerRefs: { Authorization: 'E2E_GITHUB_AUTH' } },
  ];
  await fs.writeFile(path.join(agents, 'mcp/servers.json'), JSON.stringify({ schemaVersion: 1, servers }, null, 2));
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ version: 0, state: fixtureState() }));
  await fs.mkdir(path.join(dir, 'ai'), { recursive: true });
  // The Daylight process environment contains one credential-like variable so tests can prove its value never reaches the page.
  const environment = { PATH: '/usr/bin:/bin', E2E_GITHUB_AUTH: FIXTURE_SECRET };
  const server = await createWorkbench({
    dataDir: dir, appVersion: '0.0.0-e2e', releaseFetch: async () => new Response('{}', { status: 404 }),
    proxyOptions: { includeGateway: false, includeAgy: false, includeGrok: false },
    extensionsOptions: { agentsRoot: agents, clientRoots: roots, home: dir, environment },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const origin = new URL(url).origin;
  // Authenticated JSON call, the same way the web client does it (session token from /api/state + same-origin Origin).
  const api = async (route, body) => { const { token } = await (await fetch(url + '/api/state')).json(); const response = await fetch(url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Workbench-Token': token, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, text: await response.text() }; };
  return { url, dir, agents, roots, api, version: FIXTURE_VERSION, async close() { await server.closeProxy?.(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }); await fs.rm(dir, { recursive: true, force: true }); } };
}
