import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GrokAuth } from '../proxy/grok/auth.js';
import { GrokProvider } from '../proxy/grok/provider.js';
import { compileRequest, decodeStream, parseUsage } from '../proxy/grok/protocol.js';
import { createProxyService } from '../proxy/service.js';
const model={id:'grok-test',enabled:true,reasoningEfforts:['low','high'],defaultEffort:'high',contextWindows:[]};
const auth={credential:async()=>({token:'private-token',identity:'account-a',version:'1.0.41'})};
const events=[
 {type:'response.created',response:{id:'r',model:'internal',output:[]}},
 {type:'response.reasoning_summary_text.delta',delta:'summary'},
 {type:'response.output_text.delta',delta:'你好'},
 {type:'response.output_item.added',output_index:1,item:{type:'function_call',call_id:'c',name:'echo',arguments:''}},
 {type:'response.function_call_arguments.delta',output_index:1,delta:'{"text":'},
 {type:'response.function_call_arguments.delta',output_index:1,delta:'"hi"}'},
 {type:'response.output_item.done',output_index:1,item:{type:'function_call',call_id:'c',name:'echo',arguments:'{"text":"hi"}'}},
 {type:'response.completed',response:{id:'r',model:'internal',status:'completed',output:[{type:'reasoning',id:'thought',encrypted_content:'opaque'},{type:'message',role:'assistant',content:[{type:'output_text',text:'你好'}]},{type:'function_call',call_id:'c',name:'echo',arguments:'{"text":"hi"}'}],usage:{input_tokens:100,output_tokens:8,total_tokens:108,input_tokens_details:{cached_tokens:90},output_tokens_details:{reasoning_tokens:5}}}},
];
function sse(items=events){const bytes=Buffer.from(items.map(e=>`event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(''));let i=0;return new Response(new ReadableStream({pull(c){if(i===bytes.length)return c.close();const end=Math.min(i+7,bytes.length);c.enqueue(bytes.subarray(i,end));i=end;}}));}
const request=(raw,p='chat')=>({model:'grok-test',raw:{model:'grok-test',...raw},options:{protocol:p}});
test('Grok preserves role order, schema, tool ids and explicit parameters; rejects lossy options',()=>{
 const r=compileRequest(request({messages:[{role:'system',content:'A'},{role:'user',content:'B'},{role:'developer',content:'C'}],max_tokens:100,reasoning_effort:'low',tools:[{type:'function',function:{name:'echo',strict:true,parameters:{type:'object',additionalProperties:false}}}],tool_choice:{type:'function',function:{name:'echo'}},parallel_tool_calls:false}),model);
 assert.deepEqual(r.input.map(m=>m.role),['system','user','developer']);assert.equal(r.reasoning.effort,'low');assert.equal(r.tools[0].strict,true);assert.equal(r.parallel_tool_calls,false);assert.equal(r.max_output_tokens,100);assert.equal(r.store,false);
 for(const fields of [{max_tokens:1,max_completion_tokens:2},{reasoning_effort:'max'},{stop:['x']},{previous_response_id:'r'}])assert.throws(()=>compileRequest(request({messages:[{role:'user',content:'x'}],...fields}),model));
 assert.throws(()=>compileRequest(request({input:'x',store:true},'responses'),model));
 assert.throws(()=>compileRequest(request({messages:[{role:'user',content:[{type:'image',source:{type:'base64',data:'x'}}]}]},'messages'),model));
 const r2=compileRequest(request({input:[{type:'reasoning',encrypted_content:'opaque'},{type:'function_call',call_id:'c',name:'echo',arguments:'{}'},{type:'function_call_output',call_id:'c',output:'ok'}]},'responses'),model);assert.equal(r2.input[0].encrypted_content,'opaque');
 assert.throws(()=>compileRequest(request({input:[{type:'function_call_output',call_id:'c',output:'orphan'}]},'responses'),model));
});
test('Grok streamed args are not duplicated; raw Responses and usage are preserved; EOF fails',async()=>{
 const all=await Array.fromAsync(decodeStream(sse(),model.id));
 assert.equal(all.filter(e=>e.type==='tool_call').map(e=>e.argumentsDelta).join(''),'{"text":"hi"}');
 assert.equal(all.find(e=>e.type==='usage').usage.cacheReadTokens,90);assert.equal(all.find(e=>e.type==='usage').usage.cacheWriteTokens,undefined);
 assert.equal(all.filter(e=>e.type==='native_response').at(-1).event.response.output[0].encrypted_content,'opaque');
 assert.equal(all.at(-1).reason,'tool_calls');
 assert.equal((await Array.fromAsync(decodeStream(sse(events.slice(0,-1)),model.id))).at(-1).code,'incomplete_stream');
 assert.equal(parseUsage({input_tokens:0}).inputTokens,0);assert.equal(parseUsage({}).inputTokens,undefined);
});
test('Grok auth renews using CLI once, never overwrites credentials, rejects ambiguous scopes',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'grok-auth-'));t.after(()=>rm(home,{recursive:true,force:true}));let runs=0;
 const file=path.join(home,'auth.json'),store={'https://auth.x.ai::client':{auth_mode:'oidc',key:'old',expires_at:new Date(0).toISOString(),user_id:'u'}};
 await writeFile(file,JSON.stringify(store));
 const a=new GrokAuth({home,run:async(_,args)=>{if(args[0]==='--version')return{stdout:'grok 1.0.41 (build)'};runs++;store['https://auth.x.ai::client'].key='new';store['https://auth.x.ai::client'].expires_at=new Date(Date.now()+3600000).toISOString();await writeFile(file,JSON.stringify(store));return{stdout:''};}});
 const result=await Promise.all([a.credential(),a.credential()]);assert.equal(runs,1);assert.equal(result[0].token,'new');assert.equal(result[1].token,'new');
 store['https://auth.x.ai::second']={...store['https://auth.x.ai::client']};await writeFile(file,JSON.stringify(store));await assert.rejects(()=>a.credential(),/grok login/);
});
test('Grok persistent catalog is identity scoped; refresh deduplicates and never saves credentials',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'grok-models-'));t.after(()=>rm(dir,{recursive:true,force:true}));let calls=0,identity='a';
 const a={credential:async()=>({token:'secret',identity,version:'1.0.41'})};
 const fetchImpl=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return Response.json({data:[{id:'grok-test',api_backend:'responses',context_window:256000,reasoning_efforts:[{value:'low'}]}]});};
 const p=new GrokProvider({dataDir:dir,auth:a,fetchImpl});await Promise.all([p.listModels(),p.listModels()]);assert.equal(calls,1);
 const q=new GrokProvider({dataDir:dir,auth:a,fetchImpl});await q.listModels();assert.equal(calls,1);await q.listModels(true);assert.equal(calls,2);
 identity='b';await q.listModels();assert.equal(calls,3);assert.ok(!(await readFile(path.join(dir,'grok/catalog.json'),'utf8')).includes('secret'));
});
test('one address routes Grok on all three protocols, preserves native output and records actual source',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'grok-bridge-'));const bodies=[];
 const g=new GrokProvider({dataDir:dir,auth,fetchImpl:async(url,opts)=>{
  if(url.endsWith('/models'))return Response.json({data:[{id:model.id,api_backend:'responses',supports_reasoning_effort:true,reasoning_efforts:[{value:'low'},{value:'high'}]}]});
  bodies.push(JSON.parse(opts.body));assert.equal(opts.headers.Authorization,'Bearer private-token');return sse();
 }});
 const q={listModels:async()=>[{...model,id:'qoder-test'}],async *stream(){yield{type:'text',delta:'qoder'};yield{type:'finish',reason:'stop'};}};
 const bridge=await createProxyService({dataDir:dir,provider:q,grokProvider:g});
 const management=http.createServer((req,res)=>bridge.handle(req,res));management.listen(0,'127.0.0.1');await once(management,'listening');
 const base=`http://127.0.0.1:${management.address().port}`;
 const api=async(route,body)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
 const tmp=http.createServer();tmp.listen(0,'127.0.0.1');await once(tmp,'listening');const port=tmp.address().port;await new Promise(r=>tmp.close(r));
 t.after(async()=>{await bridge.close();management.closeAllConnections();await new Promise(r=>management.close(r));await rm(dir,{recursive:true,force:true});});
 await api('/api/qoder/settings',{port,autoStart:false});const key=(await api('/api/qoder/key')).data.apiKey;assert.equal((await api('/api/qoder/service',{enabled:true})).status,200);
 for(const [route,fields]of [['responses',{input:'hello'}],['chat/completions',{messages:[{role:'user',content:'hello'}]}],['messages',{messages:[{role:'user',content:'hello'}],max_tokens:100}]])for(const stream of[false,true]){
  const r=await fetch(`http://127.0.0.1:${port}/v1/${route}`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:model.id,...fields,stream})});assert.equal(r.status,200);const text=await r.text();assert.match(text,/你好/);assert.match(text,/echo/);assert.match(text,/90/);if(route==='responses')assert.match(text,/opaque/);
 }
 assert.equal(bodies.length,6);const records=(await api('/api/qoder/usage')).data.records;assert.equal(records.length,6);assert.ok(records.every(r=>r.provider==='grok'));assert.ok(!JSON.stringify(records).includes('private-token'));
 assert.equal((await api('/api/grok/models/setting',{id:model.id,field:'effort',value:'low'})).status,200);
});
test('Grok preserves images and native search while refusing unsupported cross-protocol tools',()=>{
 const url='data:image/png;base64,AAAA';
 const b=compileRequest(request({messages:[{role:'user',content:[{type:'text',text:'color?'},{type:'image_url',image_url:{url,detail:'low'}}]}]}),model);
 assert.deepEqual(b.input[0].content[1],{type:'input_image',image_url:url,detail:'low'});
 assert.throws(()=>compileRequest(request({messages:[{role:'user',content:[{type:'image_url',image_url:{url:'file:///etc/passwd'}}]}]}),model));
 const n=compileRequest(request({input:'search',tools:[{type:'web_search'},{type:'x_search'}]},'responses'),model);assert.equal(n.tools[1].type,'x_search');
 assert.throws(()=>compileRequest(request({messages:[{role:'user',content:'search'}],tools:[{type:'web_search'}]}),model));
});
test('Grok quota cache preserves unknowns, period and account boundaries',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'grok-quota-'));t.after(()=>rm(dir,{recursive:true,force:true}));let identity='a',calls=0;
 const p=new GrokProvider({dataDir:dir,auth:{credential:async()=>({...await auth.credential(),identity})},fetchImpl:async()=>{calls++;return Response.json({config:{creditUsagePercent:47,currentPeriod:{type:'USAGE_PERIOD_TYPE_WEEKLY',end:'2026-10-01T00:00:00Z'},isUnifiedBillingUser:true}});}});
 const a=await p.quota();assert.equal(a.usedPercent,47);assert.equal(a.period.type,'USAGE_PERIOD_TYPE_WEEKLY');await p.quota();assert.equal(calls,1);identity='b';await p.quota();assert.equal(calls,2);
});

