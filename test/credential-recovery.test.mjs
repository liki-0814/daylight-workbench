import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {OAuthAccount} from '../proxy/shared/oauth-account.js';
import {CredentialSessions} from '../proxy/shared/credential-sessions.js';
import {accountFixture} from '../fixtures/standalone-accounts/upstream.mjs';
import {createManagement} from '../proxy/management.js';

const denied=()=>Object.assign(new Error('旧凭证需要授权'),{code:'EKEYCHAIN_INTERACTION_REQUIRED'});
async function fixture(t){
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-recovery-')),keys=new Map(),calls=[];
 const secrets={async get(id,options){calls.push(['get',id,options]);if(id==='review-oauth')throw denied();return keys.get(id);},async set(id,value,options){calls.push(['set',id,options]);keys.set(id,value);},async delete(id){if(id==='review-oauth')throw denied();keys.delete(id);}};
 const auth=new OAuthAccount({id:'review',name:'Review',dataDir,secrets});
 t.after(async()=>{auth.close();await rm(dataDir,{recursive:true,force:true});});
 return{auth,secrets,keys,calls,dataDir};
}
const session=id=>({access_token:'synthetic-secret-'+id,refresh_token:'synthetic-refresh',expiresAt:Date.now()+3600000,account:{id},clientId:'fixture'});

test('inaccessible legacy credentials cannot block a new login, including after restart',async t=>{
 const f=await fixture(t);await assert.rejects(f.auth.readSession(),{code:'EKEYCHAIN_INTERACTION_REQUIRED'});
 f.auth.beginLogin();await f.auth.commit(session('new'),f.auth.epoch);
 assert.equal(f.calls.filter(([op,id])=>op==='get'&&id==='review-oauth').length,1);
 assert(f.calls.some(([op,,options])=>op==='set'&&options.interactive));
 const restarted=new OAuthAccount({id:'review',name:'Review',dataDir:f.dataDir,secrets:f.secrets});t.after(()=>restarted.close());
 assert.equal((await restarted.readSession()).account.id,'new');
 const manifest=await readFile(f.auth.sessions.file,'utf8');assert.doesNotMatch(manifest,/synthetic-secret|synthetic-refresh/);
 assert.equal(f.auth.recovery,null);
});
test('failed storage keeps the previous session and cancellation never publishes new credentials',async t=>{
 const f=await fixture(t);await f.auth.commit(session('old'),f.auth.epoch);const previous=await f.auth.sessions.get();
 const set=f.secrets.set;f.secrets.set=async()=>{throw denied();};
 await assert.rejects(f.auth.commit(session('new'),f.auth.epoch));assert.equal(await f.auth.sessions.get(),previous);
 f.secrets.set=async(...args)=>{await set(...args);await f.auth.cancel();};f.auth.beginLogin();
 await assert.rejects(f.auth.commit(session('cancelled'),f.auth.epoch));assert.equal(await f.auth.sessions.get(),previous);
});
test('logout persists a tombstone even when old keychain items cannot be deleted',async t=>{
 const f=await fixture(t);await f.auth.commit(session('old'),f.auth.epoch);f.secrets.delete=async()=>{throw denied();};
 assert.match((await f.auth.logout()).warning,/已退出/);
 const restarted=new CredentialSessions({secrets:f.secrets,key:'review-oauth',dataDir:f.dataDir});assert.equal(await restarted.get(),undefined);
 await f.auth.commit(session('new'),f.auth.epoch);assert.equal((await f.auth.readSession()).account.id,'new');
});
test('background failures are latched; only explicit repair requests system authorization',async t=>{
 const f=await fixture(t);await assert.rejects(f.auth.readSession());await assert.rejects(f.auth.readSession());assert.equal(f.calls.length,1);
 const get=f.secrets.get;f.secrets.get=async(id,options)=>{if(id==='review-oauth'){assert.equal(options.interactive,true);return JSON.stringify(session('restored'));}return get(id,options);};
 const result=await f.auth.repair();assert.equal(result.credentialRepaired,true);assert.equal(f.auth.recovery,null);
 assert.notEqual((await f.auth.sessions.state()).current,'review-oauth');
 assert.equal((await f.auth.readSession()).account.id,'restored');
 assert(f.calls.some(([op,id,options])=>op==='get'&&id!=='review-oauth'&&options.interactive===false));
});
test('a crash before publication preserves the old current reference and retains orphan cleanup ownership',async t=>{
 const f=await fixture(t);await f.auth.commit(session('old'),f.auth.epoch);const state=await f.auth.sessions.state();
 const publish=f.auth.sessions.publish.bind(f.auth.sessions);f.auth.sessions.publish=async next=>{if(next.current!==state.current)throw Error('fixture crash');return publish(next);};
 await assert.rejects(f.auth.commit(session('interrupted'),f.auth.epoch),/fixture crash/);
 assert.equal(JSON.parse(await f.auth.sessions.get()).account.id,'old');
});
test('Codex starts a replacement login despite unreadable old keychain data',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-codex-recovery-'));const f=accountFixture({id:'codex',dataDir});
 t.after(async()=>{f.auth.close();await rm(dataDir,{recursive:true,force:true});});
 const get=f.secrets.get;f.secrets.get=async key=>{if(key==='codex-oauth')throw denied();return get(key);};
 const result=await f.auth.login();assert.equal(result.status,'pending');assert.equal((await f.completeLogin()).status,200);assert.equal((await f.auth.poll()).authorized,true);
 assert.equal((await f.auth.readSession()).account.id,'codex-user');
});

