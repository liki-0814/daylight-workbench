import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureState } from './fixtures.mjs';
import { selectTasks, taskQuery } from '../public/task-view.js';
import { parseRoute, taskRoute } from '../public/routes.js';
import { sidebarContent } from '../public/components/sidebar.js';
import { buildContext } from '../ai/context.mjs';

test('task scope, project, search and status share counts and preserve plan order', () => {
  const state=fixtureState(), day='2026-10-01';
  state.tasks[1].status='done'; state.tasks[1].completedAt=day+'T00:00:00Z';
  state.tasks[2].status='active'; state.tasks[7].projectId=null;
  state.plans[day]=['task-3','task-2','task-1'];
  assert.deepEqual(selectTasks(state,{scope:'today',day,status:'all'}).tasks.map(t=>t.id),state.plans[day]);
  const result=selectTasks(state,{scope:'today',day,status:'open',query:'测试任务'});
  assert.deepEqual(result.counts,{open:2,done:1,total:3});
  assert.deepEqual(result.tasks.map(t=>t.id),['task-3','task-1']);
  assert.equal(selectTasks(state,{status:'done',projectId:'project-a',day}).tasks[0].id,'task-2');
  assert.equal(selectTasks(state,{unassigned:true,day}).tasks[0].id,'task-8');
  assert.throws(()=>taskQuery(state,0,{projectId:'missing'}),e=>e.status===404);
  assert.throws(()=>taskQuery(state,0,{day:'2026-02-30'}),e=>e.status===400);
  assert.throws(()=>taskQuery(state,0,{projectId:'project-a',unassigned:'1'}));
  assert.throws(()=>taskQuery(state,0,{scope:'tasks'}));
});

test('old links and canonical links locate completed, moved, missing tasks and exact conversations', () => {
  const state=fixtureState(); state.tasks[0].status='done';
  assert.equal(parseRoute('#done',state).status,'done');
  assert.equal(parseRoute('#inbox',state).view,'inbox');
  const linked=parseRoute('#tasks&project=project-b&status=open&task=task-1',state);
  assert.equal(linked.view,'project:project-a'); assert.equal(linked.status,'done');
  state.tasks[0].projectId='project-b';
  assert.equal(parseRoute('#task=task-1',state).view,'project:project-b');
  assert.match(parseRoute('#task=missing',state).missing,/不存在/);
  assert.equal(parseRoute('#ai&conversation=exact-id',state).conversation,'exact-id');
  const route=taskRoute('project-a','done','模型 & API');
  assert.deepEqual(parseRoute(route,state),{page:'task',view:'project:project-a',status:'done',query:'模型 & API',taskId:undefined,newTask:false,newProject:false,missing:null,explicit:true});
  state.projects.push({id:'unassigned',name:'合法项目',path:'',color:'green'});
  assert.equal(parseRoute(taskRoute('unassigned'),state).view,'project:unassigned');
  state.projects.push({id:'today',name:'与入口同名的合法 ID',path:'',color:'green'});
  assert.equal(parseRoute('#project=today',state).view,'project:today');
});

test('navigation contains only page tabs and uses distinct task and CLI icons', () => {
  const state=fixtureState();
  const html=sidebarContent({state,view:'project:project-a'});
  assert.match(html,/data-view="all"/);
  assert.doesNotMatch(html,/data-view="(?:today|inbox|done|project:.*?)"/);
  assert.doesNotMatch(html,/project-full|project-section/);
  assert.equal((html.match(/aria-current="page"/g)||[]).length,1);
});

test('context snapshots retain IDs and data, reject oversized/unknown references and report missing scopes', () => {
  const state=fixtureState(), workspace={state,version:3,localDate:'2026-10-01'};
  const c={scope:{kind:'task',id:'task-1'}};
  const snapshot=buildContext(c,{objectReferences:[{kind:'project',id:'project-b'}]},workspace);
  state.tasks[0].title='后来更名';
  assert.equal(snapshot.primary.task.title,'测试任务 1'); assert.equal(snapshot.stateVersion,3);
  assert.throws(()=>buildContext(c,{objectReferences:[{kind:'task',id:'missing'}]},workspace),e=>e.status===404);
  assert.throws(()=>buildContext(c,{viewContext:{scope:'today',day:'2026-02-30'}},workspace));
  state.tasks=[];
  assert.equal(buildContext(c,{},workspace).primary.exists,false);
});
