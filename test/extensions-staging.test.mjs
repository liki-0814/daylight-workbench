import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stageKey, stageChange, stagedValue, stagedKindFor, pruneStaged, actionFor, describeChange, tildePath, rememberedLabel, hasMasterSwitch, batchTitle, barLabel, partialSummary, appliedMessage, undoable, undoActions, clientNames } from '../public/extensions/staging.js';

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
  assert.equal(appliedMessage({ type: 'mcp.save' }), '变更已应用');
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
