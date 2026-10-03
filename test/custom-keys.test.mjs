import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {CustomSources} from '../proxy/custom/sources.js';
import {ModelRouter} from '../proxy/shared/router.js';
import {relay} from '../proxy/shared/relay.js';
import {createProxyService} from '../proxy/service.js';
import {createProxyTools} from '../proxy/shared/tools.js';
const model=id=>({id,upstreamId:id,enabled:true});
const config={name:'Shared provider',baseUrl:'https://example.test/v1',protocol:'chat'};
const input={model:'shared',messages:[{role:'user',content:'hello'}]};
async function fixture(t,fetchImpl){
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-keys-'));t.after(()=>rm(dataDir,{recursive:true,force:true,maxRetries:3}));
 const vault=new Map(),secrets={get:async id=>vault.get(id),set:async(id,value)=>vault.set(id,value),delete:async id=>vault.delete(id)};
 const custom=new CustomSources({dataDir,secrets,fetchImpl});return{custom,vault,dataDir};
}
async function provider(custom,s){return(await custom.providers())['custom:'+s.id];}
const keys=()=>[{id:'a',apiKey:'secret-a',models:[model('only-a'),model('shared')]},{id:'b',apiKey:'secret-b',models:[model('only-b'),model('shared')]}];

test('discover each key at the shared URL without storing credentials; union only once',async t=>{
 const requests=[];const f=await fixture(t,async(url,options)=>{const key=options.headers.Authorization;requests.push({url,key});return Response.json({data:(key==='Bearer secret-a'?['only-a','shared']:['only-b','shared']).map(id=>({id}))});});
 const result=await f.custom.discoverAll({...config,enabled:false,keys:keys(),models:[]});
 assert.deepEqual(result.models.map(m=>m.id),['only-a','shared','only-b']);
 assert.deepEqual(result.keys.map(k=>k.models.map(m=>m.id)),[['only-a','shared'],['only-b','shared']]);
 assert.ok(requests.every(r=>r.url==='https://example.test/v1/models'));assert.equal(f.vault.size,0);assert.deepEqual(await f.custom.list(),[]);
 const s=await f.custom.save({...config,keys:keys()});const router=new ModelRouter(await f.custom.providers());
 assert.deepEqual((await router.listModels()).filter(m=>m.enabled).map(m=>m.id),['only-a','shared','only-b']);assert.deepEqual(router.conflicts,[]);
 const stored=await readFile(f.custom.file,'utf8');assert.ok(!stored.includes('secret-a')&&!stored.includes('secret-b'));
 assert.equal(await f.custom.readKey(s.id,'b'),'secret-b');
});

test('refresh bypasses caches and replaces each key catalog instead of appending',async t=>{
 let round=0;const f=await fixture(t,async(_url,o)=>{assert.equal(o.headers['Cache-Control'],'no-cache');assert.equal(o.headers.Pragma,'no-cache');const id=++round<=2?'old-model':'new-model';return Response.json({data:[{id}]});});
 const s=await f.custom.save({...config,keys:keys()});
 const first=await f.custom.discoverAll(s.id);assert.deepEqual(first.models.map(m=>m.id),['old-model']);
 const second=await f.custom.discoverAll(s.id);assert.deepEqual(second.models.map(m=>m.id),['new-model']);
 const saved=await f.custom.save({...s,keys:second.keys,models:second.models});assert.deepEqual(saved.models.map(m=>m.id),['new-model']);
 assert.ok(saved.keys.every(k=>k.models.length===1&&k.models[0].id==='new-model'));assert.equal(await f.custom.readKey(s.id,'a'),'secret-a');
});

test('legacy settings and vault IDs continue working without a migration write',async t=>{
 const calls=[];const f=await fixture(t,async(_url,o)=>{calls.push(o.headers.Authorization);return Response.json({choices:[]});});
 await mkdir(path.dirname(f.custom.file),{recursive:true});const old={...config,id:'old',hasKey:true,enabled:true,models:[model('shared')]};
 old.auth='bearer';const raw=JSON.stringify([old]);await writeFile(f.custom.file,raw);f.vault.set('old','old-secret');
 const s=(await f.custom.list())[0];assert.equal(s.keys[0].id,'default');await(await provider(f.custom,s)).forward(input,'chat');
 assert.deepEqual(calls,['Bearer old-secret']);assert.equal(await readFile(f.custom.file,'utf8'),raw);
 const updated=await f.custom.save({...s,models:[model('shared'),model('only-b')],keys:[...s.keys,{id:'b',apiKey:'secret-b',models:[model('only-b')]}]});
 assert.equal(await f.custom.readKey(updated.id,'default'),'old-secret');assert.deepEqual(updated.models.map(m=>m.id),['shared','only-b']);
});

