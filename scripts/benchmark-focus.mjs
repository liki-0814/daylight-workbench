// Real HTTP + durable storage measurements. Every process uses synthetic data.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { initialFocusRecord } from '../core/focus-model.js';
import { initialState, localDate } from '../public/model.js';
import { addCivilDays } from '../core/date.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf('--' + name); return i < 0 ? fallback : argv[i + 1]; };
const sizes = option('records', '10000,50000').split(',').map(Number);
const runtimes = option('runtimes', 'node,native').split(',');
const samples = Number(option('samples', '30'));
if (sizes.some(n => !Number.isInteger(n) || n < 1) || runtimes.some(r => !['node', 'native'].includes(r)) || samples < 30) throw Error('Need positive record counts, node/native runtimes and >=30 samples');
const out = path.resolve(option('out', '/tmp/daylight-focus-benchmark.json'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.min(values.length-1, Math.ceil(values.length*p)-1)];
const summary = values => ({ count: values.length, p50: percentile(values,.5), p95: percentile(values,.95), max: Math.max(...values) });
const rss = pid => { try { return Number(execFileSync('ps',['-o','rss=','-p',String(pid)],{encoding:'utf8'}).trim())*1024; } catch { return 0; } };
const commandOutput = (command,args) => { try { return execFileSync(command,args,{encoding:'utf8'}).trim(); } catch { return 'unavailable'; } };
function requestHttp(url, payload, token) {
  return new Promise((resolve,reject)=>{
    const body=payload===undefined?null:Buffer.from(JSON.stringify(payload));
    const req=http.request(url,{method:body?'POST':'GET',agent:false,headers:{Connection:'close',...(token?{Authorization:`Bearer ${token}`} : {}),...(body?{'Content-Type':'application/json','Content-Length':body.length}:{})}},res=>{
      const chunks=[];res.on('data',part=>chunks.push(part));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString('utf8')}));
    });req.on('error',reject);req.setTimeout(15000,()=>req.destroy(Error('HTTP benchmark timed out')));req.end(body);
  });
}

