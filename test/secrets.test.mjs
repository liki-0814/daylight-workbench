import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Secrets} from '../proxy/shared/secrets.js';

// Substitute a real child process; these tests never open the user's keychain.
function fixture(source,options={}){
 let child;
 const secrets=new Secrets({...options,spawnImpl:(_helper,args,spawnOptions)=>{
  assert.deepEqual(args,[]);assert.deepEqual(spawnOptions.stdio,['pipe','pipe','pipe']);
  child=spawn(process.execPath,['--input-type=module','-e',source],spawnOptions);return child;
 }});
 return {secrets,get child(){return child;}};
}
test('credentials only travel over stdin; get, set and delete remain compatible',async()=>{
 const f=fixture(`let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
  const body=JSON.parse(input);
  if(body.id!=='fixture-id')process.exit(2);
  if(body.action==='set'&&body.value!=='fixture-value')process.exit(2);
  process.stdout.write(JSON.stringify(body.action==='get'?{value:'fixture-value'}:{}));
 });`);
 assert.equal(await f.secrets.get('fixture-id'),'fixture-value');
 assert.deepEqual(await f.secrets.set('fixture-id','fixture-value'),{});
 assert.deepEqual(await f.secrets.delete('fixture-id'),{});
});
test('missing credential stays undefined',async()=>{
 assert.equal(await fixture("process.stdout.write('{}')").secrets.get('missing'),undefined);
});
for(const status of [-25308,-25315])test(`interaction-required status ${status} fails explicitly without a retry`,async()=>{
 let calls=0;
 const f=fixture(`process.stderr.write('钥匙串操作失败：${status}');process.exit(1);`);
 const original=f.secrets.spawnImpl;f.secrets.spawnImpl=(...args)=>{calls++;return original(...args);};
 await assert.rejects(f.secrets.get('fixture-id'),error=>error.code==='EKEYCHAIN_INTERACTION_REQUIRED'&&/未弹出授权窗口/.test(error.message));
 assert.equal(calls,1);
});
test('keychain authentication failure stays distinct from upstream login and never retries',async()=>{
 const f=fixture("process.stderr.write('钥匙串操作失败：-25293');process.exit(1)");
 await assert.rejects(f.secrets.get('fixture-id'),error=>error.code==='EKEYCHAIN_AUTH_FAILED'&&/不代表上游账号已退出/.test(error.message));
});
test('timeout reaps a helper that ignores SIGTERM before rejecting',async()=>{
 const f=fixture("process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",{timeoutMs:500,killGraceMs:30});
 const pending=f.secrets.get('fixture-id');
 await once(f.child.stdout,'data');
 await assert.rejects(pending,error=>error.code==='EKEYCHAIN_TIMEOUT');
 assert.equal(f.child.signalCode,'SIGKILL');
 assert.throws(()=>process.kill(f.child.pid,0),error=>error.code==='ESRCH');
});
test('timeout remains an error even if a helper exits successfully on SIGTERM',async()=>{
 const f=fixture("process.on('SIGTERM',()=>{process.stdout.write('{}');process.exit(0)});process.stdout.write('ready');setInterval(()=>{},1000)",{timeoutMs:500,killGraceMs:30});
 const pending=f.secrets.get('fixture-id');await once(f.child.stdout,'data');
 await assert.rejects(pending,error=>error.code==='EKEYCHAIN_TIMEOUT');
 assert.equal(f.child.exitCode,0);
});
test('invalid output and unexpected stderr never expose credential data',async()=>{
 await assert.rejects(fixture("process.stdout.write('invalid fixture-value')").secrets.get('fixture-id'),/钥匙串返回无效/);
 await assert.rejects(fixture("process.stderr.write('private fixture-value');process.exit(1)").secrets.get('fixture-id'),error=>error.message==='钥匙串不可用或访问被拒绝');
});
test('missing helper fails without waiting for the timeout',async()=>{
 const secrets=new Secrets({spawnImpl:(_helper,args,options)=>spawn('/nonexistent/daylight-test-helper',args,options),timeoutMs:500});
 await assert.rejects(secrets.get('fixture-id'),/钥匙串组件不可用/);
});
