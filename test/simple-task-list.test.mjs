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
  const html=taskRow({...state.tasks[0],status,notes:'先确认接口契约\n再补回归'},{busy:false});
  assert.match(html,/data-action="toggle"/);assert.match(html,/data-action="edit"/);assert.match(html,/测试任务 1/);
  // 排期与执行入口保持退役：没有今日、专注，也没有开始/暂停或今日排序动作。
  assert.doesNotMatch(html,/今天|专注|data-action="(?:start|plan|unplan|up|down)"/);
  assert.deepEqual([...html.matchAll(/data-action="([^"]+)"/g)].map(match=>match[1]),['toggle','edit']);
 }
});

test('task rows summarise notes, mark legacy active status and date completed tasks',()=>{
 const state=fixtureState();
 const notes='先确认接口契约\n再补回归';
 const active=taskRow({...state.tasks[0],status:'active',notes});
 assert.match(active,/<span class="task-meta-chip">进行中<\/span>/);
 // 备注压成单行摘要，换行不进入行内文本。
 assert.match(active,/<span class="task-meta-notes">先确认接口契约 再补回归<\/span>/);
 assert.doesNotMatch(taskRow({...state.tasks[0],status:'todo'}),/task-row-meta/);
 // 待办行不显示进行中标记，但有备注时仍带摘要。
 const todo=taskRow({...state.tasks[0],status:'todo',notes});
 assert.match(todo,/task-meta-notes/);assert.doesNotMatch(todo,/task-meta-chip/);
 // 完成行只追加完成日期，格式为 MM-DD 或 YYYY-MM-DD。
 const done=taskRow({...state.tasks[0],status:'done',completedAt:'2026-11-03T01:00:00Z'});
 assert.match(done,/<span class="task-date">(?:\d{4}-)?\d{2}-\d{2}<\/span>/);
 assert.doesNotMatch(taskRow({...state.tasks[0],status:'done',completedAt:'not-a-date'}),/task-date/);
});
