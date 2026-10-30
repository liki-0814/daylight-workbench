import assert from 'node:assert/strict';
import test from 'node:test';

const validation = await import('../public/extensions/controller.js');
const { normalizeServer } = await import('../extensions/mcp-server.mjs');

test('Skill directory rules match the server rule and reject what the old pattern could not', () => {
  for (const ok of ['review-code', 'a', '0day', 'a'.repeat(64)]) assert.equal(validation.skillDirectoryError(ok), '', ok);
  for (const bad of ['', 'Bad Name', '-lead', 'UPPER', 'under_score', 'a'.repeat(65), 'a b', 'ä']) assert.notEqual(validation.skillDirectoryError(bad), '', bad);
  // The HTML pattern attribute must compile in Chromium's `v` mode (unescaped "-" in a class does not).
  assert.doesNotThrow(() => new RegExp('^(?:[a-z0-9][a-z0-9\\-]{0,63})$', 'v'));
});

test('MCP id rules agree with normalizeServer on the same inputs', () => {
  const server = id => normalizeServer({ id, name: 'n', transport: 'stdio', command: 'node' });
  for (const id of ['ok', 'a_b-c', 'x'.repeat(80), 'bad id', 'x'.repeat(81), 'skill_x', 'client_x', 'codex', 'pi', 'qoder', '', 'é']) {
    let serverRejects = false; try { server(id); } catch { serverRejects = true; }
    assert.equal(validation.mcpIdError(id) !== '', serverRejects, `id ${JSON.stringify(id)}`);
  }
  assert.equal(validation.mcpIdError('has space', { native: true }), '');
  assert.notEqual(validation.mcpIdError('line\nbreak', { native: true }), '');
});

test('MCP URL and refs rules agree with the server', () => {
  const server = (url, headerRefs = {}) => normalizeServer({ id: 'x', name: 'n', transport: 'http', url, headerRefs });
  for (const url of ['https://a.test/mcp', 'http://localhost:3000', 'ftp://a.test', 'not a url', 'https://u:p@a.test', 'https://a.test/?token=1', 'https://a.test/#x', '']) {
    let rejects = false; try { server(url); } catch { rejects = true; }
    assert.equal(validation.mcpUrlError(url) !== '', rejects, url);
  }
  for (const text of ['A=B', 'Authorization=MCP_AUTH', 'x-key=Y', 'noequals', '=B', 'A=B-C', '1A=B', 'A=1B', 'A=sk-live-123']) {
    const refs = Object.fromEntries(text.split('\n').filter(Boolean).map(line => { const at = line.indexOf('='); return [line.slice(0, at).trim(), line.slice(at + 1).trim()]; }));
    let rejects = text.indexOf('=') < 1; if (!rejects) try { server('https://a.test', refs); } catch { rejects = true; }
    assert.equal(validation.refsError(text) !== '', rejects, text);
  }
});

test('plain http:// warns unless the host is loopback; https and bad URLs stay silent', () => {
  assert.match(validation.insecureHttpWarning('http://api.example.com/mcp'), /明文 http/);
  assert.match(validation.insecureHttpWarning('http://api.example.com/mcp', { hasHeaders: true }), /请求头/);
  for (const url of ['http://localhost:8080', 'http://127.0.0.1/x', 'http://[::1]/x', 'http://dev.localhost/x', 'https://api.example.com', 'nope', '', undefined]) assert.equal(validation.insecureHttpWarning(url), '', String(url));
  // Same wording as the server's serverWarnings so both layers read the same.
  assert.equal(validation.insecureHttpWarning('http://a.test', { hasHeaders: true }), '该地址使用明文 http://，所引用的请求头（可能含凭据）会未加密传输；建议改用 https://。');
});

test('duplicate lookup is scoped to the save location and ignores edits of the same server', () => {
  const servers = [{ id: 'fixture-mcp', scope: 'shared', name: '夹具' }, { id: 'mcp_abc', scope: 'client', clientId: 'codex', serverKey: 'fixture-mcp', name: 'fixture-mcp' }];
  assert.equal(validation.findDuplicateServer(servers, { id: 'fixture-mcp' }).id, 'fixture-mcp');
  assert.equal(validation.findDuplicateServer(servers, { id: 'fixture-mcp', clientId: 'codex' }).id, 'mcp_abc');
  assert.equal(validation.findDuplicateServer(servers, { id: 'fixture-mcp', clientId: 'qoder' }), null);
  assert.equal(validation.findDuplicateServer(servers, { id: 'fresh' }), null);
  const errors = validation.validateExtensionForm({ kind: 'mcp', creating: true, values: { id: 'fixture-mcp', name: 'x', transport: 'stdio', command: 'node' }, servers });
  assert.deepEqual(errors.map(entry => entry.name), ['id']);
  assert.ok(errors[0].duplicate);
  assert.deepEqual(validation.validateExtensionForm({ kind: 'mcp', creating: false, values: { id: 'fixture-mcp', name: 'x', transport: 'stdio', command: 'node' }, servers }), []);
});

