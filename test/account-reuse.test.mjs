import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fixture} from '../fixtures/copilot/upstream.mjs';
import {accountFixture} from '../fixtures/standalone-accounts/upstream.mjs';
import {proxySources,proxySourceTabs,piSourceTypes,proxySourceNames} from '../core/proxy-sources.js';
import {proxyTabs} from '../public/proxy/source-navigation.js';
import {createManagement} from '../proxy/management.js';

for(const id of ['copilot','kimi','grok','codex'])test(id+' relogin starts a fresh catalog without waiting for previous login requests',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-account-reuse-')),f=id==='copilot'?fixture({dataDir,loggedIn:true}):accountFixture({id,dataDir,loggedIn:true});await f.ready;f.p||=f.provider;
 t.after(async()=>{f.p.close();await rm(dataDir,{recursive:true,force:true});});
 await f.p.listModels();
 const wait=Promise.withResolvers(),entered=Promise.withResolvers(),request=f.p.fetchImpl;let held=false;
 f.p.fetchImpl=async(url,options)=>{if(url.endsWith('/models')&&!held){held=true;entered.resolve();await wait.promise;}return request(url,options);};
 const previous=f.p.status(true);await entered.promise;
 await f.auth.logout();const cleared=!f.p.cache;
 await f.auth.login();if(id==='copilot'){f.advance(5000);await f.auth.poll();}else await f.completeLogin();
 let timer;const fresh=f.p.status(true),ready=await Promise.race([fresh.then(r=>r.connected),new Promise(r=>{timer=setTimeout(()=>r(false),1000);})]);clearTimeout(timer);
 wait.resolve();await previous;await fresh;
 assert(cleared,'logout must invalidate the provider catalog');assert(ready,'new login must not wait for old discovery');
 assert.equal(f.p.snapshot().connected,true,'late old failure must not overwrite the new account status');
});

test('source navigation and Pi filters share all source IDs while keeping labels and ordering',()=>{
 const expected=proxySources.map(s=>s.id).sort();
 assert.deepEqual(proxyTabs.filter(s=>s.kind!=='utility').map(s=>s.id).sort(),expected);
 assert.deepEqual(piSourceTypes.filter(s=>s.id!=='all').map(s=>s.id).sort(),expected);
 assert.equal(proxySourceNames.copilot,'GitHub Copilot');assert.equal(proxySourceTabs.find(s=>s.id==='copilot').name,'Copilot');
 assert.equal(proxyTabs[0].id,'qoder');assert.equal(piSourceTypes[1].id,'codex');
});
test('reading and renewing a pre-refactor Copilot login preserves its exact Keychain record',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-legacy-copilot-')),f=fixture({dataDir,loggedIn:true});t.after(async()=>{f.p.close();await rm(dataDir,{recursive:true,force:true});});
 const before=f.keys.get('copilot-oauth');await f.p.listModels();const cached=f.p.cache;
 await f.auth.refresh();assert.equal(f.keys.get('copilot-oauth'),before);assert.strictEqual(f.p.cache,cached);assert.equal(f.auth.account.login,'fixture-user');
});
for(const id of ['copilot','kimi','grok'])test(id+' device cancellation cannot overwrite a newer pending login',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-device-reuse-')),f=id==='copilot'?fixture({dataDir}):accountFixture({id,dataDir});const p=f.p||f.provider;
 t.after(async()=>{p.close();await rm(dataDir,{recursive:true,force:true});});await f.auth.login();f.advance(5000);
 const waiting=Promise.withResolvers(),entered=Promise.withResolvers(),profile=f.auth.profile.bind(f.auth);
 f.auth.profile=async(...args)=>{entered.resolve();await waiting.promise;return profile(...args);};
 const old=f.auth.poll();await entered.promise;await f.auth.cancel();await f.auth.login();const pending=f.auth.pending;
 waiting.resolve();assert.equal((await old).status,'cancelled');assert.strictEqual(f.auth.pending,pending);assert.equal(f.keys.size,0);
});
test('management ignores stale account status instead of invalidating the new router catalog',async()=>{
 const waiting=Promise.withResolvers(),entered=Promise.withResolvers(),writes=[],p={auth:{epoch:0},status:async()=>{entered.resolve();await waiting.promise;return{connected:false,error:'old failure'};}};
 const management=createManagement({registry:{providers:{copilot:p}},router:{setCatalog:(...args)=>writes.push(args)}});
 const old=management.call('/api/proxy/sources/copilot/status');await entered.promise;p.auth.epoch++;waiting.resolve();await old;assert.deepEqual(writes,[]);
});

for(const id of ['copilot','kimi','grok','codex'])test(id+' closes an outstanding authentication request without waiting for its deadline',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-auth-close-')),f=id==='copilot'?fixture({dataDir}):accountFixture({id,dataDir}),p=f.p||f.provider;
 t.after(async()=>{p.close();await rm(dataDir,{recursive:true,force:true});});
 f.auth.fetchImpl=async(url,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
 const pending=f.auth.request('https://auth.example.test/token');f.auth.close();await assert.rejects(pending,{name:'AbortError'});
 await assert.rejects(f.auth.login(),/已关闭/);
});
