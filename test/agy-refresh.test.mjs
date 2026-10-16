import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {agyFixture} from '../fixtures/agy-account/upstream.mjs';
import {AgyAuth} from '../proxy/agy/auth.js';
async function fixture(t,loggedIn=false,options={}){const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-agy-auth-'));const f=agyFixture({dataDir,loggedIn,...options});await f.ready;t.after(async()=>{f.provider.close();await rm(dataDir,{recursive:true,force:true});});return{...f,dataDir};}

test('AGY browser OAuth shares callback validation and writes only its independent Keychain item',async t=>{
 const f=await fixture(t),login=await f.auth.login(),url=new URL(login.url),p=f.auth.pending;
 assert.equal(url.origin,'https://accounts.google.com');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('access_type'),'offline');assert(!login.url.includes(f.client.client_secret));
 for(const suffix of ['?code=x&state=wrong','?code=x&state='+p.state+'&state='+p.state])assert.equal((await fetch(p.redirectUri+suffix)).status,400);
 assert.equal(f.keys.size,0);assert.equal((await f.complete()).status,200);assert.equal((await f.auth.poll()).authorized,true);assert.deepEqual([...f.keys.keys()],['agy-oauth']);assert.equal(await f.auth.token(),'synthetic-access-1');
 const request=f.calls.find(x=>x.url.endsWith('/token'));const fields=new URLSearchParams(request.options.body);assert.equal(fields.get('code_verifier'),p.verifier);assert.equal(fields.get('client_secret'),f.client.client_secret);assert.equal(fields.get('redirect_uri'),p.redirectUri);
 await f.provider.listModels();assert.equal(f.provider.snapshot().account.login,'agy-user@example.test');
});
test('AGY cancellation, denial, expiry and close keep the existing account and release callbacks',async t=>{
 const f=await fixture(t,true),original=f.keys.get('agy-oauth');
 await f.auth.login();await f.auth.cancel();assert.equal(f.auth.listener,null);assert.equal(f.keys.get('agy-oauth'),original);
 await f.auth.login();let p=f.auth.pending;assert.equal((await fetch(p.redirectUri+'?'+new URLSearchParams({state:p.state,error:'access_denied'}))).status,400);assert.equal((await f.auth.poll()).status,'denied');
 await f.auth.login();f.advance(300001);p=f.auth.pending;assert.equal((await fetch(p.redirectUri+'?'+new URLSearchParams({state:p.state,code:'expired'}))).status,400);await f.auth.cancel();
 await f.auth.login();f.auth.close();assert.equal(f.auth.listener,null);await assert.rejects(f.auth.login(),/已关闭/);assert.equal(f.keys.get('agy-oauth'),original);
});
test('AGY independent refresh is deduplicated, rotates tokens and never reads or writes a CLI',async t=>{
 const f=await fixture(t,true,{readFileImpl:async()=>{throw Error('must not read CLI');},credentials:{get:async()=>{throw Error('must not read legacy Keychain');}}});f.advance(3600000);
 const result=await Promise.all([f.auth.token(),f.auth.token(),f.auth.token()]);assert.deepEqual(result,['synthetic-access-2','synthetic-access-2','synthetic-access-2']);assert.equal(f.calls.filter(c=>c.url.endsWith('/token')).length,1);assert.equal(JSON.parse(f.keys.get('agy-oauth')).refresh_token,'synthetic-refresh-2');
 const restarted=new AgyAuth({dataDir:f.dataDir,secrets:f.secrets,getOAuthClientImpl:async()=>f.client,fetchImpl:f.fetchImpl,now:()=>Date.now()+3600000});t.after(()=>restarted.close());assert.equal(await restarted.token(),'synthetic-access-2');
});
test('failed refresh and identity mismatch retain old credentials without exposing provider responses',async t=>{
 const f=await fixture(t,true),before=f.keys.get('agy-oauth');f.advance(3600000);f.auth.fetchImpl=async()=>Response.json({error:'invalid_grant',error_description:'SECRET'}, {status:400});await assert.rejects(f.auth.token(),e=>!e.message.includes('SECRET'));assert.equal(f.keys.get('agy-oauth'),before);
 f.auth.fetchImpl=f.fetchImpl;f.switchAccount();await assert.rejects(f.auth.token(),/账号身份/);assert.equal(f.keys.get('agy-oauth'),before);
});
test('logout wins over refresh and clears catalog/signatures without resurrecting a legacy login',async t=>{
 const f=await fixture(t,true);await f.provider.listModels();f.provider.signatures.set('old',{});const gate=Promise.withResolvers(),started=Promise.withResolvers(),fetchImpl=f.auth.fetchImpl;
 f.advance(3600000);f.auth.fetchImpl=async(...args)=>{if(args[0].endsWith('/token')){started.resolve();await gate.promise;}return fetchImpl(...args);};const refresh=f.auth.token();await started.promise;await f.auth.logout();gate.resolve();await assert.rejects(refresh);assert(!f.keys.has('agy-oauth'));assert.equal(f.provider.cache,undefined);assert.equal(f.provider.signatures.size,0);assert.equal((await f.provider.status()).connected,false);
});
for(const kind of ['file','keychain'])test('one-time '+kind+' legacy import preserves the original bytes and remains independent after restart',async t=>{
 const raw=JSON.stringify({auth_method:'consumer',metadata:{keep:true},token:{access_token:'old-access',refresh_token:'old-refresh',expiry:new Date(Date.now()+3600000).toISOString()}}),encoded='go-keyring-base64:'+Buffer.from(raw).toString('base64');let reads=0;
 const f=await fixture(t,false,{tokenFile:kind==='file'?'/synthetic/token':null,readFileImpl:async()=>{reads++;return raw;},credentials:{get:async()=>{reads++;return encoded;}}});assert.equal(await f.auth.token(),'old-access');assert.equal(reads,1);assert.equal(JSON.parse(f.keys.get('agy-oauth')).account.id,'agy-user');assert.equal(raw,JSON.stringify(JSON.parse(raw)));
 await f.auth.logout();await assert.rejects(f.auth.token());assert.equal(reads,1);
 const restarted=new AgyAuth({dataDir:f.dataDir,secrets:f.secrets,tokenFile:null,credentials:{get:async()=>{throw Error('must not reimport');}}});t.after(()=>restarted.close());await assert.rejects(restarted.token());
});
test('unreadable legacy credentials do not prevent independent browser login',async t=>{
 const f=await fixture(t,false,{credentials:{get:async()=>{throw Object.assign(Error('denied'),{code:'EKEYCHAIN_AUTH_FAILED'});}}});await assert.rejects(f.auth.token(),/网页登录/);await f.auth.login();assert.equal((await f.complete()).status,200);assert.equal(await f.auth.token(),'synthetic-access-1');
});
test('AGY 403 and missing project remain account failures while OAuth login stays saved',async t=>{
 const f=await fixture(t,true);f.fail(403);assert.match((await f.provider.status(true)).error,/权限或资格/);assert(f.keys.has('agy-oauth'));
 f.fail(0);f.provider.fetchImpl=async()=>Response.json({});assert.match((await f.provider.status(true)).error,/尚未完成开通/);assert(f.keys.has('agy-oauth'));
});
test('account change prevents a late AGY directory check from overwriting new state',async t=>{
 const f=await fixture(t,true),gate=Promise.withResolvers(),started=Promise.withResolvers(),request=f.provider.fetchImpl;
 f.provider.fetchImpl=async(...args)=>{if(args[0].endsWith('fetchAvailableModels')){started.resolve();await gate.promise;}return request(...args);};const check=f.provider.status();await started.promise;await f.auth.logout();gate.resolve();assert.equal((await check).connected,false);assert.equal(f.provider.cache,undefined);assert.equal(f.provider.lastError,null);
});

test('late AGY credential reads cannot send inference with a switched account',async t=>{
 const f=await fixture(t,true);await f.provider.listModels();const token=f.auth.token.bind(f.auth);let reads=0,sends=0;
 f.auth.token=async()=>{if(++reads===2)await f.auth.cancel();return token();};const fetchImpl=f.provider.fetchImpl;f.provider.fetchImpl=async(...args)=>{if(args[0].includes('streamGenerateContent'))sends++;return fetchImpl(...args);};
 const events=await Array.fromAsync(f.provider.stream({model:'agy-fixture',messages:[{role:'user',content:'hello'}],options:{}},{}));assert.equal(events.at(-1).type,'error');assert.equal(sends,0);
});
