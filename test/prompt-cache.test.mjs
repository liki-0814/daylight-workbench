import test from 'node:test';
import assert from 'node:assert/strict';
import {convertRequest,prepareUpstreamRequest} from '../proxy/shared/protocol.js';
import {CustomSources} from '../proxy/custom/sources.js';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ephemeral={type:'ephemeral'};
const raw={model:'fixture',max_output_tokens:64,instructions:'Stable instructions',tools:[{type:'function',name:'read',parameters:{type:'object',properties:{cache_control:{type:'string'}}}}],input:[
 {role:'user',content:'Read it'},
 {type:'function_call',call_id:'call-1',name:'read',arguments:'{}'},
 {type:'function_call_output',call_id:'call-1',output:'result'},
]};
const markers=body=>{
 const found=[];
 const visit=value=>{if(!value||typeof value!=='object')return;if(value.cache_control)found.push(value);for(const [key,child] of Object.entries(value))if(!['parameters','input_schema','cache_control'].includes(key))visit(child);};
 visit(body);return found;
};

test('upstream preparation caches stable prefixes and rolling tool turns for both translated protocols',()=>{
 for(const from of ['responses','chat']){
  const input=from==='responses'?raw:convertRequest(raw,'responses','chat'),before=structuredClone(input);
  const body=prepareUpstreamRequest(input,from,'messages');
  assert.deepEqual(body.system,[{type:'text',text:raw.instructions,cache_control:ephemeral}]);
  assert.deepEqual(body.tools[0].cache_control,ephemeral);
  assert.deepEqual(body.tools[0].input_schema,raw.tools[0].parameters);
  assert.deepEqual(body.messages.at(-2).content.at(-1).cache_control,ephemeral);
  assert.deepEqual(body.messages.at(-1).content.at(-1).cache_control,ephemeral);
  assert.equal(body.messages.at(-1).content.at(-1).tool_use_id,'call-1');
  assert.equal(markers(body).length,4);
  assert.deepEqual(input,before);
 }
});

test('appending turns preserves stable prefix cache keys and previous turn boundaries',()=>{
 const initial=prepareUpstreamRequest(raw,'responses','messages');
 const next=prepareUpstreamRequest({...raw,input:[...raw.input,{role:'assistant',content:'Done'},{role:'user',content:'Continue'}]},'responses','messages');
 assert.deepEqual(next.system,initial.system);assert.deepEqual(next.tools,initial.tools);
 const strip=body=>JSON.parse(JSON.stringify(body,(key,value)=>key==='cache_control'?undefined:value));
 assert.deepEqual(strip(next).messages.slice(0,initial.messages.length),strip(initial).messages);
 assert.equal(markers(next).length,4);
});

test('native caller policies retain both five-minute and one-hour TTLs exactly',()=>{
 for(const ttl of ['5m','1h']){
  const native={model:'fixture',max_tokens:64,messages:[{role:'user',content:[{type:'text',text:'Hi',cache_control:{type:'ephemeral',ttl}}]}]};
  assert.deepEqual(prepareUpstreamRequest(native,'messages','messages'),native);
 }
});

test('OpenAI protocol conversions preserve caller cache routing and retention without inventing a TTL',()=>{
 for(const from of ['responses','chat']){
  const input=from==='responses'?raw:convertRequest(raw,'responses','chat');
  const withHints={...input,prompt_cache_key:'stable-session',prompt_cache_retention:'24h'};
  const before=structuredClone(withHints);
  const body=prepareUpstreamRequest(withHints,from,from==='responses'?'chat':'responses');
  assert.equal(body.prompt_cache_key,'stable-session');assert.equal(body.prompt_cache_retention,'24h');
  assert.deepEqual(withHints,before);assert.equal(markers(body).length,0);
  assert.throws(()=>prepareUpstreamRequest(withHints,from,'messages'),/无法转换 prompt_cache_retention/);
  const translated=prepareUpstreamRequest({...input,prompt_cache_key:'stable-session'},from,'messages');
  assert.equal(translated.prompt_cache_key,undefined);
  for(const block of markers(translated))assert.deepEqual(block.cache_control,ephemeral);
 }
});

test('minimal and image-only translations get valid outer cache boundaries',()=>{
 for(const input of ['Hi',[{role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,AAAA'}]}]]){
  const body=prepareUpstreamRequest({model:'fixture',max_output_tokens:64,input},'responses','messages');
  assert.equal(markers(body).length,1);assert.deepEqual(body.messages[0].content[0].cache_control,ephemeral);
 }
 assert.equal(markers(prepareUpstreamRequest({model:'fixture',max_output_tokens:64,input:[]},'responses','messages')).length,0);
});

test('native cache policies remain exact and other targets never receive Anthropic cache markers',()=>{
 for(const protocol of ['chat','responses','messages']){
  const body={model:'fixture',cache_control:{type:'ephemeral',ttl:'1h'},custom:'native',messages:[{role:'user',content:'Hi'}]};
  const prepared=prepareUpstreamRequest(body,protocol,protocol);
  assert.deepEqual(prepared,body);assert.notEqual(prepared,body);
 }
 for(const target of ['chat','responses']){
  const from=target==='chat'?'responses':'chat';const input=from==='responses'?raw:convertRequest(raw,'responses','chat');
  assert.deepEqual(prepareUpstreamRequest(input,from,target),convertRequest(input,from,target));
 }
});

test('custom Messages sources use the same cache policy at their actual upstream boundary',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-cache-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 let sent;
 const owner=new CustomSources({dataDir,fetchImpl:async(url,options)=>{sent=JSON.parse(options.body);return Response.json({content:[],usage:{input_tokens:0,output_tokens:0}});}});
 const source=await owner.save({name:'Messages cache fixture',baseUrl:'https://example.com',auth:'none',protocol:'messages',models:[{id:'fixture'}]});
 const provider=(await owner.providers())['custom:'+source.id];
 await provider.forward(raw,'responses');
 assert.equal(markers(sent).length,4);assert.deepEqual(sent.tools[0].cache_control,ephemeral);
 const native={model:'fixture',max_tokens:64,system:[{type:'text',text:'Keep my TTL',cache_control:{type:'ephemeral',ttl:'1h'}}],messages:[{role:'user',content:'Hi'}]};
 await provider.forward(native,'messages');assert.deepEqual(sent,native);
});

test('custom Chat and Responses upstreams receive original cache hints after conversion',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-cache-hints-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 let sent;
 const owner=new CustomSources({dataDir,fetchImpl:async(url,options)=>{sent=JSON.parse(options.body);return Response.json({});}});
 for(const target of ['chat','responses']){
  const source=await owner.save({name:target,baseUrl:'https://example.com',auth:'none',protocol:target,models:[{id:'fixture'}]});
  const provider=(await owner.providers())['custom:'+source.id];
  const from=target==='chat'?'responses':'chat',input=from==='responses'?raw:convertRequest(raw,'responses','chat');
  await provider.forward({...input,prompt_cache_key:'client-key',prompt_cache_retention:'24h'},from);
  assert.equal(sent.prompt_cache_key,'client-key');assert.equal(sent.prompt_cache_retention,'24h');assert.equal(markers(sent).length,0);
 }
});
