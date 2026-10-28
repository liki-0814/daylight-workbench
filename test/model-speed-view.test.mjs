import test from 'node:test';
import assert from 'node:assert/strict';
import {renderModelSpeed,updateModelSpeeds,createModelSpeedFeed,sortModelsByFrequency} from '../public/components/model-speed.js';

const deferred=()=>Promise.withResolvers();
function fixture(){
 const page=new EventTarget();page.hidden=false;
 const calls=[],timers=new Map();let next=0,notifications=0;
 const api={request(path,body,{signal}){const pending=deferred();calls.push({path,body,signal,...pending});return pending.promise;}};
 const feed=createModelSpeedFeed({api,page,onChange:()=>notifications++,repeat:(fn,ms)=>{assert.equal(ms,3000);timers.set(++next,fn);return next;},stop:id=>timers.delete(id)});
 return{feed,page,calls,timers,get notifications(){return notifications;}};
}
const stats=(value=42)=>({sources:[{id:'qoder',performance:[{model:'shared',tokensPerSecond:value}],modelUsage:[{model:'shared',requests:7}]},{id:'custom:one',performance:[{model:'shared',tokensPerSecond:9}],modelUsage:[{model:'shared',requests:2}]}]});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('speed reads are deduplicated and scoped by actual source, independent of Pi configuration',async()=>{
 const f=fixture();f.feed.setVisible(true);const first=f.feed.refresh();assert.strictEqual(first,f.feed.refresh());await tick();
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'sources');assert.equal(f.calls[0].body,undefined);assert.equal(f.feed.loading,true);
 f.calls[0].resolve(stats());await first;
 assert.equal(f.feed.loading,false);assert.equal(f.feed.get('qoder')[0].tokensPerSecond,42);assert.equal(f.feed.get('custom:one')[0].tokensPerSecond,9);assert.deepEqual(f.feed.get('unknown'),[]);
 assert.equal(f.feed.getUsage('qoder')[0].requests,7);assert.equal(f.feed.getUsage('custom:one')[0].requests,2);assert.deepEqual(f.feed.getUsage('unknown'),[]);
 f.feed.setVisible(true);assert.equal(f.timers.size,1);f.feed.dispose();assert.equal(f.timers.size,0);
});

test('statistics failures retain prior results, mark them stale and recover with new revisions',async()=>{
 const f=fixture();f.feed.setVisible(true);await tick();f.calls[0].resolve(stats());await f.feed.refresh();
 const failed=f.feed.refresh();await tick();f.calls[1].reject(Error('offline'));await failed;
 assert.equal(f.feed.stale,true);assert.equal(f.feed.get('qoder')[0].tokensPerSecond,42);
 assert.equal(f.feed.getUsage('qoder')[0].requests,7);
 const recovered=f.feed.refresh();await tick();f.calls[2].resolve({sources:[{id:'qoder',performance:[]}]});await recovered;
 assert.equal(f.feed.stale,false);assert.deepEqual(f.feed.get('qoder'),[]);assert.deepEqual(f.feed.get('custom:one'),[]);assert.deepEqual(f.feed.getUsage('qoder'),[]);f.feed.dispose();
});

test('frequency order uses calls rather than TPS samples, isolates sources and preserves ties and the input catalog',()=>{
 const models=[{id:'unused',source:'qoder'},{id:'shared',source:'custom:one'},{id:'alias',upstreamId:'actual',source:'qoder'},{id:'shared',source:'qoder'},{id:'other-unused',source:'qoder'}];
 const usage={qoder:[{model:'shared',requests:9},{model:'actual',requests:4}], 'custom:one':[{model:'shared',requests:2}]};
 const sorted=sortModelsByFrequency(models,source=>usage[source]||[]);
 assert.deepEqual(sorted.map(m=>m.id),['shared','alias','shared','unused','other-unused']);
 assert.equal(sorted[0].source,'qoder');assert.equal(models[0].id,'unused');
 assert.deepEqual(sortModelsByFrequency(models,()=>[]),models);
 // A source-local model ID takes precedence over an overlapping upstream name.
 assert.equal(sortModelsByFrequency([models[2],models[3]],()=>[{model:'alias',requests:1},{model:'actual',requests:100},{model:'shared',requests:2}])[0].id,'shared');
 const routed={id:'shared',source:'custom:one',usageSources:['custom:one','qoder','qoder']};
 assert.equal(sortModelsByFrequency([models[2],routed],source=>usage[source]||[])[0],routed);
});

test('hide, rapid reopen and tab visibility cancel stale work and resume without late overwrites',async()=>{
 const f=fixture();f.feed.setVisible(true);await tick();const old=f.feed.refresh();f.feed.setVisible(false);
 assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.timers.size,0);
 f.feed.setVisible(true);await tick();const current=f.feed.refresh();f.calls[1].resolve(stats(80));await current;f.calls[0].resolve(stats(1));await old;
 assert.equal(f.feed.get('qoder')[0].tokensPerSecond,80);
 f.page.hidden=true;f.page.dispatchEvent(new Event('visibilitychange'));assert.equal(f.timers.size,0);await f.feed.refresh();assert.equal(f.calls.length,2);
 f.page.hidden=false;f.page.dispatchEvent(new Event('visibilitychange'));await tick();assert.equal(f.calls.length,3);
 const pending=f.feed.refresh();f.feed.dispose();const notifications=f.notifications;assert.equal(f.calls[2].signal.aborted,true);f.calls[2].resolve(stats(1));await pending;
 assert.equal(f.notifications,notifications);assert.equal(f.timers.size,0);
});

test('shared display keeps unknown latency missing, exposes estimates and never confuses models',()=>{
 const row={dataset:{modelSpeed:'public',speedUpstream:'actual'},removeAttribute(name){delete this[name];}},root={querySelectorAll:()=>[row]};
 const actual={model:'public',upstreamModel:'actual',tokensPerSecond:42.6,lastTokensPerSecond:43,samples:20,firstContentMs:1250,effort:'high',tier:'priority',timing:'stream',updatedAt:'2026-10-27T08:30:00Z'};
 updateModelSpeeds(root,[{...actual,model:'other',upstreamModel:'other'}]);assert.match(row.textContent,/等待实际请求/);
 updateModelSpeeds(root,[actual]);assert.match(row.textContent,/42.6 tok\/s/);assert.match(row.textContent,/首次输出 1.25s/);assert.match(row.textContent,/20 次.*high.*priority/);assert.match(row.title,/最近一次 43 tok\/s/);
 updateModelSpeeds(root,[{...actual,firstContentMs:undefined,estimated:true,timing:'upstream'}],{stale:true});assert.doesNotMatch(row.textContent,/首次输出/);assert.match(row.textContent,/估算.*含首包等待.*暂未更新/);
 updateModelSpeeds(root,[],{loading:true});assert.match(row.textContent,/正在读取/);assert.equal(row.title,undefined);
 updateModelSpeeds(root,[],{stale:true});assert.match(row.textContent,/暂时不可用/);
 assert.match(renderModelSpeed({id:'<"',upstreamId:'actual'}),/&lt;&quot;/);
});
