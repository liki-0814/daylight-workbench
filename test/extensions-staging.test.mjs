import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stageKey, stageChange, stagedValue, stagedKindFor, pruneStaged, actionFor, describeChange, tildePath, tildeText, rememberedLabel, hasMasterSwitch, batchTitle, barLabel, partialSummary, appliedMessage, undoable, undoActions, clientNames } from '../public/extensions/staging.js';

const state = {
  root: '/Users/li/.agents',
  clients: [{ id: 'codex', name: 'Codex' }, { id: 'pi', name: 'Pi' }],
  skills: [
    { id: 'a', name: 'review-code', scope: 'shared', readOnly: false, enabled: true, rememberedClientIds: [], bindings: [{ clientId: 'codex', state: 'managed' }, { clientId: 'pi', state: 'not_connected' }] },
    { id: 'b', name: 'old-skill', scope: 'shared', readOnly: false, enabled: false, rememberedClientIds: ['codex', 'ghost'], bindings: [{ clientId: 'codex', state: 'not_connected' }] },
    { id: 'c', name: 'local', scope: 'client', readOnly: false, enabled: true, rememberedClientIds: [], bindings: [] },
    { id: 'd', name: 'ro', scope: 'shared', readOnly: true, enabled: true, rememberedClientIds: [], bindings: [] },
    { id: 'e', name: 'legacy', scope: 'shared', readOnly: false, bindings: [{ clientId: 'codex', state: 'existing' }] },
  ],
};
const bind = (id, clientId, want) => ({ kind: 'binding', id, clientId, want });

test('only shared, writable skills with an enabled flag get a master switch', () => {
  assert.deepEqual(state.skills.map(hasMasterSwitch), [true, true, false, false, false]);
  assert.equal(hasMasterSwitch(undefined), false);
});

test('staging stores the wanted value and a second click back to the actual value removes it', () => {
  let staged = stageChange(new Map(), bind('a', 'pi', true), state);
  assert.equal(staged.size, 1); assert.equal(stagedValue(staged, bind('a', 'pi'), false), true);
  const original = staged;
  staged = stageChange(staged, bind('a', 'pi', false), state);
  assert.equal(staged.size, 0); assert.equal(original.size, 1, 'inputs are not mutated');
  assert.equal(stageChange(new Map(), bind('a', 'codex', true), state).size, 0, 'wanting what is already true stages nothing');
  assert.equal(stageChange(new Map(), bind('zzz', 'pi', true), state).size, 0, 'unknown skill stages nothing');
  assert.equal(stageChange(new Map(), { kind: 'skill', id: 'c', want: false }, state).size, 0, 'client-scope rows cannot be staged for the master switch');
});

test('a skill holds either a master change or binding changes, never both', () => {
  let staged = stageChange(new Map(), bind('a', 'pi', true), state);
  assert.equal(stagedKindFor(staged, 'a'), 'binding');
  assert.equal(stagedKindFor(staged, 'b'), null);
  staged = stageChange(new Map(), { kind: 'skill', id: 'a', want: false }, state);
  assert.equal(stagedKindFor(staged, 'a'), 'skill');
});

test('prune drops changes that already match, vanished objects, connects on a disabled skill, and conflict targets', () => {
  const staged = new Map([
    [stageKey(bind('a', 'pi', true)), bind('a', 'pi', true)],          // still a real change
    [stageKey(bind('a', 'codex', true)), bind('a', 'codex', true)],    // already connected
    [stageKey(bind('gone', 'pi', true)), bind('gone', 'pi', true)],    // skill vanished
    [stageKey(bind('b', 'codex', true)), bind('b', 'codex', true)],    // skill is disabled now
    [stageKey({ kind: 'skill', id: 'b', want: true }), { kind: 'skill', id: 'b', want: true }],
  ]);
  const { staged: next, dropped } = pruneStaged(staged, state);
  assert.deepEqual([...next.keys()], ['binding:a:pi', 'skill:b']); assert.equal(dropped, 3);
  const conflict = { ...state, skills: [{ ...state.skills[0], bindings: [{ clientId: 'pi', state: 'conflict' }] }] };
  assert.equal(pruneStaged(new Map([['binding:a:pi', bind('a', 'pi', true)]]), conflict).staged.size, 0);
  const same = new Map([['binding:a:pi', bind('a', 'pi', true)]]);
  assert.equal(pruneStaged(same, state).staged, same, 'nothing dropped: same Map back (no churn)');
});