test('whole-form validation reports every empty or invalid field in form order', () => {
  const names = input => validation.validateExtensionForm(input).map(entry => entry.name);
  assert.deepEqual(names({ kind: 'mcp', creating: true, values: { transport: 'stdio' } }), ['id', 'name', 'command']);
  assert.deepEqual(names({ kind: 'mcp', creating: true, values: { id: 'a', name: 'n', transport: 'http', url: 'ftp://x', headerRefs: 'bad' } }), ['url', 'headerRefs']);
  assert.deepEqual(names({ kind: 'mcp', creating: true, values: { id: 'a', name: 'n', transport: 'stdio', command: 'node', cwd: 'relative', envRefs: 'K=' } }), ['cwd', 'envRefs']);
  assert.deepEqual(names({ kind: 'skill-create', values: { directory: 'Bad Name', description: ' ' } }), ['directory', 'description']);
  assert.deepEqual(names({ kind: 'skill-create', values: { directory: 'good', description: 'd' } }), []);
  assert.deepEqual(names({ kind: 'skill-edit', values: { content: '' } }), ['content']);
  assert.deepEqual(names({ kind: 'client', values: { name: 'n', command: 'c' } }), ['root', 'skillsDirectory']);
});

test('server field names map onto form controls', () => {
  assert.equal(validation.fieldInputName('server.id'), 'id');
  assert.equal(validation.fieldInputName('server.url'), 'url');
  assert.equal(validation.fieldInputName('directory'), 'directory');
  assert.equal(validation.fieldInputName('content'), 'description');
  assert.equal(validation.fieldInputName(undefined), null);
});

test('diagnostics are filtered by tab, using the server tag when present and the code otherwise', () => {
  const diagnostics = [{ code: 'MCP_FORMAT' }, { code: 'ENV_MISSING', id: 'm' }, { code: 'SKILL_FORMAT', id: 's' }, { code: 'CLIENTS_FORMAT' }, { code: 'EXTERNAL_SOURCE' }, { code: 'CLIENT_MCP_FORMAT' }, { code: 'X', tab: 'clients' }];
  assert.deepEqual(validation.diagnosticsForTab(diagnostics, 'mcp').map(item => item.code), ['MCP_FORMAT', 'ENV_MISSING', 'CLIENT_MCP_FORMAT']);
  assert.deepEqual(validation.diagnosticsForTab(diagnostics, 'skills').map(item => item.code), ['SKILL_FORMAT', 'EXTERNAL_SOURCE']);
  assert.deepEqual(validation.diagnosticsForTab(diagnostics, 'clients').map(item => item.code), ['CLIENTS_FORMAT', 'X']);
  assert.deepEqual(validation.diagnosticsForTab(undefined, 'mcp'), []);
});

test('corrupt MCP config banner data reads position when the server provides it', () => {
  assert.equal(validation.corruptMcpConfig({ mcpValid: true, diagnostics: [] }), null);
  assert.equal(validation.corruptMcpConfig(null), null);
  const old = validation.corruptMcpConfig({ mcpValid: false, diagnostics: [{ code: 'MCP_FORMAT', message: 'm' }] });
  assert.deepEqual([old.where, old.reason], ['', '']);
  const next = validation.corruptMcpConfig({ mcpValid: false, diagnostics: [{ code: 'MCP_FORMAT', path: '/x/servers.json', line: 3, column: 7, reason: 'JSON 语法错误' }] });
  assert.equal(next.where, '/x/servers.json，第 3 行 第 7 列');
  assert.equal(next.reason, 'JSON 语法错误');
});

test('detail failures name the right object type and never claim a Skill for an MCP page', () => {
  const missing = Object.assign(new Error('x'), { status: 404, code: 'EXTENSIONS_OBJECT_MISSING' });
  assert.match(validation.detailErrorMessage(missing, { tab: 'mcp' }), /MCP 服务/);
  assert.doesNotMatch(validation.detailErrorMessage(missing, { tab: 'mcp' }), /Skill/);
  assert.match(validation.detailErrorMessage(missing, { tab: 'mcp', mcpValid: false }), /无法读取/);
  assert.match(validation.detailErrorMessage(missing, { tab: 'skills' }), /Skill/);
  assert.match(validation.detailErrorMessage(missing, { tab: 'clients' }), /软件/);
  assert.match(validation.detailErrorMessage(Object.assign(missing, { kind: 'mcp' }), { tab: 'skills' }), /MCP/);
  assert.match(validation.detailErrorMessage(new Error('boom'), { tab: 'mcp' }), /无法读取 MCP 服务详情：boom/);
  assert.match(validation.detailErrorMessage(missing, { operation: true }), /回执/);
});
