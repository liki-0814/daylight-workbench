import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {AgyAuth} from '../proxy/agy/auth.js';

const fixtureClient=method=>['consumer','gcp'].includes(method)?{client_id:'fixture.apps.googleusercontent.com',client_secret:'fixture-secret'}:null;
const profile=(expiry=1)=>({auth_method:'consumer',id_token:'identity',metadata:{keep:true},token:{access_token:'old-access',refresh_token:'old-refresh',token_type:'Bearer',expiry:new Date(expiry).toISOString()}});
const json=(value,status=200)=>new Response(JSON.stringify(value),{status});
const noKeychain={get:async()=>{throw Error('must not read keychain');}};

test('expired AGY login refreshes once concurrently, atomically saves rotated tokens and survives restart',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agy-refresh-'));t.after(()=>rm(dir,{recursive:true,force:true}));const tokenFile=path.join(dir,'antigravity-oauth-token');
 await writeFile(tokenFile,JSON.stringify(profile()),{mode:0o600});let requests=0;
 const fetchImpl=async(url,options)=>{
  requests++;assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(options.redirect,'error');assert.equal(options.method,'POST');assert.equal(options.body.get('grant_type'),'refresh_token');assert.equal(options.body.get('refresh_token'),'old-refresh');assert.match(options.body.get('client_id'),/\.apps\.googleusercontent\.com$/);assert.equal(options.signal.aborted,false);
  return json({access_token:'new-access',refresh_token:'rotated-refresh',id_token:'new-identity',expires_in:3600,token_type:'Bearer'});
 };
 const auth=new AgyAuth({getOAuthClientImpl:fixtureClient,tokenFile,fetchImpl,credentials:noKeychain});assert.deepEqual(await Promise.all([auth.token(),auth.token(),auth.token()]),['new-access','new-access','new-access']);assert.equal(requests,1);
 const stored=JSON.parse(await readFile(tokenFile,'utf8'));assert.equal(stored.token.refresh_token,'rotated-refresh');assert.equal(stored.id_token,'new-identity');assert.deepEqual(stored.metadata,{keep:true});assert.equal(stored.auth_method,'consumer');assert.ok(Date.parse(stored.token.expiry)>Date.now()+3500000);assert.equal((await stat(tokenFile)).mode&0o777,0o600);assert.deepEqual(await readdir(dir),['antigravity-oauth-token']);
 const restarted=new AgyAuth({getOAuthClientImpl:fixtureClient,tokenFile,fetchImpl,credentials:noKeychain});assert.equal(await restarted.token(),'new-access');assert.equal(requests,1);
});

test('refresh preserves refresh token and identity when Google omits them',async()=>{
 let stored=profile(),writes=0;
 const auth=new AgyAuth({getOAuthClientImpl:fixtureClient,readFileImpl:async()=>JSON.stringify(stored),credentials:noKeychain,writeJsonImpl:async(_,value)=>{stored=value;writes++;},fetchImpl:async()=>json({access_token:'new',expires_in:3600})});
 assert.equal(await auth.token(),'new');assert.equal(writes,1);assert.equal(stored.token.refresh_token,'old-refresh');assert.equal(stored.id_token,'identity');
});

test('temporary refresh errors retain valid near-expiry token, back off and retry after expiry without leaking responses',async()=>{
 let now=100000,stored=profile(now+45000),requests=0,writes=0;
 const auth=new AgyAuth({getOAuthClientImpl:fixtureClient,now:()=>now,readFileImpl:async()=>JSON.stringify(stored),credentials:noKeychain,writeJsonImpl:async(_,v)=>{writes++;stored=v;},fetchImpl:async()=>{requests++;return requests===1?json({error_description:'old-refresh SECRET'},503):json({access_token:'recovered',expires_in:3600});}});
 assert.equal(await auth.token(),'old-access');assert.equal(await auth.token(),'old-access');assert.equal(requests,1);assert.equal(writes,0);now+=46000;assert.equal(await auth.token(),'recovered');assert.equal(requests,2);assert.equal(writes,1);
});

test('invalid refresh grants stop quietly, retain credentials and do not repeatedly call Google',async()=>{
 const stored=profile();let requests=0,writes=0;
 const auth=new AgyAuth({getOAuthClientImpl:fixtureClient,readFileImpl:async()=>JSON.stringify(stored),credentials:noKeychain,writeJsonImpl:async()=>{writes++;},fetchImpl:async()=>{requests++;return json({error:'invalid_grant',error_description:'old-refresh SECRET'},400);}});
 for(let i=0;i<2;i++)await assert.rejects(auth.token(),e=>e.code==='EAGY_REAUTH_REQUIRED'&&!e.message.includes('SECRET')&&e.message.includes('未打开授权窗口'));
 assert.equal(requests,1);assert.equal(writes,0);assert.equal(stored.token.access_token,'old-access');
});

test('network failure and invalid refresh payload never overwrite the login file or expose credentials',async()=>{
 for(const fetchImpl of [async()=>{throw Error('old-refresh SECRET');},async()=>json({access_token:'bad',expires_in:0}),async()=>new Response('not json')]){
  let writes=0;const auth=new AgyAuth({getOAuthClientImpl:fixtureClient,readFileImpl:async()=>JSON.stringify(profile()),credentials:noKeychain,writeJsonImpl:async()=>{writes++;},fetchImpl});
  await assert.rejects(auth.token(),e=>e.code==='EAGY_REFRESH_FAILED'&&!e.message.includes('SECRET'));assert.equal(writes,0);
 }
});

test('CLI account switch, concurrent refresh or logout wins over an in-flight refresh',async()=>{
 for(const change of ['refresh','switch','logout']){
  let stored=profile(),writes=0;
  const auth=new AgyAuth({getOAuthClientImpl:fixtureClient,readFileImpl:async()=>{if(stored===null)throw Object.assign(Error(),{code:'ENOENT'});return JSON.stringify(stored);},credentials:noKeychain,writeJsonImpl:async()=>{writes++;},fetchImpl:async()=>{stored=change==='logout'?null:profile(Date.now()+3600000);if(stored)stored.token.access_token=change==='switch'?'different-account':'cli-renewed';return json({access_token:'stale-refresh',expires_in:3600});}});
  if(change==='logout')await assert.rejects(auth.token(),{code:'EAGY_PROFILE_CHANGED'});else assert.equal(await auth.token(),stored?.token.access_token);
  assert.equal(writes,0);
 }
});

test('save failure reports a private error and unknown auth methods never fall back to another OAuth client',async()=>{
 const auth=new AgyAuth({getOAuthClientImpl:fixtureClient,readFileImpl:async()=>JSON.stringify(profile()),credentials:noKeychain,writeJsonImpl:async()=>{throw Error('SECRET');},fetchImpl:async()=>json({access_token:'new',expires_in:3600})});
 await assert.rejects(auth.token(),e=>e.code==='EAGY_REFRESH_FAILED'&&e.message.includes('保存失败')&&!e.message.includes('SECRET'));
 let requests=0;const other={...profile(),auth_method:'wif'};const unsupported=new AgyAuth({getOAuthClientImpl:fixtureClient,readFileImpl:async()=>JSON.stringify(other),credentials:noKeychain,fetchImpl:async()=>{requests++;}});
 await assert.rejects(unsupported.token(),/不支持静默刷新/);assert.equal(requests,0);
});