test('actions follow the contract: master → skill.enable/disable; binding → connect/disconnect, includeExisting only for an existing link', () => {
  assert.deepEqual(actionFor({ kind: 'skill', id: 'a', want: false }, state), { type: 'skill.disable', id: 'a' });
  assert.deepEqual(actionFor({ kind: 'skill', id: 'b', want: true }, state), { type: 'skill.enable', id: 'b' }, 'no clientIds: restore everything that was remembered');
  assert.deepEqual(actionFor(bind('a', 'pi', true), state), { type: 'binding.connect', id: 'a', clientId: 'pi' });
  assert.deepEqual(actionFor(bind('a', 'codex', false), state), { type: 'binding.disconnect', id: 'a', clientId: 'codex' });
  assert.deepEqual(actionFor(bind('e', 'codex', false), state), { type: 'binding.disconnect', id: 'e', clientId: 'codex', includeExisting: true });
});

test('human wording: verbs, arrows, remembered clients fall back to the id', () => {
  assert.deepEqual(describeChange(bind('a', 'pi', true), state), { tag: '接入', label: 'review-code → Pi' });
  assert.deepEqual(describeChange(bind('a', 'codex', false), state), { tag: '取消接入', label: 'review-code → Codex' });
  assert.deepEqual(describeChange({ kind: 'skill', id: 'a', want: false }, state), { tag: '停用', label: 'review-code' });
  assert.deepEqual(describeChange({ kind: 'skill', id: 'b', want: true }, state), { tag: '启用', label: 'old-skill' });
  assert.equal(rememberedLabel(state.skills[1], state), '停用前接入：Codex、ghost');
  assert.equal(rememberedLabel(state.skills[0], state), '');
  assert.deepEqual(clientNames(state, ['pi', 'nope']), ['Pi', 'nope']);
});

test('paths are abbreviated with ~ (home from the source root, else /Users|/home), other paths untouched', () => {
  assert.equal(tildePath('/Users/li/.codex/skills/review-code', '/Users/li/.agents'), '~/.codex/skills/review-code');
  assert.equal(tildePath('/Users/li', '/Users/li/.agents'), '~');
  assert.equal(tildePath('/Users/lily/x', '/Users/li/.agents'), '/Users/lily/x', 'prefix of another user name is not home');
  assert.equal(tildePath('/home/ann/.pi/skills/x', ''), '~/.pi/skills/x');
  assert.equal(tildePath('/opt/tool/x', '/Users/li/.agents'), '/opt/tool/x');
  assert.equal(tildePath('', ''), '');
});

test('titles, bar label, partial success and receipt wording', () => {
  assert.equal(batchTitle(2), '应用 2 项变更'); assert.equal(barLabel(3), '3 项待应用的变更');
  assert.equal(partialSummary({ done: 2, failed: 1 }), '已应用 2 项，1 项未完成');
  assert.equal(partialSummary({ done: 1, failed: 1, skipped: 2 }), '已应用 1 项，3 项未完成');
  assert.equal(partialSummary({ done: 3, failed: 0 }), '已应用 3 项变更');
  assert.equal(appliedMessage({ type: 'skill.archive' }, 'review-code'), '已归档「review-code」');
  assert.equal(appliedMessage({ type: 'operation.restore' }), '已撤销上一步变更');
  assert.equal(appliedMessage({ type: 'mcp.install' }), '变更已应用');
});

test('undo: only for receipts that are not probes and not undo themselves; batches restore in reverse', () => {
  assert.equal(undoable({ type: 'skill.archive' }, { operationId: 'op1' }), true);
  assert.equal(undoable({ type: 'skill.archive' }, {}), false);
  assert.equal(undoable({ type: 'mcp.probe' }, { operationId: 'op1' }), false);
  assert.equal(undoable({ type: 'operation.restore' }, { operationId: 'op1' }), false);
  assert.deepEqual(undoActions(['1', '2', '3']), [{ type: 'operation.restore', operationId: '3' }, { type: 'operation.restore', operationId: '2' }, { type: 'operation.restore', operationId: '1' }]);
});