test('distinct models route only to their eligible key; same model fails over and stays pinned',async t=>{
 const calls=[];let failA=false,failB=false;
 const f=await fixture(t,async(_url,o)=>{const key=o.headers.Authorization,body=JSON.parse(o.body);calls.push({key,model:body.model});return key==='Bearer secret-a'&&failA||key==='Bearer secret-b'&&failB?new Response('',{status:429}):Response.json({choices:[]});});
 const s=await f.custom.save({...config,keys:keys()}),p=await provider(f.custom,s);
 await p.forward({...input,model:'only-b'},'chat');assert.deepEqual(calls.pop(),{key:'Bearer secret-b',model:'only-b'});
 await p.forward(input,'chat',{conversationId:'conversation'});assert.equal(calls.pop().key,'Bearer secret-a');
 failA=true;await p.forward(input,'chat',{conversationId:'conversation'});assert.deepEqual(calls.splice(0).map(c=>c.key),['Bearer secret-a','Bearer secret-b']);
 failA=false;f.custom.cooldowns.clear();const rebuilt=await provider(f.custom,s);await rebuilt.forward(input,'chat',{conversationId:'conversation'});assert.equal(calls.pop().key,'Bearer secret-b');
 await rebuilt.forward(input,'chat',{conversationId:'other'});assert.equal(calls.pop().key,'Bearer secret-a');
 failB=true;await rebuilt.forward(input,'chat',{conversationId:'conversation'});assert.deepEqual(calls.splice(0).map(c=>c.key),['Bearer secret-b','Bearer secret-a']);
});

test('network errors fail over; invalid requests and cancellation never replay',async t=>{
 const calls=[];let mode='network';const f=await fixture(t,async(_url,o)=>{calls.push(o.headers.Authorization);if(o.headers.Authorization==='Bearer secret-a'){if(mode==='network')throw new TypeError('fetch failed');return new Response('',{status:400});}return Response.json({choices:[]});});
 const s=await f.custom.save({...config,keys:keys()}),p=await provider(f.custom,s);
 await p.forward(input,'chat');assert.equal(calls.length,2);calls.length=0;f.custom.cooldowns.clear();mode='invalid';
 assert.equal((await p.forward(input,'chat')).response.status,400);assert.deepEqual(calls,['Bearer secret-a']);
 calls.length=0;await assert.rejects(()=>p.forward(input,'chat',{signal:AbortSignal.abort()}));assert.equal(calls.length,0);
});

