import test from 'node:test';
import assert from 'node:assert/strict';
import {createProxyState} from '../public/proxy/state.js';
import {createManagement} from '../proxy/management.js';
const recovery={code:'EKEYCHAIN_AUTH_FAILED',message:'后台访问验证失败，请重新登录',stage:'storage'};
function stateFixture(t){
 const f={recovery:null,result:{ok:true,credentialRepaired:true,connected:true},operations:[]};
 const store=createProxyState({request:async op=>op==='sources'?{sources:[{id:'grok',credentialRecovery:f.recovery,authentication:{operations:['login','poll','repair','cancel']}}]}:{state:'running'},source:async(id,op)=>{f.operations.push(op);if(op==='auth/login')return{status:'pending',url:'https://example.test/login',expiresAt:Date.now()+60000};if(f.result instanceof Error)throw f.result;return f.result;}});
 t.after(()=>store.dispose());return Object.assign(f,{store});
}
test('failed repair never claims restored access and relogin remains available',async t=>{
 const f=stateFixture(t);f.recovery=recovery;f.result={ok:false,credentialRepaired:false,connected:false,error:recovery.message};
 await f.store.auth('grok','repair');assert.equal(f.store.authNotice('grok'),undefined);assert.deepEqual(f.store.source('grok').credentialRecovery,recovery);
 await f.store.auth('grok','login');assert.equal(f.store.login('grok').status,'pending');assert.deepEqual(f.operations,['auth/repair','auth/login']);
});
test('a stale success response cannot override current recovery evidence',async t=>{
 const f=stateFixture(t);f.recovery=recovery;
 await f.store.auth('grok','repair');assert.equal(f.store.authNotice('grok'),undefined);
 f.recovery=null;await f.store.auth('grok','repair');assert.equal(f.store.authNotice('grok'),undefined);
 f.recovery=recovery;await f.store.refresh();assert.equal(f.store.authNotice('grok'),undefined);
});
test('network failure is separate from verified credential access; a later failed attempt clears the success',async t=>{
 const f=stateFixture(t);f.result={ok:true,credentialRepaired:true,connected:false,error:'无法连接来源服务'};
 await f.store.auth('grok','repair');assert.match(f.store.authNotice('grok'),/来源连接检测失败：无法连接来源服务/);
 f.result=new Error(recovery.message);f.recovery=recovery;
 await assert.rejects(f.store.auth('grok','repair'),/后台访问验证失败/);assert.equal(f.store.authNotice('grok'),undefined);
});
function managementFixture(){
 const auth={epoch:0,repair:async()=>({ok:true,credentialRepaired:true})},provider={auth,status:async()=>({connected:true})};
 const management=createManagement({registry:{providers:{grok:provider},snapshot:()=>({authentication:{operations:['repair']}})},router:{invalidateSource(){},setCatalog(){},failedAt:new Map(),refreshSource:async()=>[]},sourceState:{invalidate(){}}});
 return{auth,provider,repair:()=>management.call('/api/proxy/sources/grok/auth/repair',{})};
}
test('repair returns verified access without starting provider connection or token refresh',async()=>{
 const f=managementFixture();let checks=0;f.provider.status=async()=>{checks++;throw Error('must not run');};
 assert.deepEqual(await f.repair(),{ok:true,credentialRepaired:true,connectionChecked:false});assert.equal(checks,0);
});
test('management cannot claim success while its credential owner still reports a recovery error',async()=>{
 const f=managementFixture();f.auth.recovery=recovery;
 assert.deepEqual(await f.repair(),{ok:false,credentialRepaired:false,connected:false,code:recovery.code,error:recovery.message});
});

test('repair waits for a fresh source snapshot rather than accepting an earlier recovery poll',async t=>{
 let resolve,reads=0,repaired=false;const held=new Promise(r=>resolve=r);
 const store=createProxyState({request:async op=>{
  if(op!=='sources')return{state:'running'};
  const snapshot={sources:[{id:'grok',credentialRecovery:repaired?undefined:recovery,authentication:{operations:['repair']}}]};
  if(++reads===1)await held;return snapshot;
 },source:async()=>{repaired=true;return{ok:true,credentialRepaired:true,connectionChecked:false};}});t.after(()=>store.dispose());
 const poll=store.refresh(),repair=store.auth('grok','repair');resolve();await Promise.all([poll,repair]);
 assert.equal(reads,2);assert.equal(store.source('grok').credentialRecovery,undefined);assert.equal(store.authNotice('grok'),undefined);
});
test('cancel during post-repair refresh prevents a late success notice',async t=>{
 let release,started;const held=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 const store=createProxyState({request:async op=>{if(op==='sources'){started();await held;return{sources:[]};}return{state:'running'};},source:async(id,op)=>op==='auth/cancel'?{status:'cancelled'}:{ok:true,credentialRepaired:true}});t.after(()=>store.dispose());
 const repair=store.auth('grok','repair');await ready;const cancel=store.auth('grok','cancel');release();
 assert.equal((await repair).status,'cancelled');await cancel;assert.equal(store.authNotice('grok'),undefined);
});
