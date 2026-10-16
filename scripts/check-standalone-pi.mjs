// Installed Pi against isolated OAuth and inference fixtures; never uses a real account.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {accountFixture} from '../fixtures/standalone-accounts/upstream.mjs';
import {agyFixture} from '../fixtures/agy-account/upstream.mjs';
const piRoot=process.argv[2],runtimeRoot=process.argv[3]||path.resolve('.');
if(!piRoot)throw Error('Pass the installed pi-coding-agent package directory and optional packaged Resources directory');
const from=relative=>import(pathToFileURL(path.join(runtimeRoot,relative)));
const [{createProxyService},{ModelRuntime}]=await Promise.all([from('proxy/service.js'),import(pathToFileURL(path.join(piRoot,'dist/core/model-runtime.js')))]);
const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-independent-pi-')),results=[];
let bridge,management;
try{
 const providers={};
 for(const id of ['kimi','grok','codex','agy']){
  const f=(id==='agy'?agyFixture:accountFixture)({id,dataDir,loggedIn:true});await f.ready;
  // Instantiate packaged adapters around the same isolated upstream and Keychain doubles.
  const [{[id[0].toUpperCase()+id.slice(1)+'Auth']:Auth},{[id[0].toUpperCase()+id.slice(1)+'Provider']:Provider}]=await Promise.all([from(`proxy/${id}/auth.js`),from(`proxy/${id}/provider.js`)]);
  const auth=new Auth({dataDir,fetchImpl:f.fetchImpl,secrets:f.secrets});
  providers[id]=new Provider({dataDir,auth,fetchImpl:f.fetchImpl});
 }
 bridge=await createProxyService({dataDir,provider:{listModels:async()=>[]},agyProvider:providers.agy,kimiProvider:providers.kimi,grokProvider:providers.grok,codexProvider:providers.codex,pricingOptions:{enabled:false},piOptions:{piDir:path.join(dataDir,'pi'),getInfo:async()=>({installed:true})}});
 management=http.createServer(bridge.handle);await new Promise(r=>management.listen(0,'127.0.0.1',r));
 const call=async(route,body)=>{const r=await fetch('http://127.0.0.1:'+management.address().port+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result;};
 const reservation=http.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 await call('/api/proxy/settings',{port,autoStart:false});await call('/api/proxy/service',{enabled:true});
 const apiKey=(await call('/api/proxy/key')).apiKey,api='openai-responses';
 const state=await call('/api/cli/pi/state?api='+api);await call('/api/cli/pi/apply',{api,expectedVersion:state.version,requestId:'standalone-pi'});
 const modelsPath=path.join(dataDir,'pi/models.json'),runtime=await ModelRuntime.create({modelsPath,authPath:path.join(dataDir,'pi/auth.json'),allowModelNetwork:false});
 for(const id of ['kimi','grok','codex','agy']){
  const model=runtime.getModel('daylight',id+'-fixture');assert(model,id);assert.equal(model.api,api);
  const tools=[{name:'echo',description:'Echo text',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}}],user={role:'user',content:'Echo hello',timestamp:Date.now()},options={apiKey,reasoning:'high',cacheRetention:'none'};
  const first=await runtime.streamSimple(model,{messages:[user],tools},options).result();assert.equal(first.stopReason,'toolUse',JSON.stringify(first));const tool=first.content.find(c=>c.type==='toolCall');assert.equal(tool.name,'echo');assert.deepEqual(tool.arguments,{text:'hello'});
  const toolResult={role:'toolResult',toolCallId:tool.id,toolName:tool.name,content:[{type:'text',text:'hello'}],isError:false,timestamp:Date.now()};
  const second=await runtime.streamSimple(model,{messages:[user,first,toolResult],tools},options).result();assert.equal(second.stopReason,'stop',JSON.stringify(second));assert.equal(second.content.find(c=>c.type==='text').text,'OK');
  results.push({source:id,api,toolCall:true,continuation:true,usage:second.usage});
 }
 console.log(JSON.stringify({runtimeRoot,results}));
}finally{await bridge?.close();if(management){management.closeAllConnections();await new Promise(r=>management.close(r));}await rm(dataDir,{recursive:true,force:true});}
