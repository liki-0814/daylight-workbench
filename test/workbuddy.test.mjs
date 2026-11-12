import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkBuddyAuth} from '../proxy/workbuddy/auth.js';
import {WorkBuddyProvider} from '../proxy/workbuddy/provider.js';
const jwt=id=>`e30.${Buffer.from(JSON.stringify({sub:id})).toString('base64url')}.signature`;
async function fixture(t){
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-workbuddy-')),keys=new Map(),calls=[];
 const secrets={async get(id){return keys.get(id);},async set(id,value){keys.set(id,value);},async delete(id){keys.delete(id);}};
 let poll='pending',refreshId='one',chat;
 const fetchImpl=async(url,init={})=>{const u=new URL(url);calls.push({url:u,init});
  if(u.pathname.endsWith('/state'))return Response.json({code:0,data:{state:'state-1',authUrl:'https://www.workbuddy.cn/login?state=state-1'}});
  if(u.pathname.endsWith('/token'))return Response.json(poll==='pending'?{code:11217}:{code:0,data:{accessToken:jwt('one'),refreshToken:'secret-refresh',expiresIn:3600,domain:'www.workbuddy.cn'}});
  if(u.pathname.endsWith('/refresh'))return Response.json({code:0,data:{accessToken:jwt(refreshId),refreshToken:'secret-next',expiresIn:3600}});
  if(u.pathname.endsWith('/models'))return Response.json({code:0,data:{models:[{id:'fixture',maxInputTokens:4096,maxOutputTokens:512,supportsToolCall:true}],agents:[{name:'cli',models:['fixture']}]}});
  if(u.pathname.endsWith('/completions')){chat=JSON.parse(init.body);const delta=chat.tools?.length?{tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'probe',arguments:'{}'}}]}:{content:'ok'};return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:chat.tools?.length?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}
  return new Response('',{status:404});
 };
 const auth=new WorkBuddyAuth({dataDir,secrets,fetchImpl}),provider=new WorkBuddyProvider({dataDir,fetchImpl,auth});
 t.after(async()=>{provider.close();await rm(dataDir,{recursive:true,force:true});});
 return {auth,provider,calls,keys,authorize:()=>{poll='ok';auth.pending.nextPoll=0;},refreshIdentity:id=>{refreshId=id;},chat:()=>chat};
}
test('independent login, catalog, streaming and logout do not expose credentials',async t=>{
 const f=await fixture(t);const pending=await f.auth.login();assert.equal(pending.status,'pending');assert.equal((await f.auth.poll()).status,'pending');f.authorize();assert.equal((await f.auth.poll()).authorized,true);
 const models=await f.provider.listModels();assert.equal(models[0].id,'fixture');assert.equal(f.provider.snapshot().configured,true);assert.doesNotMatch(JSON.stringify(f.provider.snapshot()),/secret-refresh/);
 const output=await f.provider.execute({protocol:'chat',raw:{model:'fixture',stream:false,messages:[{role:'user',content:'hello'}]}});assert.equal(output.streaming,true);assert.equal(f.chat().stream,true);assert.match(await output.response.text(),/\[DONE\]/);
 await Promise.all([f.auth.refresh(),f.auth.refresh()]);assert.equal(f.calls.filter(c=>c.url.pathname.endsWith('/refresh')).length,1);await f.auth.logout();assert.equal(f.provider.snapshot().configured,false);await assert.rejects(f.provider.listModels());
});
test('refresh refuses a different account without replacing the stored session',async t=>{
 const f=await fixture(t);await f.auth.login();f.authorize();await f.auth.poll();const prior=await f.auth.sessions.get();f.refreshIdentity('other');await assert.rejects(f.auth.refresh());assert.equal(await f.auth.sessions.get(),prior);
});
test('a delayed catalog cannot be published after logout',async t=>{
 const f=await fixture(t);await f.auth.login();f.authorize();await f.auth.poll();const gate=Promise.withResolvers(),started=Promise.withResolvers(),base=f.provider.fetchImpl;
 f.provider.fetchImpl=async(url,options)=>{if(url.endsWith('/models')){started.resolve();await gate.promise;}return base(url,options);};const pending=f.provider.listModels();await started.promise;await f.auth.logout();gate.resolve();await assert.rejects(pending,/账号已变化/);assert.equal(f.provider.cache,undefined);
});