async function freePort() {
  const socket = net.createServer(); await new Promise((resolve,reject) => { socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve); });
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function stopChild(child) {
  if(child.exitCode!==null || child.signalCode!==null)return;
  child.kill('SIGTERM'); await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(5000)]);
  if(child.exitCode===null && child.signalCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}
}
function fixture(count) {
  const state = initialState();
  state.projects = Array.from({length:50},(_,i)=>({id:`project-${i}`,name:`Benchmark ${i}`,path:'',color:'green'}));
  state.tasks = Array.from({length:1000},(_,i)=>({id:`task-${i}`,projectId:`project-${i%50}`,title:`Task ${i}`,notes:'',status:'todo',completedAt:null}));
  const record = initialFocusRecord({timeZone:'Asia/Shanghai'}), now = Date.now();
  record.settings.notificationsEnabled = true;
  record.sessions = Array.from({length:count},(_,i)=>{
    const startAt = now - (count-i)*2_400_000 - 3_600_000;
    const paused = i%5===0, endedAt = startAt + (paused ? 1_800_000 : 1_500_000);
    return { id:`history-${i}`,phase:'work',status:'ended',clockIssue:null,timeQuality:'wall_clock',
      taskId:i%17===0 ? `deleted-task-${i}` : `task-${i%1000}`,taskTitleSnapshot:`Historical task ${i}`,projectIdSnapshot:`project-${i%50}`,projectNameSnapshot:`Benchmark ${i%50}`,
      targetMs:1_500_000,startedAt:startAt,deadlineAt:null,remainingMs:null,pauseCount:paused?1:0,
      segments:paused?[{startAt,endAt:startAt+600_000},{startAt:startAt+900_000,endAt:endedAt}]:[{startAt,endAt:endedAt}],
      endedAt,observedAt:endedAt,endReason:'completed' };
  });
  return {state,record,segments:record.sessions.reduce((n,s)=>n+s.segments.length,0)};
}
async function start(runtime,directory,diagnostics,{consume=false}={}) {
  const port = await freePort(), startedAt = performance.now();
  const binary = runtime==='node' ? process.execPath : path.join(root,'dist/native/Daylight.app/Contents/MacOS/Daylight');
  const args = runtime==='node' ? [path.join(root,'server.mjs')] : ['--headless',...(consume?['--focus-benchmark-consume']:[])];
  const child = spawn(binary,args,{cwd:root,env:{...process.env,PORT:String(port),WORKBENCH_DATA_DIR:directory,WORKBENCH_FOCUS_DIAGNOSTICS:'1'},stdio:['ignore','pipe','pipe']});
  let stderr = '', tail = '';
  child.stderr.on('data',chunk=>{stderr+=chunk;tail+=chunk;const lines=tail.split('\n');tail=lines.pop();for(const line of lines)try{const v=JSON.parse(line);if(v.type==='focus-save')diagnostics.push({...v,encodingMs:v.encodeMs});else if(v.focusBenchmark || v.focusDiagnostics)diagnostics.push(v);}catch{}});
  child.stdout.resume();
  const base = `http://127.0.0.1:${port}`;
  try {
    for(let i=0;i<400;i++) {
      if(child.exitCode!==null || child.signalCode!==null)throw Error(`${runtime} exited: ${stderr}`);
      try { if((await requestHttp(base+'/api/state')).status===200)break; } catch {}
      if(i===399)throw Error(`${runtime} did not start: ${stderr}`);
      await sleep(50);
    }
    const token = (await readFile(path.join(directory,'agent-token'),'utf8')).trim();
    return { child, base, token, coldStartMs:performance.now()-startedAt, stop:()=>stopChild(child) };
  } catch(error) {
    await stopChild(child);
    // A free ephemeral port can be taken between close() and child bind().
    // Retry the complete fixture, not a possibly persisted consume operation.
    if(/EADDRINUSE|Address already in use/i.test(stderr))error.code='BENCHMARK_PORT_COLLISION';
    throw error;
  }
}
async function measure(runtime,count) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'daylight-focus-benchmark-'));
  const diagnostics=[], metrics={}, queueMs=[], phases={};let running,sampleTimer;
  try {
    running=await start(runtime,directory,diagnostics);
    const baselineRss=rss(running.child.pid),baselineColdStartMs=running.coldStartMs;await running.stop();
    const data=fixture(count);
    await writeFile(path.join(directory,'state.json'),JSON.stringify({version:0,state:data.state}),{mode:0o600});
    await writeFile(path.join(directory,'focus.json'),JSON.stringify(data.record),{mode:0o600});
    running=await start(runtime,directory,diagnostics);
    let peakRss=rss(running.child.pid),counter=0,version=0,sessionId;
    const sampleRss=(pid=running?.child.pid)=>{if(pid)peakRss=Math.max(peakRss,rss(pid));};
    sampleTimer=setInterval(()=>sampleRss(),250);sampleTimer.unref();
    async function request(route,payload) {
      const before=performance.now();
      const response=await requestHttp(running.base+'/api/v1/'+route,payload,running.token);
      const text=response.text,value=JSON.parse(text),ms=performance.now()-before;
      const q=response.headers['x-daylight-queue-ms'];if(q!==undefined)queueMs.push(Number(q));
      if(response.status<200||response.status>=300)throw Error(`${runtime} ${route} ${response.status}: ${text}`);
      return {value,ms,bytes:Buffer.byteLength(text)};
    }
    async function action(a) {
      const r=await request('focus/actions',{requestId:`benchmark-${++counter}`,expectedVersion:version,...(['focus.start','focus.switch'].includes(a.type)?{expectedTaskVersion:0}:{}),action:a});
      version=r.value.version;sessionId=r.value.current?.id;return r.ms;
    }
    const initial=(await request('focus/state')).value;version=initial.version;
    await action({type:'focus.start',phase:'work',taskId:'task-0'});
    const to=localDate(), from=addCivilDays(to,-365);
    const routes={state:'focus/state',statistics:`focus/statistics?from=${from}&to=${to}`,taskSummary:'focus/task-summary?taskId=task-0&recentLimit=5'};
    const queryRss=[];
    let stateBytes=0;
    for(const [name,route] of Object.entries(routes)) {
      for(let i=0;i<5;i++)await request(route);
      const values=[];
      for(let i=0;i<samples;i++){const r=await request(route);values.push(r.ms);if(name==='state')stateBytes=Math.max(stateBytes,r.bytes);if(name==='statistics')queryRss.push(rss(running.child.pid));}
      metrics[name]=summary(values);sampleRss();
    }
    // Thirty timing samples can merely show an allocator filling its heap.
    // Repeat the same immutable report in batches to look for a later plateau
    // or collection, rather than approving a monotonic short sample alone.
    const rssBatches=[];
    for(let batch=0;batch<10;batch++) {
      for(let i=0;i<30;i++)await request(routes.statistics);
      const bytes=rss(running.child.pid);rssBatches.push(bytes);sampleRss();
    }
    const rssAfterQueries=rss(running.child.pid);
    for(const kind of ['pauseResume','finishStart','settings']) {
      const values=[];
      for(let i=0;i<5+samples;i++) {
        const ms=kind==='pauseResume' ? Math.max(await action({type:'focus.pause',sessionId}),await action({type:'focus.resume',sessionId}))
          : kind==='finishStart' ? Math.max(await action({type:'focus.finish',sessionId}),await action({type:'focus.start',phase:'work',taskId:'task-0'}))
          : await action({type:'focus.settings',settings:{soundEnabled:i%2===0}});
        if(i>=5)values.push(ms);
      }
      metrics[kind]=summary(values);
    }
    const contention=[];
    for(let i=0;i<samples;i++) {
      const heavy=i%2 ? action({type:'focus.settings',settings:{soundEnabled:i%4===1}}) : request(routes.statistics);await sleep(1);
      const light=request('state');const [h,l]=await Promise.all([heavy,light]);contention.push(l.ms);
      if(!(i%2)&&!h.value.summary)throw Error('missing report');
    }
    metrics.taskStateUnderLoad=summary(contention);
    sampleRss();
    const fileBytes=(await stat(path.join(directory,'focus.json'))).size;
    const coldStartMs=running.coldStartMs;
    await running.stop();
    // Observe completed atomic saves from disk. observedAt is captured before
    // persistence, so it cannot establish the successful-save deadline budget.
    // The idle case invokes no focus route and checks the scheduler itself;
    // Loaded cases check durable completion during report traffic and actual
    // full-file settings writes. Conflicts after timer archival refresh the
    // committed version; failed writes never count as load measurements.
    const source=JSON.parse(await readFile(path.join(directory,'focus.json'),'utf8'));
    const deadlineMeasurements={};
    for(const load of ['idle','report','write']) {
      const expiry=Date.now()+3000, id=`benchmark-deadline-${load}`;
      const deadlineRecord={...source,sessions:data.record.sessions,receipts:[],lastOutcome:null,
        current:{...source.current,id,startedAt:expiry-1500000,deadlineAt:expiry,remainingMs:null,segments:[{startAt:expiry-1500000,endAt:null}],pauseCount:0}};
      const file=path.join(directory,'focus.json');
      await writeFile(file,JSON.stringify(deadlineRecord),{mode:0o600});
      let previous=(await stat(file)).mtimeMs;
      running=await start(runtime,directory,diagnostics);
      let pressure=true,pressureError=null,loadVersion=deadlineRecord.version,persistedActions=0,actionsBeforeDeadline=0;
      const loaded=load==='idle'?Promise.resolve():(async()=>{
        while(pressure) {
          try {
            if(load==='report') await request(routes.statistics);
            else {
              const response=await requestHttp(running.base+'/api/v1/focus/actions',{requestId:`benchmark-pressure-${++counter}`,expectedVersion:loadVersion,action:{type:'focus.settings',settings:{soundEnabled:persistedActions%2===0}}},running.token);
              const value=JSON.parse(response.text),q=response.headers['x-daylight-queue-ms'];if(q!==undefined)queueMs.push(Number(q));
              if(response.status===409&&value.code==='FOCUS_VERSION_CHANGED') loadVersion=(await request('focus/state')).value.version;
              else if(response.status===200) {loadVersion=value.version;persistedActions++;if(Date.now()<expiry)actionsBeforeDeadline++;}
              else throw Error(`${runtime} persistent deadline pressure ${response.status}: ${response.text}`);
            }
          } catch(e) {pressureError=e;break;}
          await sleep(5);
        }
      })();
      let lag=null;
      try {
        for(let i=0;i<160&&lag===null;i++) {
          const changed=(await stat(file)).mtimeMs;
          if(changed!==previous) {
            previous=changed;
            const saved=JSON.parse(await readFile(file,'utf8'));
            if(!saved.current&&saved.lastOutcome?.id===id&&saved.lastOutcome.endReason==='completed')lag=Math.max(0,Date.now()-expiry);
          }
          if(lag===null)await sleep(50);
        }
      } finally {pressure=false;await loaded;await running.stop();}
      if(pressureError)throw pressureError;
      if(load==='write'&&!actionsBeforeDeadline)throw Error('No durable action completed before the deadline under write load');
      deadlineMeasurements[{idle:'idleTimerMs',report:'underReportLoadMs',write:'underPersistentActionLoadMs'}[load]]=lag;
      if(load==='write') metrics.deadlineWriteLoad={persistedActions,actionsBeforeDeadline};
    }
    const deadlineLagMs=Object.values(deadlineMeasurements).every(Number.isFinite)?Math.max(...Object.values(deadlineMeasurements)):null;
    const consumeRecord=JSON.parse(await readFile(path.join(directory,'focus.json'),'utf8'));
    const consumes=[];
    if(!consumeRecord.lastOutcome||deadlineLagMs===null)throw Error('Scheduler did not durably archive completion');
    for(let i=0;i<5+samples;i++) {
      consumeRecord.lastOutcome.notification={requestId:`focus-${consumeRecord.lastOutcome.id}`,state:'pending'};
      await writeFile(path.join(directory,'focus.json'),JSON.stringify(consumeRecord),{mode:0o600});
      let ms;
      if(runtime==='native') {
        const offset=diagnostics.length;
        running=await start(runtime,directory,diagnostics,{consume:true});
        for(let j=0;j<20&&!diagnostics.slice(offset).some(v=>Number.isFinite(v.consumeMs));j++)await sleep(10);
        ms=diagnostics.slice(offset).find(v=>Number.isFinite(v.consumeMs))?.consumeMs;
        sampleRss();
        await running.stop();
      } else {
        const program="const {createFocusService}=await import('./focus/service.mjs');const {readFile}=await import('node:fs/promises');const tasks=JSON.parse(await readFile(process.argv[1]+'/state.json','utf8'));const s=await createFocusService({dataDir:process.argv[1],getTaskSnapshot:()=>tasks});const t=performance.now();await s.consumeNotification(s.record.lastOutcome.id);console.log(JSON.stringify({consumeMs:performance.now()-t}));await s.close();await new Promise(r=>setTimeout(r,100));";
        const child=spawn(process.execPath,['--input-type=module','-e',program,directory],{cwd:root,env:{...process.env,WORKBENCH_FOCUS_DIAGNOSTICS:'1'},stdio:['ignore','pipe','pipe']});
        let output='',errors='';child.stdout.on('data',v=>{output+=v;sampleRss(child.pid);});child.stderr.on('data',v=>errors+=v);
        const consumeSampler=setInterval(()=>sampleRss(child.pid),20);consumeSampler.unref();
        let code;try {code=await new Promise(resolve=>child.once('exit',resolve));}finally{clearInterval(consumeSampler);}
        if(code!==0)throw Error(errors);
        ms=JSON.parse(output.trim()).consumeMs;
        for(const line of errors.trim().split('\n'))try{const v=JSON.parse(line);if(v.type==='focus-save')diagnostics.push({...v,encodingMs:v.encodeMs});else if(v.focusDiagnostics)diagnostics.push(v);}catch{}
      }
      if(!Number.isFinite(ms))throw Error('Missing notification consume measurement');
      if(runtime==='native')queueMs.push(ms);
      if(i>=5)consumes.push(ms);
    }
    metrics.notificationConsume=summary(consumes);
    for(const d of diagnostics) { if(Number.isFinite(d.queueMs))queueMs.push(d.queueMs); for(const name of ['encodingMs','previousMs','temporaryMs','replaceMs','consumeMs','queueMs']) if(Number.isFinite(d[name]))(phases[name] ||= []).push(d[name]); }
    const firstRss=percentile(queryRss.slice(0,10),.5),lastRss=percentile(queryRss.slice(-10),.5);
    const rssTrend={samples:queryRss,firstBatchMedian:firstRss,lastBatchMedian:lastRss,growthBytes:lastRss-firstRss,additionalQueryCount:300,batches:rssBatches,tailGrowthBytes:percentile(rssBatches.slice(-3),.5)-percentile(rssBatches.slice(-6,-3),.5),collectionObserved:rssBatches.some((v,i)=>i>0&&v<rssBatches[i-1])};
    const budget={stateP95:metrics.state.p95<=200,stateBytes:stateBytes<=32768,actionP95:['pauseResume','finishStart','settings','notificationConsume'].every(k=>metrics[k].p95<=1500),reportP95:metrics.statistics.p95<=2000&&metrics.taskSummary.p95<=2000,taskStateUnderLoadP95:metrics.taskStateUnderLoad.p95<=500,rssIncrease:peakRss-baselineRss<=768*1024*1024,rssTrend:Math.max(0,rssTrend.growthBytes)<=64*1024*1024&&Math.max(0,rssTrend.tailGrowthBytes)<=16*1024*1024,queueOccupancy:queueMs.length>0&&Math.max(...queueMs)<=500,deadlineLag:deadlineLagMs!==null&&deadlineLagMs<=2000};
    return {runtime,count,segments:data.segments,fileBytes,baselineColdStartMs,coldStartMs,baselineRss,peakRss,rssAfterQueries,rssTrend,stateBytes,metrics,deadlineLagMs,deadlineMeasurements,stageTimings:Object.fromEntries(Object.entries(phases).map(([k,v])=>[k,summary(v)])),queueOccupancyMs:queueMs.length?summary(queueMs):null,budget,passed:Object.values(budget).every(Boolean),pendingMeasurements:[]};
  } finally {clearInterval(sampleTimer);await running?.stop();await rm(directory,{recursive:true,force:true});}
}
const nativeBinarySha256=runtimes.includes('native')?createHash('sha256').update(await readFile(path.join(root,'dist/native/Daylight.app/Contents/MacOS/Daylight'))).digest('hex'):null;
const javaScriptCorePlist='/System/Library/Frameworks/JavaScriptCore.framework/Resources/Info.plist';
const javaScriptCore=runtimes.includes('native')?{source:'macOS system framework',plist:javaScriptCorePlist,version:commandOutput('plutil',['-extract','CFBundleShortVersionString','raw','-o','-',javaScriptCorePlist]),build:commandOutput('plutil',['-extract','CFBundleVersion','raw','-o','-',javaScriptCorePlist])}:null;
const report={generatedAt:new Date().toISOString(),environment:{platform:os.platform(),release:os.release(),arch:os.arch(),cpu:os.cpus()[0]?.model,totalMemory:os.totalmem(),node:process.version,swift:commandOutput('swift',['--version']),javaScriptCore,nativeBinarySha256,commit:commandOutput('git',['rev-parse','HEAD']),dirty:commandOutput('git',['status','--porcelain'])},samples,warmups:5,results:[]};
for(const runtime of runtimes)for(const count of sizes){
  console.log(`Measuring ${runtime}: ${count} sessions…`);
  for(let attempt=1;attempt<=3;attempt++) {
    try { report.results.push(await measure(runtime,count));break; }
    catch(error) {
      if(error.code!=='BENCHMARK_PORT_COLLISION'||attempt===3)throw error;
      console.log(`Temporary port collision; restarting ${runtime}:${count} with a fresh synthetic fixture (${attempt}/3).`);
    }
  }
  await writeFile(out,JSON.stringify(report,null,2)+'\n');
}
report.passed=report.results.every(r=>r.passed&&r.pendingMeasurements.length===0);
await writeFile(out,JSON.stringify(report,null,2)+'\n');
console.log(`${report.passed?'PASS':'INCOMPLETE/FAIL'}: ${out}`);
if(!report.passed)process.exitCode=1;
