import test from 'node:test';
import assert from 'node:assert/strict';
import { groupMcpServers } from '../public/extensions/mcp-groups.js';

const shared = (id = 'tools') => ({ id, kind: 'mcp', scope: 'shared', name: '共享工具', transport: 'stdio', command: 'node', args: ['server.mjs'], envRefs: {}, headerRefs: {}, enabled: true });
const local = (clientId, patch = {}) => ({ id: 'mcp_' + clientId, kind: 'mcp', scope: 'client', clientId, serverKey: 'tools', name: 'tools', transport: 'stdio', command: 'node', args: ['server.mjs'], envRefs: {}, headerRefs: {}, enabled: true, ...patch });
const clients = [
  { id: 'codex', selected: true, mcpMode: 'native' },
  { id: 'qoder', selected: true, mcpMode: 'native' },
  { id: 'claude', selected: true, mcpMode: 'native' },
  { id: 'pi', selected: true, mcpMode: 'unsupported' },
  { id: 'other', selected: false, mcpMode: 'native' },
];

test('shared and equivalent client configurations form one group with independent enabled states', () => {
  const groups = groupMcpServers([shared(), local('codex', { enabled: false }), local('qoder')], clients);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'tools');
  assert.equal(groups[0].shared.id, 'tools');
  assert.deepEqual(groups[0].installations.map(server => server.clientId), ['codex', 'qoder']);
  assert.deepEqual(groups[0].bindings.map(binding => [binding.clientId, binding.state]), [['codex', 'connected'], ['qoder', 'connected'], ['claude', 'not_connected']]);
});

test('local-only equivalent configurations also collapse without inventing a shared source', () => {
  const groups = groupMcpServers([local('codex'), local('qoder', { enabled: false })], clients);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].shared, null);
  assert.equal(groups[0].id, 'mcp_codex');
  assert.deepEqual(groups[0].bindings.map(binding => binding.clientId), ['codex', 'qoder']);
});

test('HTTP URL normalization and reference ordering do not prevent grouping', () => {
  const master = { ...shared('remote'), transport: 'http', command: undefined, args: undefined, url: 'https://example.test', envRefs: undefined, headerRefs: { Z: 'Z_REF', A: 'A_REF' } };
  const installation = { ...local('codex'), serverKey: 'remote', transport: 'http', command: undefined, args: undefined, url: 'https://example.test/', envRefs: undefined, headerRefs: { A: 'A_REF', Z: 'Z_REF' } };
  assert.equal(groupMcpServers([master, installation], clients).length, 1);
});

test('different connection configurations split and conflicting clients cannot install over them', () => {
  const groups = groupMcpServers([shared(), local('codex', { args: ['other.mjs'] }), local('qoder')], clients);
  assert.equal(groups.length, 2);
  const master = groups.find(group => group.shared);
  assert.deepEqual(master.installations.map(server => server.clientId), ['qoder']);
  assert.equal(master.bindings.find(binding => binding.clientId === 'codex').state, 'conflict');
  assert.equal(master.bindings.find(binding => binding.clientId === 'codex').conflictServer.args[0], 'other.mjs');
  assert.equal(master.bindings.find(binding => binding.clientId === 'claude').state, 'not_connected');
  assert.equal(groups.find(group => !group.shared).installations[0].clientId, 'codex');
});

test('invalid configurations remain distinct and still protect the shared key', () => {
  const groups = groupMcpServers([shared(), local('codex', { valid: false }), local('qoder', { valid: false })], clients);
  assert.equal(groups.length, 3);
  assert.equal(groups.find(group => group.shared).bindings.find(binding => binding.clientId === 'codex').state, 'conflict');
  assert.equal(groups.find(group => group.shared).bindings.find(binding => binding.clientId === 'qoder').state, 'conflict');
});