test('the module is a registered web asset and has no DOM access', () => {
  const source = readFileSync(new URL('../public/extensions/staging.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gm, ''), /document\.|window\.|localStorage/);
  assert.equal(JSON.parse(readFileSync(new URL('../core/web-assets.json', import.meta.url), 'utf8'))['/extensions/staging.js'], 'extensions/staging.js');
});

test('tildeText shortens the home directory in prose, using the shared root to find it', () => {
  const root = '/Users/li/.agents';
  assert.equal(tildeText('写入 /Users/li/.agents/skills/a 与 /Users/li/.codex/skills/a', root), '写入 ~/.agents/skills/a 与 ~/.codex/skills/a');
  assert.equal(tildeText('/opt/x/y', root), '/opt/x/y');
  assert.equal(tildeText('/Users/li/a', ''), '/Users/li/a', 'no root: do not guess');
  assert.equal(tildeText(undefined, root), '');
});

test('appliedMessage covers probe and save receipts', () => {
  assert.equal(appliedMessage({ type: 'mcp.probe' }), '已开始检测连接');
  assert.equal(appliedMessage({ type: 'skill.create' }, 'a'), '已保存「a」');
});
test('page.js reads pruneStaged as { staged, dropped } (not as a Map) — a Map-style read once replaced the staged Map with that object (staged.has is not a function, caught by e2e ext-pr6-01)', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../public/extensions/page.js', import.meta.url), 'utf8');
  assert.match(source, /const \{ staged: kept \} = pruneStaged\(staged, state\)/);
  assert.doesNotMatch(source, /const kept = pruneStaged\(/);
});
test('multi-step undo is chained: only the first restore is previewed up front (later ones depend on it and report a false conflict if prepared early); page.js passes chained for undo and skips the equality check where no preview exists', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../public/extensions/page.js', import.meta.url), 'utf8');
  assert.match(source, /chained \? entries\.slice\(0, 1\) : entries/);
  assert.match(source, /confirmLabel: '撤销变更', chained: true/);
  assert.match(source, /plans\[index\] && JSON\.stringify\(plan\.normalizedAction\)/);
});

// ---- 0.7 PR-7：共享 MCP 行开关也走暂存 ----
const mcpState = { ...state, servers: [
  { id: 'gh', name: 'GitHub', scope: 'shared', enabled: true },
  { id: 'off', name: 'Old', scope: 'shared', enabled: false },
  { id: 'loc', name: 'Local', scope: 'client', enabled: true },
  { id: 'a', name: 'same-id-as-skill', scope: 'shared', enabled: true },
] };
const mcp = (id, want) => ({ kind: 'mcp', id, want });
test('mcp switch: stage, toggle back removes, same value as actual is never staged', () => {
  let staged = stageChange(new Map(), mcp('gh', false), mcpState);
  assert.deepEqual([...staged.keys()], ['mcp:gh']); assert.equal(stagedValue(staged, mcp('gh'), true), false);
  assert.equal(stageChange(staged, mcp('gh', true), mcpState).size, 0);
  assert.equal(stageChange(new Map(), mcp('gh', true), mcpState).size, 0);
  assert.equal(stageChange(new Map(), mcp('loc', false), mcpState).size, 0, '客户端本地服务没有行开关');
  assert.equal(stageChange(new Map(), mcp('ghost', false), mcpState).size, 0);
});
test('mcp switch: action, description and toast', () => {
  assert.deepEqual(actionFor(mcp('gh', false), mcpState), { type: 'mcp.toggle', id: 'gh', enabled: false });
  assert.deepEqual(actionFor(mcp('off', true), mcpState), { type: 'mcp.toggle', id: 'off', enabled: true });
  assert.deepEqual(describeChange(mcp('gh', false), mcpState), { tag: '停用', label: 'GitHub' });
  assert.deepEqual(describeChange(mcp('off', true), mcpState), { tag: '启用', label: 'Old' });
  assert.deepEqual(describeChange(mcp('zzz', true), mcpState), { tag: '启用', label: 'zzz' });
  assert.equal(appliedMessage({ type: 'mcp.toggle', enabled: true }, 'GitHub'), '已启用「GitHub」');
  assert.equal(appliedMessage({ type: 'mcp.toggle', enabled: false }, 'GitHub'), '已停用「GitHub」');
  assert.equal(undoable({ type: 'mcp.toggle' }, { operationId: 'op' }), true);
});
test('mcp switch: pruning removes applied / vanished / no-longer-switchable entries; an mcp id equal to a skill id does not interfere with skill staging', () => {
  const staged = new Map([['mcp:gh', mcp('gh', false)], ['mcp:off', mcp('off', false)], ['mcp:ghost', mcp('ghost', false)], ['mcp:loc', mcp('loc', false)]]);
  const { staged: next, dropped } = pruneStaged(staged, mcpState);
  assert.deepEqual([...next.keys()], ['mcp:gh']); assert.equal(dropped, 3);
  const mixed = new Map([['mcp:a', mcp('a', false)]]);
  assert.equal(stagedKindFor(mixed, 'a'), null, 'MCP 暂存不占用同名 Skill');
  assert.equal(stageKey({ kind: 'skill', id: 'a' }) !== stageKey(mcp('a')), true);
});