test('successful authorization survives a model catalog failure, and repair is POST-only',async()=>{
 const provider={auth:{epoch:0,poll:async()=>({authorized:true}),repair:async()=>({ok:true})},status:async()=>({connected:true})};
 const management=createManagement({registry:{providers:{review:provider},snapshot:()=>({authentication:{operations:['poll','repair']}})},router:{invalidateSource(){},failedAt:new Map(),refreshSource:async()=>{throw Object.assign(new Error('fixture network failure'),{code:'ECONNREFUSED'});}},sourceState:{invalidate(){}}});
 const result=await management.call('/api/proxy/sources/review/auth/poll');assert.equal(result.authorized,true);assert.equal(result.connected,false);assert.match(result.error,/网络|代理/);
 await assert.rejects(management.call('/api/proxy/sources/review/auth/repair'),{status:404});
 const repaired=await management.call('/api/proxy/sources/review/auth/repair',{});assert.equal(repaired.credentialRepaired,true);assert.equal(repaired.connectionChecked,false);assert.equal(repaired.connected,undefined);
});

test('concurrent interactive repairs share one operation and cancellation aborts its owner',async t=>{
 const f=await fixture(t);let reads=0,started;
 const ready=new Promise(resolve=>{started=resolve;});
 f.secrets.get=async(_id,{signal})=>{reads++;started();return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Object.assign(Error('cancelled'),{code:'EKEYCHAIN_CANCELLED'})),{once:true});});};
 const first=f.auth.repair(),second=f.auth.repair();await ready;await f.auth.cancel();
 const result=await Promise.allSettled([first,second]);assert.equal(reads,1);assert(result.every(r=>r.status==='rejected'));assert.equal(f.auth.repairTask,null);
});
test('logout remains committed when cleanup metadata cannot be rewritten',async t=>{
 const f=await fixture(t);await f.auth.commit(session('old'),f.auth.epoch);const publish=f.auth.sessions.publish.bind(f.auth.sessions);
 f.auth.sessions.publish=async state=>{if(state.current===null&&!state.retired.length)throw Error('fixture cleanup failure');return publish(state);};
 f.secrets.delete=async id=>f.keys.delete(id);
 const result=await f.auth.logout();assert.equal(result.status,'logged_out');assert.equal(f.auth.account,null);assert.equal(await f.auth.sessions.get(),undefined);
});

