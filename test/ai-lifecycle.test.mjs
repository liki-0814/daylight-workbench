import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunManager } from '../ai/run-manager.mjs';
import { createDrafts } from '../ai/drafts.mjs';

const workspace = () => ({version:0,localDate:'2026-10-04',state:{schema:1,projects:[],tasks:[],plans:{}}});
const conversation = backend => ({id:'test-'+backend,backend,scope:{kind:'workspace'},config:{},messages:[],status:'idle',pending:null});
async function waitFor(condition) {
  for (let i=0;i<100;i++) {if(condition())return;await new Promise(r=>setTimeout(r,5));}
  assert.fail('AI lifecycle did not settle');
}

for (const backend of ['codex','qoder']) test(`${backend}: waiting approval blocks other runs; cancel and close settle pending waiters`, async t => {
  const c=conversation(backend),other=conversation(backend);other.id+='-other';
  const conversations=new Map([[c.id,c],[other.id,other]]),answers=[];
  const store={conversations,settings:{[backend]:{accessMode:'standard'}},save:()=>{},workspace:()=>'/tmp/fake-workspace'};
  const manager=await createRunManager({store,api:async()=>workspace(),discover:async()=>({}),getConversation:id=>conversations.get(id),tool:async()=>{},applyDraft:async()=>{},providers:{[backend]:{run:async({approve})=>{answers.push(await approve({tool:'fake-command'}));}}}});
  t.after(()=>manager.close());
  await manager.sendMessage(c,{text:'approval'});
  await waitFor(()=>c.pending);
  await assert.rejects(manager.sendMessage(other,{text:'concurrent'}),e=>e.status===409);
  await manager.answer(c,{id:c.pending.id,approve:true});
  await waitFor(()=>!manager.has(c.id));
  assert.deepEqual(answers,[true]);assert.equal(c.status,'idle');
  await manager.sendMessage(c,{text:'cancel'});
  await waitFor(()=>c.pending);
  const stale=c.pending.id;manager.stop(c);
  await waitFor(()=>!manager.has(c.id));
  assert.equal(c.status,'interrupted');assert.equal(c.pending,null);
  await assert.rejects(manager.answer(c,{id:stale,approve:true}),e=>e.status===409);
  await manager.sendMessage(c,{text:'close'});
  await waitFor(()=>c.pending);manager.close();
  await waitFor(()=>!manager.has(c.id));assert.equal(c.status,'interrupted');assert.equal(c.pending,null);
});

test('unknown draft write outcome retries the same request and cancellation is blocked during apply', async t => {
  const c=conversation('codex'),calls=[],gate=Promise.withResolvers();
  const store={conversations:new Map([[c.id,c]]),settings:{codex:{accessMode:'standard'}},save:()=>{},workspace:()=>'/tmp/fake-workspace'};
  const action={type:'task.create',id:'stable-task',title:'one write'};
  let manager,writes=0;
  const api=async(route,input)=>{
    if(route==='state')return workspace();
    calls.push(structuredClone(input));
    if(calls.length===1){writes++;await gate.promise;throw new Error('reply lost after write');}
    return{version:1,replayed:true};
  };
  const drafts=createDrafts({api,applyAI:async()=>{},save:store.save});
  manager=await createRunManager({store,api,discover:async()=>({}),getConversation:()=>c,tool:async()=>{},applyDraft:drafts.apply,providers:{codex:{run:async()=>manager.pending(c,{type:'changes',action,version:0,day:'2026-10-04',requestId:'stable-request',summary:'create'})}}});
  t.after(()=>manager.close());
  await manager.sendMessage(c,{text:'write'});await waitFor(()=>c.pending);
  const id=c.pending.id;
  const first=manager.answer(c,{id,approve:true});
  const failed=assert.rejects(first,/reply lost/);
  await waitFor(()=>c.pending?.applying);
  assert.throws(()=>manager.stop(c),e=>e.status===409);
  gate.resolve();await failed;
  assert.equal(c.pending.requestId,'stable-request');assert.equal(c.status,'waiting');
  await assert.rejects(manager.answer(c,{id,approve:true,action:{...action,title:'different'}}),e=>e.status===409);
  await manager.answer(c,{id,approve:true});await waitFor(()=>!manager.has(c.id));
  assert.equal(writes,1);assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);assert.equal(c.status,'idle');
});
