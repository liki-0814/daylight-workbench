import test from 'node:test';
import assert from 'node:assert/strict';
import { actionLinks } from '../public/components/action-links.js';
import { createDrafts } from '../ai/drafts.mjs';
import { fixtureState } from './fixtures.mjs';

test('successful plan operations retain envelope day and task links without calendar links', async () => {
  const day='2026-10-09',c={messages:[]},p={type:'changes',summary:'安排',day,version:0,requestId:'plan-review',action:{type:'plan.add',id:'task-1'}};
  const calls=[],drafts=createDrafts({api:async(route,input)=>{calls.push([route,input]);return route==='state'?{version:0,state:fixtureState()}:{version:1};},save:()=>{}});
  await drafts.apply(c,p,{approve:true});
  assert.equal(c.messages[0].day,day);assert.equal(calls[1][1].day,day);
  const html=actionLinks(c.messages[0].action,c.messages[0].day);
  assert.match(html,/#task=task-1/);assert.doesNotMatch(html,/#calendar|date=/);
  assert.deepEqual(c.messages[0].action,{type:'plan.add',id:'task-1'});
});

test('batch operations retain every task link without calendar date links', () => {
  const html=actionLinks({type:'batch',actions:[{type:'plan.add',id:'a'},{type:'plan.remove',id:'b',day:'2026-10-10'},{type:'plan.reschedule',id:'c',fromDay:'2026-10-08',toDay:'2026-10-11'},{type:'task.create',id:'d',planDay:'2026-10-12'}]},'2026-10-09');
  for(const id of ['a','b','c','d'])assert.match(html,new RegExp('#task='+id));
  assert.doesNotMatch(html,/#calendar|date=/);
});

test('legacy operations keep task links and never create calendar links', () => {
  for(const action of [{type:'plan.add',id:'a',day:'2026-10-10'},{type:'plan.remove',id:'a'},{type:'task.update',id:'a'},{type:'task.create',id:'a',today:true}]) {
    const html=actionLinks(action,'2026-10-09');
    assert.match(html,/#task=a/);assert.doesNotMatch(html,/#calendar|date=/);
  }
});
