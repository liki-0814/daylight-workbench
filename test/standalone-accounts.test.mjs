import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {accountFixture,jwt,jwk} from '../fixtures/standalone-accounts/upstream.mjs';
import {verifyIdentity} from '../proxy/shared/oidc.js';
import {trustedURL} from '../proxy/shared/oauth-account.js';
import {createProxyState} from '../public/proxy/state.js';
import {createProxyTools} from '../proxy/shared/tools.js';
async function setup(t,id,loggedIn=false){const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-independent-'));const f=accountFixture({id,dataDir,loggedIn});await f.ready;t.after(async()=>{f.provider.close();await rm(dataDir,{recursive:true,force:true});});return{...f,dataDir};}
const safe=value=>assert.doesNotMatch(JSON.stringify(value),/synthetic-.*(?:access|refresh)|synthetic-device-secret|synthetic-code/);
for(const id of ['kimi','grok','codex']){
 test(id+' logs in independently, exposes the account, refreshes, cancels and logs out only its own credential',async t=>{
  const f=await setup(t,id);await writeFile(path.join(f.dataDir,'cli-auth.json'),'unchanged');
  const login=await f.auth.login();safe(login);assert.equal(login.status,'pending');assert(new URL(login.url).protocol==='https:');
  await f.completeLogin();const result=id==='codex'?await f.auth.poll():{authorized:true};assert.equal(result.authorized,true);assert.match(f.auth.account.login,new RegExp(id));
  const rows=await f.provider.listModels();assert.equal(rows.length,1);assert.equal(f.provider.snapshot().configured,true);safe(f.provider.snapshot());
  const before=f.keys.get(id+'-oauth');await Promise.all([f.auth.refresh(),f.auth.refresh()]);assert.notEqual(f.keys.get(id+'-oauth'),before);assert.equal(f.calls.filter(c=>new URLSearchParams(c.options.body).get('grant_type')==='refresh_token').length,1);
  await f.auth.login();await f.auth.cancel();assert.equal(await f.auth.poll(),null);assert(f.keys.has(id+'-oauth'));
  await f.auth.logout();assert.equal(f.keys.has(id+'-oauth'),false);assert.equal(f.provider.snapshot().connected,false);await assert.rejects(f.provider.listModels(),{status:401});assert.equal(await readFile(path.join(f.dataDir,'cli-auth.json'),'utf8'),'unchanged');
 });
 test(id+' cancellation during credential renewal cannot restore a logged-out account',async t=>{
  const f=await setup(t,id,true);let release,started;const wait=new Promise(r=>{release=r;}),start=new Promise(r=>{started=r;}),request=f.auth.request.bind(f.auth);
  f.auth.request=async(...args)=>{started();await wait;return request(...args);};const renewal=f.auth.refresh();await start;await f.auth.logout();release();await assert.rejects(renewal,/登录/);assert.equal(f.keys.size,0);
 });
 test(id+' HTTP discovery errors retain credentials and unknown quota is not zero',async t=>{
  const f=await setup(t,id,true);await f.provider.listModels();f.failModels(true);assert.equal((await f.provider.status(true)).connected,false);assert.equal(f.keys.size,1);f.failModels(false);assert.equal((await f.provider.status(true)).connected,true);
  const q=await f.provider.quota();safe(q);if(id==='codex'){assert.deepEqual(q.buckets,[]);assert.match(q.message,/暂未提供/);}else assert(q.buckets.length);
 });
}
for(const id of ['kimi','grok'])test(id+' device polls respect pending, slowdown, denial and expiry',async t=>{
 const f=await setup(t,id);await f.auth.login();const count=f.calls.length;await f.auth.poll();assert.equal(f.calls.length,count);
 f.deny('slow_down');f.advance(5000);assert.equal((await f.auth.poll()).interval,10);f.advance(5000);await f.auth.poll();assert.equal(f.calls.length,count+1);
 f.deny('authorization_pending');f.advance(5000);assert.equal((await f.auth.poll()).status,'pending');f.deny('access_denied');f.advance(10000);assert.equal((await f.auth.poll()).status,'denied');assert.equal(f.keys.size,0);
 await f.auth.login();f.advance(900000);assert.equal((await f.auth.poll()).status,'expired');
});
test('OIDC requires a valid signature, issuer, audience, nonce, expiry and stable account',async()=>{
 const issuer='https://auth.openai.com',claims={iss:issuer,sub:'account',aud:'oaiapp_fixture',nonce:'nonce',exp:Math.floor(Date.now()/1000)+3600},opts={issuer,clientId:'oaiapp_fixture',nonce:'nonce',metadata:{issuer,jwks_uri:issuer+'/jwks'},fetchImpl:async()=>Response.json({keys:[jwk]})};
 assert.equal((await verifyIdentity(jwt(claims),opts)).sub,'account');
 for(const patch of [{iss:'https://evil.example'},{aud:'other'},{nonce:'wrong'},{exp:0},{sub:''}])await assert.rejects(verifyIdentity(jwt({...claims,...patch}),opts));
 await assert.rejects(verifyIdentity(jwt(claims).slice(0,-5)+'xxxxx',opts));await assert.rejects(verifyIdentity(jwt(claims),{...opts,subject:'other-account'}));
 for(const url of ['http://auth.x.ai/token','https://auth.x.ai@evil.example/token','https://evil.example/token'])assert.throws(()=>trustedURL(url,['x.ai']));
});
test('ChatGPT callback rejects invalid state and client changes, and retains registration before exchange',async t=>{
 const f=await setup(t,'codex');const login=await f.auth.login(),url=new URL(login.url);assert.equal(url.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(url.searchParams.get('agent_name_hint'),'Daylight');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 const p=f.auth.pending;let r=await fetch(p.redirectUri+'?code=x&state=wrong&client_id=oaiapp_fixture');assert.equal(r.status,400);assert.equal(f.keys.size,0);
 await f.completeLogin();assert.equal((await f.auth.poll()).authorized,true);const host=JSON.parse(await readFile(path.join(f.dataDir,'codex-proxy/host.json'),'utf8'));assert.equal(host.pendingClientId,'oaiapp_fixture');
 const again=await f.auth.login();assert.equal(new URL(again.url).searchParams.get('client_id'),'oaiapp_fixture');assert.equal(new URL(again.url).searchParams.get('ext_agent_host_id'),host.hostId);
 r=await fetch(f.auth.pending.redirectUri+'?'+new URLSearchParams({code:'x',state:f.auth.pending.state,client_id:'oaiapp_other'}));assert.equal(r.status,400);await f.auth.cancel();
});
test('Codex public Responses preserves namespace tools and retries a 401 exactly once',async t=>{
 const f=await setup(t,'codex',true);await f.provider.listModels();let sends=0,body;const fetchImpl=f.provider.fetchImpl;f.provider.fetchImpl=async(url,options)=>{if(url.endsWith('/responses')){sends++;body=JSON.parse(options.body);assert.equal(url,'https://api.openai.com/v1/responses');assert(!options.headers['chatgpt-account-id']);if(sends===1)return Response.json({}, {status:401});}return fetchImpl(url,options);};
 await f.provider.forward({model:'codex-fixture',input:'Hi',tools:[{type:'function',name:'echo',parameters:{type:'object'}}]},'responses',{});assert.equal(sends,2);assert.equal(body.tools[0].type,'namespace');assert.equal(body.store,false);assert.equal(body.stream,true);
 await assert.rejects(f.provider.forward({model:'codex-fixture',input:'Hi',max_output_tokens:32},'responses',{}),/max_output_tokens/);
});
test('six account descriptions expose the shared login, refresh and logout operations',async t=>{
 const {sourceDescription:qoder}=await import('../proxy/qoder/provider.js'),{sourceDescription:copilot}=await import('../proxy/copilot/provider.js');
 for(const source of [qoder,copilot,...await Promise.all(['agy','kimi','grok','codex'].map(async id=>(await import('../proxy/'+id+'/provider.js')).sourceDescription))]){assert.equal(source.authentication.mode,'browser');for(const op of ['login','poll','cancel','refresh','logout'])assert(source.authentication.operations.includes(op));}
});

test('cancel and logout supersede a pending UI login poll without restoring its result',async()=>{
 for(const op of ['cancel','logout']){
  const poll=Promise.withResolvers(),started=Promise.withResolvers();
  const store=createProxyState({request:async name=>name==='status'?{state:'stopped'}:{sources:[]},source:async(id,operation)=>{if(operation==='auth/login')return{url:'https://auth.example.test',expiresAt:Date.now()+60000};if(operation==='auth/poll'){started.resolve();return poll.promise;}return{status:'cancelled'};}});
  await store.auth('kimi','login');const work=store.pollLogins();await started.promise;await store.auth('kimi',op);poll.resolve({status:'authenticated',authorized:true});await work;assert.equal(store.login('kimi'),undefined);store.dispose();
 }
});
test('AI account management supports refresh and removes retained ID tokens from login links',async t=>{
 const f=await setup(t,'codex',true),calls=[];
 const tools=createProxyTools({dataDir:f.dataDir,getSources:async()=>[{id:'codex',authentication:{operations:['login','poll','refresh']}}],call:async route=>{calls.push(route);if(route==='/api/proxy/status')return{state:'stopped'};if(route.endsWith('/models'))return{models:[]};if(route.endsWith('/status'))return{connected:false};if(route.endsWith('/auth/refresh'))return{connected:true};return{status:'pending',url:'https://auth.openai.com/authorize?state=public&id_token_hint=private-retained-id',access_token:'private-access'};}});
 const draft=await tools.prepare({action:{type:'auth.refresh',sourceId:'codex'}});const state=await tools.state();await tools.apply({action:draft.action,expectedVersion:state.version,requestId:'refresh-codex'});assert(calls.some(c=>c.endsWith('/auth/refresh')));
 const login=await tools.loginState({sourceId:'codex'});assert.doesNotMatch(JSON.stringify(login),/private-|id_token_hint|access_token/);assert.match(login.login.url,/state=public/);
});

for(const id of ['kimi','grok','codex'])test(id+' cannot publish a catalog response after logout',async t=>{
 const f=await setup(t,id,true),pending=Promise.withResolvers(),started=Promise.withResolvers(),request=f.provider.fetchImpl;
 f.provider.fetchImpl=async(url,options)=>{if(url.endsWith('/models')){started.resolve();await pending.promise;}return request(url,options);};
 const models=f.provider.listModels();await started.promise;await f.auth.logout();pending.resolve();await assert.rejects(models);assert.equal(f.provider.cache,undefined);assert.equal(f.provider.snapshot().configured,false);
});
test('ChatGPT identity-only consent is saved without allowing inference and can be reauthorized',async t=>{
 const f=await setup(t,'codex');const request=f.auth.request.bind(f.auth);f.auth.request=async(...args)=>{const data=await request(...args);return data.access_token?{...data,scope:'openid profile email offline_access'}:data;};
 await f.auth.login();await f.completeLogin();assert.equal((await f.auth.poll()).authorized,true);assert.equal(f.auth.account.id,'codex-user');await assert.rejects(f.auth.read(),/未授权套餐/);
 const login=await f.auth.refresh();assert.equal(login.status,'pending');assert.equal(new URL(login.url).searchParams.get('client_id'),'oaiapp_fixture');
});
