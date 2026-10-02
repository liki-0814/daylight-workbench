import test from 'node:test';
import assert from 'node:assert/strict';
import { permissions } from '../ai/adapters/qoder.mjs';

test('Qoder native tools await a real decision and allow only this invocation', async () => {
  let resolve, shown;
  const decision = new Promise(r => { resolve = r; });
  const input = { command: 'python3 read_doc.py' };
  const check = permissions({ approve: details => { shown = details; return decision; } });
  let completed = false;
  const result = check('Bash', input).then(r => { completed = true; return r; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(JSON.parse(shown.details).tool, 'Bash');
  resolve(true);
  assert.deepEqual(await result, { behavior: 'allow', updatedInput: input, permissionScope: 'once' });
  const denied = await permissions({ approve: async () => false })('Edit', { file_path: '/test' });
  assert.equal(denied.behavior, 'deny');
  assert.equal(denied.updatedPermissions, undefined);
});

test('Qoder questions preserve the original input and use the human answer', async () => {
  const input = { questions: [{ question: '选择目标项目？', options: [{ label: '示例' }] }] };
  const result = await permissions({ ask: async () => '明确的项目', approve: () => { throw new Error('unexpected approval'); } })('AskUserQuestion', input);
  assert.deepEqual(result.updatedInput, { ...input, answers: { '选择目标项目？': '明确的项目' } });
});

test('full access bypasses native approval but retains user questions; standard restores approval', async () => {
  let approvals = 0, questions = 0;
  const options = { approve: async () => { approvals++; return false; }, ask: async () => { questions++; return '目标'; } };
  const full = permissions({ ...options, accessMode: 'full' });
  assert.equal((await full('Bash', { command: 'read' })).behavior, 'allow');
  await full('AskUserQuestion', { questions: [{ question: '目标？' }] });
  assert.equal(approvals, 0); assert.equal(questions, 1);
  assert.equal((await permissions({ ...options, accessMode: 'standard' })('Bash', { command: 'read' })).behavior, 'deny');
  assert.equal(approvals, 1);
});

test('Codex full and standard modes reset both thread and turn policies', async () => {
  const { accessPolicy } = await import('../ai/adapters/codex.mjs');
  assert.deepEqual(accessPolicy('full', '/workspace'), { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } });
  assert.deepEqual(accessPolicy('standard', '/workspace'), { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/workspace'], networkAccess: false } });
});
