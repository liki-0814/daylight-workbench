import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute, capabilities } from '../core/contracts.js';

test('focus and calendar transports authenticate before dispatch, including unsupported methods', () => {
  for (const [name, method] of Object.entries({state:'GET',prepare:'POST',actions:'POST',statistics:'GET',sessions:'GET','task-summary':'GET',export:'GET'})) {
    assert.equal(resolveRoute('/api/v1/focus/'+name, method).auth, 'agent');
    assert.equal(resolveRoute('/api/v1/focus/'+name, method).handler, 'focus');
    assert.equal(resolveRoute('/api/focus/'+name, method).auth, method==='POST'?'webOrigin':'web');
    assert.equal(resolveRoute('/api/focus/'+name, method).handler, 'focus');
    assert.equal(resolveRoute('/api/v1/focus/'+name, method==='POST'?'GET':'POST').handler, 'missing');
  }
  assert.equal(resolveRoute('/api/v1/focus/missing','GET').auth,'agent');
  assert.equal(resolveRoute('/api/focus/missing','GET').auth,'web');
  assert.equal(resolveRoute('/api/calendar','GET').auth,'web');
  assert.equal(resolveRoute('/api/task-actions','POST').auth,'webOrigin');
  assert.equal(resolveRoute('/api/task-actions','POST').handler,'actions');
  assert.equal(resolveRoute('/api/task-actions','GET').handler,'missing');
  const recovery='/api/ai/conversations/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/focus-submission';
  assert.equal(resolveRoute(recovery,'POST').auth,'webOrigin');
  assert.equal(resolveRoute(recovery,'GET').handler,'missing');
  assert.equal(resolveRoute(recovery.replace('/api/ai/','/api/v1/ai/'),'POST').handler,'missing');
  assert.equal(capabilities().focus.taskStateMutation,false);
});
