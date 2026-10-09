import test from 'node:test';
import assert from 'node:assert/strict';
import { focusDraftCard, focusSubmissionCard } from '../public/focus/draft-card.js';
import { initialFocusRecord, applyFocusAction } from '../core/focus-model.js';
import { prepareFocusAction } from '../core/focus-write.js';
import { fixtureState } from './fixtures.mjs';

test('focus review escapes titles and keeps approved payload read-only', () => {
  const workspace={tasks:[{id:'t',title:'<script>unsafe</script>'}]};
  const draft=focusDraftCard({summary:'<img onerror=x>',action:{type:'focus.start',phase:'work',taskId:'t',durationSeconds:1500},impact:{}},workspace);
  assert.match(draft,/&lt;script&gt;/);assert.doesNotMatch(draft,/<script>|<input|<textarea/);
  assert.match(draft,/不能用任务撤销恢复/);
  const unknown=focusSubmissionCard({id:'d',status:'unknown',summary:'start',request:{action:{type:'focus.start',phase:'work',taskId:'t'}}},workspace);
  assert.match(unknown,/data-focus-submission="retry"/);assert.doesNotMatch(unknown,/data-apply|data-reject|<input/);
});

test('rejected recovery shows structured error and latest state before manual acknowledgement', () => {
  const html=focusSubmissionCard({id:'d',status:'needs_review',summary:'pause',request:{action:{type:'focus.pause',sessionId:'s'}},error:{error:'版本已变化',code:'FOCUS_VERSION_CHANGED'},latestState:{version:9,current:{taskTitleSnapshot:'task',status:'paused',phase:'work'}}});
  assert.match(html,/版本已变化/);assert.match(html,/专注版本 9/);assert.match(html,/task · 已暂停/);
  assert.match(html,/已人工核对/);assert.doesNotMatch(html,/data-focus-submission="retry"/);
});

test('pause, resume and finish review use trusted session snapshots and running time', () => {
  const now=Date.parse('2026-10-07T10:00:00Z'), taskState=fixtureState();
  taskState.tasks[0].title='<旧任务标题>';
  const context={now,taskState,taskVersion:3,sessionId:'review-session'};
  const started=applyFocusAction(initialFocusRecord({timeZone:'UTC'}),{type:'focus.start',phase:'work',taskId:'task-1'},context).nextRecord;
  taskState.tasks[0].title='后来修改的标题';
  const paused=applyFocusAction(started,{type:'focus.pause',sessionId:'review-session'},{...context,now:now+300000}).nextRecord;
  for(const [type,record,at] of [['focus.pause',started,now+300000],['focus.resume',paused,now+3600000],['focus.finish',paused,now+3600000]]) {
    const prepared=prepareFocusAction(record,{action:{type,sessionId:'review-session'}},{...context,now:at});
    assert.equal(prepared.impact.current.taskTitleSnapshot,'<旧任务标题>');
    assert.equal(prepared.impact.current.targetMs,1500000);
    assert.equal(prepared.impact.current.remainingMs,1200000);
    assert.equal(prepared.impact.current.elapsedMs,300000);
    const html=focusDraftCard({summary:'模型未给对象信息',action:prepared.normalizedAction,impact:prepared.impact},{tasks:[]});
    assert.match(html,/&lt;旧任务标题&gt;/);assert.match(html,/工作/);assert.match(html,/时长：25 分钟/);
    assert.match(html,/已计时：5 分钟/);assert.match(html,/剩余：20 分钟/);
    assert.doesNotMatch(html,/后来修改的标题|<旧任务标题>/);
  }
});

test('switch review distinguishes trusted old snapshot from the new task and duration', () => {
  const now=Date.parse('2026-10-07T10:00:00Z'),taskState=fixtureState(),context={now,taskState,taskVersion:3,sessionId:'old-session'};
  const record=applyFocusAction(initialFocusRecord({timeZone:'UTC'}),{type:'focus.start',phase:'work',taskId:'task-1'},context).nextRecord;
  const prepared=prepareFocusAction(record,{action:{type:'focus.switch',sessionId:'old-session',phase:'work',taskId:'task-2',durationSeconds:600}},{...context,now:now+300000});
  const html=focusDraftCard({summary:'切换',action:prepared.normalizedAction,impact:prepared.impact},{tasks:[{id:'task-1',title:'过时旧标题'},{id:'task-2',title:'过时新标题'}]});
  assert.match(html,/任务：测试任务 2/);assert.match(html,/时长：10 分钟/);
  assert.match(html,/将提前结束「测试任务 1」/);assert.match(html,/已计时约 5 分钟/);
  assert.doesNotMatch(html,/过时旧标题|过时新标题/);
});

test('recovery review keeps approved context when the task has since been deleted', () => {
  const html=focusSubmissionCard({id:'d',status:'unknown',summary:'暂停',request:{action:{type:'focus.pause',sessionId:'s'}},impact:{current:{id:'s',taskId:'deleted',taskTitleSnapshot:'已删除的原任务',phase:'work',targetMs:1500000,elapsedMs:300000,remainingMs:1200000}}},{tasks:[]});
  assert.match(html,/已删除的原任务/);assert.match(html,/工作/);assert.match(html,/时长：25 分钟/);
  assert.match(html,/data-focus-submission="retry"/);assert.doesNotMatch(html,/data-apply|<input/);
});

test('break pause review identifies its phase and duration without inventing a work task', () => {
  const now=Date.parse('2026-10-07T10:00:00Z'),context={now,taskState:fixtureState(),taskVersion:3,sessionId:'break-session'};
  const record=applyFocusAction(initialFocusRecord({timeZone:'UTC'}),{type:'focus.start',phase:'shortBreak'},context).nextRecord;
  const prepared=prepareFocusAction(record,{action:{type:'focus.pause',sessionId:'break-session'}},{...context,now:now+60000});
  const html=focusDraftCard({summary:'暂停',action:prepared.normalizedAction,impact:prepared.impact},{tasks:[]});
  assert.match(html,/短休息/);assert.match(html,/时长：5 分钟/);assert.match(html,/已计时：1 分钟/);assert.match(html,/剩余：4 分钟/);
  assert.doesNotMatch(html,/任务：| · 工作/);
});
