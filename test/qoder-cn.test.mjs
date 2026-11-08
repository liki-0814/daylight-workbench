import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {QoderCNProvider,CNAccountStore,loadCNConfig} from '../proxy/qoder/cn.js';
import {QoderHttp} from '../proxy/qoder/transport.js';

const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const frame=value=>`data: ${JSON.stringify({body:JSON.stringify(value)})}\n\n`;
async function fixture(t){
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-qodercn-test-')),memory=new Map(),calls=[];
 t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const secrets={get:async id=>memory.get(id),set:async(id,value)=>memory.set(id,value),delete:async id=>memory.delete(id)};
 let pending=true;
 const fetch=async(url,options={})=>{
  const u=new URL(url);calls.push({url:u,options});
  if(u.pathname.endsWith('/deviceToken/poll'))return pending?json({},404):json({token:'private-token',refresh_token:'private-refresh',uid:'cn-user',expires_at:'2099-01-01T00:00:00Z'});
  if(u.pathname.endsWith('/user/status'))return json({uid:'cn-user'});
  if(u.pathname.endsWith('/getDataPolicy'))return json({policy:'test'});
  if(u.pathname.endsWith('/model/list'))return json({assistant:[{key:'m',display_name:'Model',format:'openai'}]});
  if(u.pathname.endsWith('/agent_chat_generation'))return new Response(frame({choices:[{delta:{content:'OK'},finish_reason:null}]})+frame({choices:[{delta:{},finish_reason:'stop'}]})+'event: finish\ndata: {}\n\n');
  throw Error('unexpected endpoint '+u.pathname);
 };
 const config=loadCNConfig(dataDir),accounts=new CNAccountStore({dataDir,secrets}),provider=new QoderCNProvider(config,new QoderHttp(config,fetch),accounts);
 t.after(()=>provider.close());return{dataDir,provider,accounts,memory,calls,authorize:()=>{pending=false;},secrets};
}
test('CN login, catalog, inference and logout isolate credentials and endpoints',async t=>{
 const f=await fixture(t),{provider:p}=f;const login=await p.auth.login();assert.equal(new URL(login.url).origin,'https://qoder.cn');
 assert.deepEqual(await p.auth.poll(),{authorized:false});f.authorize();assert.equal((await p.auth.poll()).authorized,true);
 const poll=f.calls.find(c=>c.url.pathname.endsWith('/deviceToken/poll'));assert.equal(poll.url.origin,'https://openapi.qoder.com.cn');assert.equal(poll.url.searchParams.get('challenge_method'),'S256');
 assert.equal((await p.listModels())[0].id,'m');const catalog=f.calls.find(c=>c.url.pathname.endsWith('/model/list'));assert.equal(catalog.url.origin,'https://gateway.qoder.com.cn');
 const result=await p.execute({raw:{model:'m',messages:[{role:'user',content:'hello'}],stream:true},protocol:'chat'},{signal:AbortSignal.timeout(2000)});const events=[];for await(const e of result.events)events.push(e.type);assert.ok(events.includes('finish'));assert.ok(!events.includes('error'));
 const state=await readFile(path.join(f.dataDir,'proxy/credentials/qoder-cn-oauth.json'),'utf8');assert.ok(!state.includes('private-token'));assert.ok([...f.memory.values()].some(x=>x.includes('private-token')));
 assert.equal((await new CNAccountStore({dataDir:f.dataDir,secrets:f.secrets}).load()).credential.uid,'cn-user');
 await p.auth.logout();assert.equal(await f.accounts.load(),null);assert.equal(await new CNAccountStore({dataDir:f.dataDir,secrets:f.secrets}).load(),null);
});
test('cancel while credential storage waits cannot publish the login',async t=>{
 const f=await fixture(t);let release,started;const waiting=new Promise(r=>release=r),entered=new Promise(r=>started=r);
 f.secrets.set=async(id,value)=>{started();await waiting;f.memory.set(id,value);};
 await f.provider.auth.login();f.authorize();const polling=f.provider.auth.poll();await entered;await f.provider.auth.cancel();release();await assert.rejects(polling);
 assert.equal(await new CNAccountStore({dataDir:f.dataDir,secrets:f.secrets}).load(),null);
});

test('Agent client discovers CN and applies a versioned setting once over HTTP',async t=>{
 const f=await fixture(t);await f.provider.auth.login();f.authorize();await f.provider.auth.poll();
 const {createWorkbench}=await import('../server.mjs');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {writeFile}=await import('node:fs/promises');
 const server=await createWorkbench({dataDir:f.dataDir,proxyOptions:{qoderCNProvider:f.provider,includeGateway:false,includeAgy:false,includeGrok:false,provider:{listModels:async()=>[],execute:async()=>({kind:'events',events:[]})}},extensionsOptions:{agentsRoot:path.join(f.dataDir,'agents'),home:f.dataDir,environment:{PATH:'/usr/bin:/bin'}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await server.closeProxy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const base=`http://127.0.0.1:${server.address().port}`,client=path.resolve('skills/daylight-workbench/scripts/workbench.py'),run=promisify(execFile);
 const call=async(...args)=>JSON.parse((await run('python3',[client,'--url',base,'--data-dir',f.dataDir,...args])).stdout);
 const denied=await fetch(base+'/api/v1/proxy/state');assert.equal(denied.status,401);
 const state=await call('proxy-state');assert.ok(state.sources.some(s=>s.id==='qoder-cn'));assert.equal((await call('proxy-discover','--source','qoder-cn')).models[0].id,'model');
 const file=path.join(f.dataDir,'action.json');await writeFile(file,JSON.stringify({type:'model.setting',sourceId:'qoder-cn',id:'model',field:'enabled',value:false}));
 assert.equal((await call('proxy-prepare','--file',file)).action.sourceId,'qoder-cn');
 const args=['proxy-apply','--file',file,'--expected-version',state.version,'--request-id','cn-test-setting-1'];
 assert.equal((await call(...args)).ok,true);assert.equal((await call(...args)).replayed,true);
 assert.equal((await call('proxy-discover','--source','qoder-cn')).models[0].enabled,false);
});

test('credential repair publishes only after silent verification and remains usable after restart',async t=>{
 const f=await fixture(t);await f.provider.auth.login();f.authorize();await f.provider.auth.poll();
 const calls=[];const original=f.secrets.get;f.secrets.get=async(id,options)=>{calls.push(options?.interactive);return original(id,options);};
 const result=await f.provider.auth.repair();assert.equal(result.credentialRepaired,true);assert.deepEqual(calls,[true,false]);
 assert.equal((await new CNAccountStore({dataDir:f.dataDir,secrets:f.secrets}).load()).credential.uid,'cn-user');
});
