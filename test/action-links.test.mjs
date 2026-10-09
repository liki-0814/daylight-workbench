import test from 'node:test';
import assert from 'node:assert/strict';
import { actionLinks } from '../public/components/action-links.js';
import { createDrafts } from '../ai/drafts.mjs';
import { fixtureState } from './fixtures.mjs';

test('successful plan operations retain envelope day for calendar links', async () => {
  const day='2026-10-09',c={messages:[]},p={type:'changes',summary:'安排',day,version:0,requestId:'plan-review',action:{type:'plan.add',id:'task-1'}};
  const calls=[],drafts=createDrafts({api:async(route,input)=>{calls.push([route,input]);return route==='state'?{version:0,state:fixtureState()}:{version:1};},save:()=>{}});
  await drafts.apply(c,p,{approve:true});
  assert.equal(c.messages[0].day,day);assert.equal(calls[1][1].day,day);
  assert.match(actionLinks(c.messages[0].action,c.messages[0].day),/date=2026-10-09/);
  assert.deepEqual(c.messages[0].action,{type:'plan.add',id:'task-1'});
});

test('batch date links use explicit child dates before envelope day and reschedule destination', () => {
  const html=actionLinks({type:'batch',actions:[{type:'plan.add',id:'a'},{type:'plan.remove',id:'b',day:'2026-10-10'},{type:'plan.reschedule',id:'c',fromDay:'2026-10-08',toDay:'2026-10-11'},{type:'task.create',id:'d',planDay:'2026-10-12'}]},'2026-10-09');
  for(const day of ['2026-10-09','2026-10-10','2026-10-11','2026-10-12'])assert.match(html,new RegExp('date='+day));
  assert.doesNotMatch(html,/date=2026-10-08/);
});

test('legacy explicit dates still work and missing dates are not replaced by today', () => {
  assert.match(actionLinks({type:'plan.add',id:'a',day:'2026-10-10'}),/date=2026-10-10/);
  assert.match(actionLinks({type:'plan.add',id:'a',day:'2026-10-10'},'2026-10-09'),/date=2026-10-10/);
  assert.doesNotMatch(actionLinks({type:'plan.remove',id:'a'}),/#calendar/);
  assert.doesNotMatch(actionLinks({type:'task.update',id:'a'},'2026-10-09'),/#calendar/);
  assert.match(actionLinks({type:'task.create',id:'a',today:true},'2026-10-09'),/date=2026-10-09/);
});