test('Grok output budget is optional and explicit client values override defaults', () => {
 for (const protocol of ['chat', 'responses', 'messages']) {
  const raw = protocol === 'responses' ? {input:'hello'} : {messages:[{role:'user',content:'hello'}]};
  const budgetKey = protocol === 'responses' ? 'max_output_tokens' : 'max_tokens';
  assert.equal(Object.hasOwn(compileRequest(request(raw, protocol), model), 'max_output_tokens'), false);
  assert.equal(compileRequest(request(raw, protocol), {...model,defaultMaxTokens:64}).max_output_tokens,64);
  assert.equal(compileRequest(request({...raw,[budgetKey]:65536}, protocol), {...model,defaultMaxTokens:64}).max_output_tokens,65536);
  assert.throws(()=>compileRequest(request({...raw,[budgetKey]:0}, protocol),model));
 }
});
test('Grok idle timeout resets on data and terminal events close without waiting for EOF', async () => {
 const encoder=new TextEncoder();let index=0,cancelled=false;
 const stream=new ReadableStream({async pull(controller) {
  await new Promise(r=>setTimeout(r,15));
  if(cancelled)return;
  if(index++<5)controller.enqueue(encoder.encode(': keepalive\n\n'));
  else controller.enqueue(encoder.encode('data: '+JSON.stringify({type:'response.completed',response:{output:[]}})+'\n\n'));
 },cancel(){cancelled=true;}});
 const result=await Array.fromAsync(decodeStream(new Response(stream),model.id,undefined,60));
 assert.equal(result.at(-1).type,'finish');assert.equal(cancelled,true);
 let aborted=false;
 const stalled=new ReadableStream({cancel(){aborted=true;}});
 await assert.rejects(()=>Array.fromAsync(decodeStream(new Response(stalled),model.id,undefined,10)),/空闲超时/);
 assert.equal(aborted,true);
});