test('server-side continuation cannot move accounts; streamed partial output never retries',async t=>{
 const calls=[];let fail=false;const f=await fixture(t,async(_url,o)=>{calls.push(o.headers.Authorization);return fail?new Response('',{status:503}):Response.json({choices:[]});});
 const s=await f.custom.save({...config,protocol:'responses',keys:keys()}),p=await provider(f.custom,s),raw={model:'shared',input:'hi'};
 await p.forward(raw,'responses',{conversationId:'session'});calls.length=0;fail=true;
 const result=await p.forward({...raw,previous_response_id:'response-id'},'responses',{conversationId:'session'});assert.equal(result.response.status,503);assert.deepEqual(calls,['Bearer secret-a']);
 await assert.rejects(()=>p.forward({...raw,previous_response_id:'response-id'},'responses'),/稳定的对话标识/);
 let forwards=0;const broken={forward:async()=>{forwards++;return{response:new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',{headers:{'content-type':'text/event-stream'}}),protocol:'chat',model:'shared'};}};
 let output='';await assert.rejects(()=>relay(broken,{...input,stream:true},'chat',{writeHead(){},write(chunk){output+=chunk;return true;},end(){}},AbortSignal.timeout(1000),()=>{}),/提前结束/);
 assert.match(output,/partial/);assert.equal(forwards,1);
});

test('save global selection and aliases into each key without inventing model access; clear remains cleared',async t=>{
 const f=await fixture(t,async(_url,o)=>Response.json({data:(o.headers.Authorization==='Bearer secret-a'?['only-a','shared']:['only-b','shared']).map(id=>({id}))}));
 const s=await f.custom.save({...config,keys:keys()});
 const selected=await f.custom.save({...s,models:[{id:'public-a',upstreamId:'only-a',enabled:true},model('only-b')]});
 assert.deepEqual(selected.keys[0].models.map(m=>m.id),['public-a']);assert.deepEqual(selected.keys[1].models.map(m=>m.id),['only-b']);
 const empty=await f.custom.save({...selected,models:[]});assert.deepEqual(empty.models,[]);assert.ok(empty.keys.every(k=>k.models.length===0));
 assert.deepEqual((await f.custom.list())[0].models,[]);
 assert.equal((await f.custom.discoverAll(empty.id)).models.length,3);assert.deepEqual((await f.custom.list())[0].models,[]);
});

test('validation never erases credentials; removing a key or source deletes only its secrets',async t=>{
 const f=await fixture(t),s=await f.custom.save({...config,keys:keys()});
 await assert.rejects(()=>f.custom.save({...s,keys:[{...s.keys[0],clearKey:true},s.keys[1]]}),/API Key/);assert.equal(await f.custom.readKey(s.id,'a'),'secret-a');
 const remaining=await f.custom.save({...s,keys:[s.keys[1]]});assert.ok(!remaining.models.some(m=>m.id==='only-a'));
 assert.equal(f.vault.get(s.id+':key:a'),undefined);assert.equal(await f.custom.readKey(s.id,'b'),'secret-b');
 await f.custom.remove(s.id);assert.equal(f.vault.size,0);
});

test('review version reflects secondary credentials and key model access, without exposing secrets',async t=>{
 const f=await fixture(t),s=await f.custom.save({...config,keys:keys()});
 const tools=createProxyTools({custom:f.custom,dataDir:f.dataDir,call:async url=>url==='/api/qoder/status'?{state:'stopped',port:4319,autoStart:false}:{models:[]}});
 const before=await tools.state();await f.custom.save({...s,keys:[s.keys[0],{...s.keys[1],apiKey:'replacement'}]});
 const after=await tools.state();assert.notEqual(after.version,before.version);assert.ok(!JSON.stringify(after).includes('replacement'));
});

test('HTTP gateway passes the conversation header only to custom sources and records the chosen key',async t=>{
 const calls=[];const f=await fixture(t,async(_url,o)=>{calls.push(o.headers.Authorization);return Response.json({choices:[{message:{role:'assistant',content:'OK'}}]});});
 await f.custom.save({...config,keys:keys()});let builtinOptions;
 const builtin={listModels:async()=>[{...model('builtin'),contextWindows:[],reasoningEfforts:[]}],forward:async(raw,protocol,options)=>{builtinOptions=options;return{response:Response.json({choices:[{message:{content:'OK'}}]}),model:raw.model,protocol};}};
 const bridge=await createProxyService({dataDir:f.dataDir,customSources:f.custom,provider:{listModels:async()=>[]},codexProvider:builtin});
 const management=http.createServer((q,r)=>bridge.handle(q,r));management.listen(0,'127.0.0.1');await once(management,'listening');
 t.after(async()=>{await bridge.close();management.closeAllConnections();await new Promise(r=>management.close(r));});
 const api=async(route,body)=>{const r=await fetch(`http://127.0.0.1:${management.address().port}`+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});assert.equal(r.status,200);return r.json();};
 const sock=http.createServer();sock.listen(0,'127.0.0.1');await once(sock,'listening');const port=sock.address().port;await new Promise(r=>sock.close(r));
 await api('/api/qoder/settings',{port,autoStart:false});const {apiKey}=await api('/api/qoder/key');await api('/api/qoder/service',{enabled:true});
 for(const model of ['shared','builtin']){const r=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json','x-daylight-conversation-id':'private-session'},body:JSON.stringify({...input,model})});assert.equal(r.status,200);await r.text();}
 assert.equal(builtinOptions.conversationId,undefined);assert.equal(calls.length,1);
 const {records}=await api('/api/proxy/requests');assert.equal(records.find(r=>r.model==='shared').keyId,'a');assert.ok(!JSON.stringify(records).includes('private-session'));
});