test('inaccessible legacy items cannot starve cleanup of later credentials',async t=>{
 const f=await fixture(t),ids=Array.from({length:5},(_,i)=>'review-oauth-00000000-0000-0000-0000-'+String(i+1).padStart(12,'0')),deleted=[];
 await f.auth.sessions.publish({current:null,retired:ids});f.secrets.delete=async id=>{if(id!==ids[4])throw denied();deleted.push(id);};
 await f.auth.sessions.cleanup();await f.auth.sessions.cleanup();assert.deepEqual(deleted,[ids[4]]);assert.equal((await f.auth.sessions.state()).retired.length,4);
});


test('a one-time grant cannot claim repair success when the replacement is still unreadable silently',async t=>{
 const f=await fixture(t);await assert.rejects(f.auth.readSession());
 f.secrets.get=async(id,options)=>{if(id==='review-oauth'&&options.interactive)return JSON.stringify(session('old'));throw Object.assign(Error('silent denied'),{code:'EKEYCHAIN_AUTH_FAILED'});};
 await assert.rejects(f.auth.repair(),{code:'EKEYCHAIN_AUTH_FAILED'});
 assert.equal((await f.auth.sessions.state()).current,'review-oauth');
 assert.equal(f.auth.recovery.code,'EKEYCHAIN_AUTH_FAILED');
 await assert.rejects(f.auth.readSession(),{code:'EKEYCHAIN_AUTH_FAILED'});
 f.auth.beginLogin();f.secrets.get=async id=>f.keys.get(id);await f.auth.commit(session('new'),f.auth.epoch);
 assert.equal((await f.auth.readSession()).account.id,'new');
});
test('repair validates restored credentials before writing or clearing recovery',async t=>{
 const f=await fixture(t);await assert.rejects(f.auth.readSession());
 for(const value of ['not-json','{}',JSON.stringify({access_token:'fixture'})]){
  f.secrets.get=async()=>value;await assert.rejects(f.auth.repair(),/没有可恢复的有效凭证/);
 }
 assert.equal(f.calls.filter(([op])=>op==='set').length,0);
 assert.equal((await f.auth.sessions.state()).current,'review-oauth');
 assert.notEqual(f.auth.recovery,null);
});
test('cancelling repair after the new item is written preserves the original credential reference',async t=>{
 const f=await fixture(t),set=f.secrets.set,get=f.secrets.get;
 f.secrets.get=async(id,options)=>id==='review-oauth'?JSON.stringify(session('old')):get(id,options);
 f.secrets.set=async(...args)=>{await set(...args);await f.auth.cancel();};
 await assert.rejects(f.auth.repair());
 assert.equal((await f.auth.sessions.state()).current,'review-oauth');
});
test('repair shares one deadline across keychain steps and cannot publish after timeout',async t=>{
 const f=await fixture(t),deadline=new AbortController(),signals=[];
 t.mock.method(AbortSignal,'timeout',()=>deadline.signal);
 const get=f.secrets.get,set=f.secrets.set;
 f.secrets.get=async(id,options)=>{
  signals.push(options.signal);
  if(id==='review-oauth')return JSON.stringify(session('old'));
  deadline.abort(new DOMException('fixture deadline','TimeoutError'));
  return get(id,options);
 };
 f.secrets.set=async(...args)=>{signals.push(args[2].signal);return set(...args);};
 await assert.rejects(f.auth.repair(),{code:'EKEYCHAIN_TIMEOUT'});
 assert(signals.length>=3);assert(signals.every(signal=>signal===signals[0]));
 assert.equal((await f.auth.sessions.state()).current,'review-oauth');
 assert.equal(f.auth.recovery.code,'EKEYCHAIN_TIMEOUT');
});