test('HTTP management and Skill client use the same WorkBuddy source',async t=>{
 const f=await fixture(t);await f.auth.login();f.authorize();await f.auth.poll();
 const {createWorkbench}=await import('../server.mjs'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const run=promisify(execFile),dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-workbuddy-http-'));
 const server=await createWorkbench({dataDir,proxyOptions:{provider:{listModels:async()=>[]},workbuddyProvider:f.provider,includeGateway:false,includeAgy:false,includeGrok:false,pricingOptions:{enabled:false}},extensionsOptions:{agentsRoot:path.join(dataDir,'agents'),home:dataDir,environment:{PATH:'/usr/bin:/bin'}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await server.closeProxy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dataDir,{recursive:true,force:true});});
 const url=`http://127.0.0.1:${server.address().port}`,client=async(...args)=>{const {stdout}=await run('python3',['skills/daylight-workbench/scripts/workbench.py','--url',url,'--data-dir',dataDir,...args]);assert.doesNotMatch(stdout,/secret-refresh|secret-next/);return JSON.parse(stdout);};
 const capability=await client('capabilities');assert.ok(capability.proxy);const state=await client('proxy-state');assert(state.sources.some(source=>source.id==='workbuddy'));
 const discovered=await client('proxy-discover','--source','workbuddy');assert.match(JSON.stringify(discovered),/fixture/);
 const login=await client('proxy-login-state','--source','workbuddy');assert.doesNotMatch(JSON.stringify(login),/secret-refresh/);
 const actionFile=path.join(dataDir,'action.json');await writeFile(actionFile,JSON.stringify({type:'auth.refresh',sourceId:'workbuddy'}));const current=await client('proxy-state');assert.equal((await client('proxy-prepare','--file',actionFile)).action.sourceId,'workbuddy');assert.equal((await client('proxy-apply','--file',actionFile,'--expected-version',current.version,'--request-id','workbuddy-refresh-fixture')).ok,true);
 const token=(await(await fetch(url+'/api/state')).json()).token;
 const api=async(route,body)=>{const r=await fetch(url+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-workbench-token':token},...(body?{body:JSON.stringify(body)}:{})});assert.equal(r.status,200);return r.json();};
 const net=await import('node:net'),reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 await api('/api/proxy/settings',{port,autoStart:false});await api('/api/proxy/service',{enabled:true});const key=(await api('/api/proxy/key')).apiKey;
 const request=async(route,body)=>fetch(`http://127.0.0.1:${port}/v1/${route}`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const chat=await request('chat/completions',{model:'fixture',stream:false,messages:[{role:'user',content:'hello'}]});assert.equal(chat.status,200);assert.equal((await chat.json()).choices[0].message.content,'ok');
 const converted=await request('responses',{model:'fixture',stream:true,input:'hello'});assert.equal(converted.status,200);assert.match(await converted.text(),/response.output_text.delta/);
 const tool=await request('chat/completions',{model:'fixture',stream:true,messages:[{role:'user',content:'hello'}],tools:[{type:'function',function:{name:'probe',parameters:{type:'object'}}}]});assert.equal(tool.status,200);assert.match(await tool.text(),/tool_calls/);

});

test('cancel during a pending poll and logout during refresh cannot restore credentials',async t=>{
 const f=await fixture(t),base=f.auth.fetchImpl;
 let gate=Promise.withResolvers(),started=Promise.withResolvers();
 f.auth.fetchImpl=async(url,options)=>{if(url.includes('/token?')){started.resolve();await gate.promise;}return base(url,options);};
 await f.auth.login();f.authorize();const polling=f.auth.poll();await started.promise;await f.auth.cancel();gate.resolve();assert.equal((await polling).status,'cancelled');assert.equal(f.keys.size,0);
 f.auth.fetchImpl=base;await f.auth.login();f.authorize();await f.auth.poll();gate=Promise.withResolvers();started=Promise.withResolvers();
 f.auth.fetchImpl=async(url,options)=>{if(url.endsWith('/refresh')){started.resolve();await gate.promise;}return base(url,options);};
 const refreshing=f.auth.refresh();await started.promise;await f.auth.logout();gate.resolve();await assert.rejects(refreshing);assert.equal(f.keys.size,0);
});

test('rejects an authorization URL that leaves the trusted login origin or changes state',async t=>{
 for(const authUrl of ['https://attacker.example/login?state=state-1','https://www.workbuddy.cn/login?state=other']){
  const f=await fixture(t);f.auth.fetchImpl=async()=>Response.json({code:0,data:{state:'state-1',authUrl}});await assert.rejects(f.auth.login());assert.equal(f.auth.pending,null);assert.equal(f.keys.size,0);
 }
});
