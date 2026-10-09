import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolDispatch } from '../ai/tools/dispatch.mjs';
import { definitions } from '../ai/tools/definitions.mjs';

test('calendar and focus reads use GET query parameters and never create approval or writes', async () => {
  const calls=[];
  const tool=createToolDispatch({api:async(...args)=>{calls.push(args);return {ok:true};},pending:()=>assert.fail('read created pending')});
  await tool({},'daylight_get_calendar',{from:'2026-10-01',to:'2026-10-31',unassigned:true});
  await tool({},'daylight_get_focus');
  await tool({},'daylight_get_focus_statistics',{from:'2026-10-01',to:'2026-10-06',taskId:'task-1'});
  await tool({},'daylight_get_focus_sessions',{limit:20});
  await tool({},'daylight_get_task_focus_summary',{taskId:'task-1',recentLimit:5});
  assert.deepEqual(calls.map(c=>c[0]),['calendar','focus/state','focus/statistics','focus/sessions','focus/task-summary']);
  assert.ok(calls.every(c=>c[1]===undefined));
  assert.equal(calls[0][2].unassigned,'1');
  await assert.rejects(tool({},'daylight_get_calendar',{from:'2026-10-01',to:'2026-10-31',expectedVersion:99}),/未知字段/);
});

test('focus proposal freezes versions, ID and expiry from trusted prepare and blocks unresolved submissions', async () => {
  const calls=[],drafts=[];
  const action={type:'focus.start',phase:'work',taskId:'task-1'};
  const c={id:'c'};
  const tool=createToolDispatch({api:async(route,input)=>{calls.push([route,input]);return route==='focus/prepare'?{focusVersion:4,taskVersion:7,normalizedAction:{...action,durationSeconds:1500},expiresAt:10000,impact:{endsCurrent:false}}:{};},pending:async(_,draft)=>{drafts.push(draft);return draft;}});
  await tool(c,'daylight_propose_focus_changes',{summary:'开始专注',action});
  assert.deepEqual(calls.map(c=>c[0]),['focus/state','focus/prepare']);
  assert.equal(drafts[0].version,4);assert.equal(drafts[0].taskVersion,7);
  assert.equal(drafts[0].expiresAt,10000);assert.match(drafts[0].requestId,/^[a-f0-9-]{36}$/);
  assert.equal(drafts[0].action.durationSeconds,1500);
  await assert.rejects(tool(c,'daylight_propose_focus_changes',{summary:'spoof',action,requestId:'model-provided'}),/变更说明/);
  c.focusSubmission={status:'unknown'};
  await assert.rejects(tool(c,'daylight_propose_focus_changes',{summary:'repeat',action}),e=>e.status===409);
  assert.equal(drafts.length,1);
  const schema=definitions.find(t=>t.name==='daylight_propose_focus_changes').inputSchema;
  assert.equal(schema.additionalProperties,false);assert.deepEqual(Object.keys(schema.properties),['summary','action']);
});
