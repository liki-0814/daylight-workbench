import test from 'node:test';
import assert from 'node:assert/strict';
import {loadOAuthClient} from '../proxy/agy/oauth-client.js';
import {scanClient,discoverOAuthClient,clientCandidates} from '../proxy/agy/client-discovery.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
test('AGY loads OAuth parameters from the selected local configuration and excludes unrelated fields',async()=>{
 let read;
 const client=await loadOAuthClient('gcp',{file:'/private/local-config.json',readFileImpl:async file=>{read=file;return JSON.stringify({gcp:{client_id:'fixture-id',client_secret:'fixture-secret',extra:'ignored'}});}});
 assert.equal(read,'/private/local-config.json');assert.deepEqual(client,{client_id:'fixture-id',client_secret:'fixture-secret'});
});

test('missing default configuration automatically discovers the installed client, but explicit broken configuration stays explicit',async()=>{
 const missing=async()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'});};let calls=0;
 const discoverClientImpl=async method=>{calls++;assert.equal(method,'consumer');return{client_id:'fixture-id',client_secret:'fixture-secret'};};
 const client=await loadOAuthClient('consumer',{readFileImpl:missing,discoverClientImpl,env:{},home:'/fixture-home'});
 assert.equal(client.client_id,'fixture-id');assert.equal(calls,1);
 await assert.rejects(loadOAuthClient('consumer',{file:'/explicit/config.json',readFileImpl:missing,discoverClientImpl}),/指定配置文件/);assert.equal(calls,1);
 await assert.rejects(loadOAuthClient('consumer',{readFileImpl:missing,discoverClientImpl,autoDiscover:false,env:{},home:'/fixture-home'}),{code:'EAGY_OAUTH_CLIENT_CONFIG'});assert.equal(calls,1);
});

test('installed client scan requires both known fingerprints and handles a chunk boundary without executing the client',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'agy-client-discovery-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const file=path.join(directory,'agy'),client={client_id:'12345-fixtureclient.apps.googleusercontent.com',client_secret:'GOCSPX-'+ 'f'.repeat(28)};
 const fingerprints=Object.fromEntries(Object.entries(client).map(([key,value])=>[key,createHash('sha256').update(value).digest('hex')]));
 await writeFile(file,Buffer.concat([Buffer.alloc(1024*1024-10),Buffer.from(client.client_id+'\0unrelated-client\0'+client.client_secret)]));
 assert.deepEqual(await scanClient(file,fingerprints),client);
 assert.equal(await scanClient(file,{...fingerprints,client_secret:'unknown'}),null);
 const scanned=[];assert.deepEqual(await discoverOAuthClient('consumer',{candidates:['missing',file],scan:async candidate=>{scanned.push(candidate);if(candidate==='missing')throw Error('missing');return scanClient(candidate,fingerprints);}}),client);
 assert.deepEqual(scanned,['missing',file]);
 assert.equal(await discoverOAuthClient('gcp',{scan:async()=>{throw Error('must not guess another client');}}),null);
 const candidates=clientCandidates({env:{PATH:'/fixture/bin'},home:'/fixture-home'});assert(candidates.includes('/fixture-home/.local/bin/agy'));assert(candidates.includes('/Applications/Antigravity.app/Contents/Resources/bin/language_server'));
});
test('unsupported AGY login methods do not read a credential file',async()=>{
 assert.equal(await loadOAuthClient('wif',{readFileImpl:async()=>{throw Error('must not read');}}),null);
});
test('missing or malformed OAuth configuration fails safely without leaking contents',async()=>{
 for(const readFileImpl of [async()=>{throw Error('private-content');},async()=>'{private-content',async()=>JSON.stringify({consumer:{client_id:'fixture',client_secret:''}})]){
  await assert.rejects(loadOAuthClient('consumer',{readFileImpl}),error=>error.code==='EAGY_OAUTH_CLIENT_CONFIG'&&!error.message.includes('private-content'));
 }
});
