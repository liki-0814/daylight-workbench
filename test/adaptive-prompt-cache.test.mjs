import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AdaptivePromptCache} from '../proxy/shared/adaptive-prompt-cache.js';
import {hasMessageCachePolicy} from '../proxy/shared/prompt-cache.js';
import {CopilotProvider} from '../proxy/copilot/provider.js';
import {fixture,catalog} from '../fixtures/copilot/upstream.mjs';
import {CustomSources} from '../proxy/custom/sources.js';
const minute=60000;
const body=(turn=1)=>({model:'fixture',system:'stable private system',tools:[{name:'read',input_schema:{type:'object'}}],messages:[{role:'user',content:'private first question'},...Array.from({length:turn-1},(_,i)=>[{role:'assistant',content:'reply'},{role:'user',content:'continue'}]).flat()]});
const markers=b=>[...b.tools||[],...b.system||[],...(b.messages||[]).flatMap(m=>Array.isArray(m.content)?m.content:[])].filter(p=>p.cache_control).map(p=>p.cache_control.ttl||'5m');
const scope={scope:['account','model'],conversationId:'session'};
async function fixtureDir(t){const dir=await mkdtemp(path.join(os.tmpdir(),'daylight-adaptive-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('cold/short interactions stay cheap, long reuse promotes, tool loops cannot erase cadence, three new user turns demote',async()=>{
 let now=1000000;const policy=new AdaptivePromptCache({now:()=>now});
 async function sample(turn=1,delta=0){now+=delta;const b=body(turn);const decision=await policy.prepare(b,scope);await decision.commit();assert(markers(b).every(ttl=>ttl===decision.ttl));return decision;}
 assert.equal((await sample()).ttl,'5m');assert.equal((await sample(2,minute)).ttl,'5m');
 const promoted=await sample(3,6*minute);assert.equal(promoted.ttl,'1h');assert.equal(promoted.reason,'long-gap');
 for(let i=0;i<10;i++)assert.equal((await sample(3,1000)).ttl,'1h');
 assert.equal((await sample(4,minute)).ttl,'1h');assert.equal((await sample(5,minute)).ttl,'1h');
 assert.equal((await sample(6,minute)).ttl,'5m');
 assert.equal((await sample(7,6*minute)).ttl,'1h');assert.equal((await sample(8,61*minute)).ttl,'1h');
});

test('stable session IDs survive prefix changes; sessions, accounts and models remain isolated',async()=>{
 let now=1000000;const policy=new AdaptivePromptCache({now:()=>now});
 let first=await policy.prepare(body(),scope);await first.commit();now+=6*minute;
 const b=body(2);b.messages.push({role:'assistant',content:[{type:'tool_use',id:'call',name:'read',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'call',content:'result'}]});
 assert.equal((await policy.prepare(b,scope)).ttl,'1h');
 for(const options of [{...scope,scope:['other-account','model']},{...scope,scope:['account','other-model']},{...scope,conversationId:'different'},{scope:scope.scope,promptCacheKey:'different'}])assert.equal((await policy.prepare(body(),options)).ttl,'5m');
 const changed=body();changed.system='different';changed.tools=[];assert.equal((await policy.prepare(changed,scope)).ttl,'1h');
 assert.equal((await policy.prepare(body(),{...scope,promptCacheKey:'different'})).ttl,'1h');
 const marked=body();marked.tools[0].cache_control={type:'ephemeral'};
 assert.equal((await policy.prepare(marked,scope)).ttl,'1h');
});

test('only accepted requests train; restart retains hashes and cadence, never content or raw session IDs',async t=>{
 const dir=await fixtureDir(t),file=path.join(dir,'cadence.json');let now=1000000;
 let policy=new AdaptivePromptCache({file,now:()=>now});const options={...scope,conversationId:'private-session-id'};
 await policy.prepare(body(),options);now+=6*minute;
 assert.equal((await policy.prepare(body(),options)).ttl,'5m');
 const first=await policy.prepare(body(),options);await first.commit();now+=6*minute;
 policy=new AdaptivePromptCache({file,now:()=>now});const second=await policy.prepare(body(),options);assert.equal(second.ttl,'1h');await second.commit();
 const stored=await readFile(file,'utf8');for(const secret of ['private','account','model','stable','read'])assert(!stored.includes(secret));
 assert.equal(JSON.parse(stored).rows.length,1);
});

test('explicit mixed native cache policies and schemas are preserved, concurrent older commits cannot roll back cadence',async()=>{
 let now=1000000;const policy=new AdaptivePromptCache({now:()=>now});
 const native=body();native.tools[0].cache_control={type:'ephemeral',ttl:'1h'};native.messages[0].content=[{type:'text',text:'Hi',cache_control:{type:'ephemeral',ttl:'5m'}}];
 const before=structuredClone(native);assert(hasMessageCachePolicy(native));const explicit=await policy.prepare(native,{...scope,explicit:true});await explicit.commit();assert.deepEqual(native,before);assert.equal(policy.rows.size,0);
 assert.equal(hasMessageCachePolicy({tools:[{input_schema:{properties:{cache_control:{type:'string'}}}}]}),undefined);
 const older=await policy.prepare(body(),scope);now+=minute;const newer=await policy.prepare(body(),scope);await newer.commit();await older.commit();
 assert.equal([...policy.rows.values()][0].at,now);
});

test('damaged storage and unwritable storage fail open; old sessions remain known while history stays bounded',async t=>{
 const dir=await fixtureDir(t),file=path.join(dir,'broken.json');await writeFile(file,'broken');
 let now=1000000;const broken=new AdaptivePromptCache({file,now:()=>now});await(await broken.prepare(body(),scope)).commit();assert.equal(await readFile(file,'utf8'),'broken');
 const unwritable=new AdaptivePromptCache({file:dir,now:()=>now});await(await unwritable.prepare(body(),scope)).commit();assert(unwritable.persistenceFailed);
 const bounded=new AdaptivePromptCache({now:()=>now});for(let i=0;i<1002;i++)await(await bounded.prepare(body(),{...scope,conversationId:String(i)})).commit();assert.equal(bounded.rows.size,1000);
 now+=25*60*minute;assert.equal((await bounded.prepare(body(),{...scope,conversationId:'1001'})).ttl,'1h');assert.equal(bounded.rows.size,1000);
});

test('Copilot applies real outgoing TTLs with restart learning, explicit policy priority, and safe unsupported-TTL fallback',async t=>{
 const dir=await fixtureDir(t);let now=1000000;
 const f=fixture({dataDir:dir,loggedIn:true});f.setModels({data:[{...catalog.data[0],supported_endpoints:['/v1/messages']}]});
 const file=path.join(dir,'policy.json');f.p.promptCache=new AdaptivePromptCache({file,now:()=>now});
 const raw={model:'copilot-chat-fixture',instructions:'stable system',max_output_tokens:64,input:'First question'};let trace={};
 await f.p.forward(raw,'responses',{conversationId:'session',observe:i=>Object.assign(trace,i)});assert.equal(trace.promptCacheTtl,'5m');
 now+=6*minute;f.p.promptCache=new AdaptivePromptCache({file,now:()=>now});
 await f.p.execute({raw,protocol:'responses',conversationId:'session'},{observe:i=>Object.assign(trace,i)});
 assert.equal(trace.promptCacheTtl,'1h');assert(markers(JSON.parse(f.calls.at(-1).init.body)).every(t=>t==='1h'));
 let rejected=0;const original=f.p.fetchImpl;f.p.fetchImpl=async(url,init)=>{
  if(url.endsWith('/v1/messages')&&JSON.parse(init.body).system?.[0]?.cache_control?.ttl==='1h'){rejected++;return Response.json({error:{message:'cache_control ttl 1h is not supported'}},{status:400});}
  return original(url,init);
 };
 await f.p.forward(raw,'responses',{conversationId:'session',observe:i=>Object.assign(trace,i)});assert.equal(rejected,1);assert.equal(trace.promptCacheTtl,'5m');assert.equal(trace.promptCacheReason,'upstream-unsupported');
 now+=6*minute;await f.p.forward(raw,'responses',{conversationId:'session'});assert.equal(rejected,1);
 const native={model:raw.model,max_tokens:64,messages:[{role:'user',content:[{type:'text',text:'Hello',cache_control:{type:'ephemeral',ttl:'5m'}}]}]};
 await f.p.forward(native,'messages',{observe:i=>Object.assign(trace,i)});assert.equal(trace.promptCacheTtl,'caller');assert.deepEqual(JSON.parse(f.calls.at(-1).init.body),native);f.p.close();
});

test('known direct Anthropic custom upstreams share learning, unknown compatible endpoints keep defaults',async t=>{
 const dir=await fixtureDir(t);let now=1000000,sent;
 const owner=new CustomSources({dataDir:dir,promptCache:new AdaptivePromptCache({now:()=>now}),fetchImpl:async(url,init)=>{sent=JSON.parse(init.body);return Response.json({});}});
 for(const baseUrl of ['https://api.anthropic.com/v1','https://unknown.example.com']){
  const source=await owner.save({name:baseUrl,baseUrl,protocol:'messages',auth:'none',models:[{id:'fixture'}]});
  const provider=(await owner.providers())['custom:'+source.id];
  const raw={model:'fixture',instructions:'Stable',max_output_tokens:64,input:'Question'};
  await provider.forward(raw,'responses',{conversationId:'same'});now+=6*minute;
  await provider.forward(raw,'responses',{conversationId:'same'});
  assert.equal(sent.system[0].cache_control.ttl,baseUrl.includes('anthropic.com')?'1h':undefined);
 }
});

test('fixed-prefix cost simulation keeps frequent traffic at 5m cost and avoids repeated long-gap writes',async()=>{
 // Illustrative token-price units, not Copilot billing. Identical fixed prefix,
 // successful hits refresh its lifetime; excludes output and growing new text.
 async function simulate(interval,mode){
  let now=1000000,expires=-1,cost=0;const policy=new AdaptivePromptCache({now:()=>now});
  for(let i=0;i<6;i++){
   const decision=mode==='adaptive'?await policy.prepare(body(),scope):null,ttl=decision?.ttl||mode;
   if(now<expires)cost+=0.05;else cost+=ttl==='1h'?2:1.25;
   expires=now+(ttl==='1h'?60:5)*minute;await decision?.commit();now+=interval;
  }
  return cost;
 }
 assert.equal(await simulate(minute,'adaptive'),await simulate(minute,'5m'));
 assert((await simulate(minute,'adaptive'))<(await simulate(minute,'1h')));
 assert((await simulate(6*minute,'adaptive'))<(await simulate(6*minute,'5m')));
});

test('native empty fields remain valid and thinking/signatures are never selected as cache breakpoints',async()=>{
 const policy=new AdaptivePromptCache();
 const b={model:'fixture',system:'',messages:[{role:'assistant',content:[{type:'thinking',thinking:'private',signature:'opaque'}]},{role:'user',content:''}]};
 const before=structuredClone(b);await policy.prepare(b,scope);assert.deepEqual(b,before);
});

test('TTL rejection cooldown expires from the rejection, rather than sliding on every request',async()=>{
 let now=1000000;const policy=new AdaptivePromptCache({now:()=>now});
 await(await policy.prepare(body(),scope)).commit();now+=6*minute;
 const rejected=await policy.prepare(body(),scope);rejected.fallback();await rejected.commit();
 const until=[...policy.rows.values()][0].disabledUntil;
 for(let i=0;i<48;i++){
  now+=30*minute;const d=await policy.prepare(body(),scope);
  assert.equal(d.ttl,i===47?'1h':'5m');await d.commit();
  if(i<47)assert.equal([...policy.rows.values()][0].disabledUntil,until);
 }
 assert.equal([...policy.rows.values()][0].disabledUntil,undefined);
});

test('persisted history loads only required cadence fields and strips unknown content',async t=>{
 const dir=await fixtureDir(t),file=path.join(dir,'cadence.json');let now=1000000;
 const policy=new AdaptivePromptCache({file,now:()=>now});await(await policy.prepare(body(),scope)).commit();
 const saved=JSON.parse(await readFile(file,'utf8'));saved.rows[0].prompt='unexpected private text';saved.rows[0].extra={raw:'private'};
 await writeFile(file,JSON.stringify(saved));now+=minute;
 const restarted=new AdaptivePromptCache({file,now:()=>now});await(await restarted.prepare(body(),scope)).commit();
 const clean=JSON.parse(await readFile(file,'utf8'));assert.deepEqual(Object.keys(clean.rows[0]).sort(),['key','at','turn','ttl','shortTurns'].sort());
 assert(!(await readFile(file,'utf8')).includes('private'));
});

test('old session timestamps use strict five-minute comparison with no one-hour or age cutoff',async t=>{
 const dir=await fixtureDir(t),file=path.join(dir,'old-session.json');let now=1000000;
 let policy=new AdaptivePromptCache({file,now:()=>now});await(await policy.prepare(body(),scope)).commit();
 now+=5*minute;assert.equal((await policy.prepare(body(),scope)).ttl,'5m');
 now++;const long=await policy.prepare(body(),scope);assert.equal(long.ttl,'1h');await long.commit();
 now+=8*24*60*minute;policy=new AdaptivePromptCache({file,now:()=>now});
 const old=await policy.prepare(body(),scope);assert.equal(old.ttl,'1h');assert.equal(old.reason,'long-gap');
});

test('requests without a session ID always use 5m, without loading or saving inferred identities',async t=>{
 const dir=await fixtureDir(t),file=path.join(dir,'unused.json');let now=1000000;
 const policy=new AdaptivePromptCache({file,now:()=>now});
 for(let i=0;i<3;i++){
  const d=await policy.prepare(body(i+1),{scope:scope.scope});await d.commit();
  assert.equal(d.ttl,'5m');assert.equal(d.reason,'no-session-id');now+=24*60*minute;
 }
 assert.equal(policy.loading,undefined);assert.equal(policy.rows.size,0);await assert.rejects(readFile(file),{code:'ENOENT'});
 const keyed=new AdaptivePromptCache({now:()=>now});const options={scope:scope.scope,promptCacheKey:'client-conversation'};
 await(await keyed.prepare(body(),options)).commit();now+=6*minute;assert.equal((await keyed.prepare(body(2),options)).ttl,'1h');
});

test('obsolete content-inferred history resets only derived learning and writes the ID-based format',async t=>{
 const dir=await fixtureDir(t),file=path.join(dir,'obsolete.json');let now=1000000;
 await writeFile(file,JSON.stringify({schema:1,rows:[{legacy:'unknown-session',prompt:'must not survive'}]}));
 const policy=new AdaptivePromptCache({file,now:()=>now});const first=await policy.prepare(body(),scope);
 assert.equal(first.ttl,'5m');assert(!policy.persistenceFailed);await first.commit();
 const saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved.schema,2);assert.equal(saved.rows.length,1);assert(!JSON.stringify(saved).includes('must not survive'));
});
