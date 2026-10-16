// Optional installed-Pi + packaged-provider smoke. Uses isolated config and synthetic upstream only.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixture,catalog} from '../fixtures/copilot/upstream.mjs';
const piRoot=process.argv[2],runtimeRoot=process.argv[3]||path.resolve('.');
if(!piRoot)throw Error('Pass the installed pi-coding-agent package directory and optional packaged Resources directory');
const from=relative=>import(pathToFileURL(path.join(runtimeRoot,relative)));
const [{createProxyService},{CopilotProvider},{CopilotAuth},{ModelRuntime},{ModelConfig}]=await Promise.all([
 from('proxy/service.js'),from('proxy/copilot/provider.js'),from('proxy/copilot/auth.js'),import(pathToFileURL(path.join(piRoot,'dist/core/model-runtime.js'))),import(pathToFileURL(path.join(piRoot,'dist/core/model-config.js'))),
]);
const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-copilot-pi-')),f=fixture({dataDir,loggedIn:true}),results=[];
let bridge,management;
try{
 const auth=new CopilotAuth({fetchImpl:f.fetchImpl,secrets:f.secrets});
 bridge=await createProxyService({dataDir,provider:{listModels:async()=>[]},copilotProvider:new CopilotProvider({dataDir,auth,fetchImpl:f.fetchImpl}),pricingOptions:{enabled:false},piOptions:{piDir:path.join(dataDir,'pi'),getInfo:async()=>({installed:true})}});
 management=http.createServer(bridge.handle);await new Promise(r=>management.listen(0,'127.0.0.1',r));
 const call=async(route,body)=>{const response=await fetch('http://127.0.0.1:'+management.address().port+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;};
 const reservation=http.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 await call('/api/proxy/settings',{port,autoStart:false});await call('/api/proxy/service',{enabled:true});
 const apiKey=(await call('/api/proxy/key')).apiKey;
 for(const api of ['openai-completions','openai-responses','anthropic-messages']){
  if(api==='anthropic-messages'){f.setModels({data:[{...catalog.data[0],supported_endpoints:['/v1/messages']}]});await call('/api/proxy/sources/copilot/models?refresh=1');}
  const state=await call('/api/cli/pi/state?api='+api);await call('/api/cli/pi/apply',{api,expectedVersion:state.version,requestId:'copilot-'+api});
  const modelsPath=path.join(dataDir,'pi/models.json'),config=await ModelConfig.load(modelsPath);assert.equal(config.getError(),undefined);
  const runtime=await ModelRuntime.create({modelsPath,authPath:path.join(dataDir,'pi/auth.json'),allowModelNetwork:false});
  const model=runtime.getModel('daylight','copilot-chat-fixture');assert(model);assert.equal(model.api,api);assert.equal(model.contextWindow,128000);
  const tools=[{name:'echo',description:'Echo text',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}}],user={role:'user',content:'Echo hello',timestamp:Date.now()},options={apiKey,reasoning:'high',maxTokens:100,cacheRetention:'none'};
  const first=await runtime.streamSimple(model,{messages:[user],tools},options).result();assert.equal(first.stopReason,'toolUse',JSON.stringify(first));const tool=first.content.find(c=>c.type==='toolCall');assert.equal(tool.name,'echo');assert.deepEqual(tool.arguments,{text:'hello'});
  const toolResult={role:'toolResult',toolCallId:tool.id,toolName:tool.name,content:[{type:'text',text:'hello'}],isError:false,timestamp:Date.now()};
  const second=await runtime.streamSimple(model,{messages:[user,first,toolResult],tools},options).result();assert.equal(second.stopReason,'stop',JSON.stringify(second));assert.equal(second.content.find(c=>c.type==='text').text,'OK');assert.equal(f.calls.at(-1).init.headers['X-Initiator'],'agent');
  results.push({api,toolCall:true,continuation:true,usage:second.usage});
 }
 console.log(JSON.stringify({runtimeRoot,results}));
}finally{await bridge?.close();if(management){management.closeAllConnections();await new Promise(r=>management.close(r));}await rm(dataDir,{recursive:true,force:true});}
