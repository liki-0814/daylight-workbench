import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRoute,taskRoute} from '../public/routes.js';
import {selectTasks} from '../public/task-view.js';
import {taskRow} from '../public/components/task-row.js';
import {fixtureState} from './fixtures.mjs';

test('default task navigation shows planned, unplanned and completed tasks without changing stored plans',()=>{
 const state=fixtureState();state.tasks[0].status='done';state.tasks[0].completedAt='2026-11-03T01:00:00Z';state.plans['2026-11-03']=['task-2'];
 const before=structuredClone(state);
 for(const hash of ['', '#tasks', '#today', '#calendar', '#calendar&project=project-a&q=测试', '#focus',taskRoute('today')]){
  const route=parseRoute(hash,state);assert.equal(route.page,'task');assert.equal(route.view,'all');assert.equal(route.status,'all');
  const selected=selectTasks(state,{scope:'all',status:route.status});assert.equal(selected.tasks.length,8);assert.deepEqual(selected.counts,{open:7,done:1,total:8});
 }
 assert.deepEqual(state,before);
});
test('status, project and search filters remain available and task deep links open the saved task',()=>{
 const state=fixtureState();state.tasks[0].status='done';state.tasks[0].completedAt='2026-11-03T01:00:00Z';
 const route=parseRoute(taskRoute('project:project-a','done','测试任务'),state);
 assert.equal(route.view,'project:project-a');assert.equal(route.status,'done');assert.equal(route.query,'测试任务');
 assert.equal(selectTasks(state,{projectId:'project-a',status:'done',query:route.query}).tasks.length,1);
 const old=parseRoute('#focus&task=task-1',state);assert.equal(old.page,'task');assert.equal(old.taskId,'task-1');assert.equal(old.status,'done');
});
test('task rows expose completion and editing without scheduling or execution controls',()=>{
 const state=fixtureState();
 for(const status of ['todo','active','done']){
  const html=taskRow({...state.tasks[0],status},{project:state.projects[0]});
  assert.match(html,/data-action="toggle"/);assert.match(html,/data-action="edit"/);assert.match(html,/测试任务 1/);
  assert.doesNotMatch(html,/今天|专注|进行中|data-action="(?:start|plan|unplan|up|down)"/);
 }
});
