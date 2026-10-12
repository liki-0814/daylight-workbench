// Exercise real shared UI with isolated data and deterministic proxy responses.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createWorkbench} from '../server.mjs';
const {chromium}=await import(process.env.DAYLIGHT_PLAYWRIGHT_MODULE||'playwright');
const directory=await mkdtemp(path.join(os.tmpdir(),'daylight-model-disclosure-'));
const output=path.resolve(process.argv[2]||'.local/verification/model-disclosure');await mkdir(output,{recursive:true});
const server=await createWorkbench({dataDir:directory,proxyOptions:{provider:{listModels:async()=>[]},includeGateway:false,includeAgy:false,includeGrok:false,piOptions:{piDir:path.join(directory,'pi')}},extensionsOptions:{agentsRoot:path.join(directory,'agents')}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.DAYLIGHT_CHROME_EXECUTABLE});
const page=await browser.newPage({viewport:{width:1360,height:900}}),errors=[],checks=[],counts=new Map();
const names={qoder:'Qoder',agy:'AGY',grok:'Grok',codex:'Codex',kimi:'Kimi'};let revision=1,identity='account-a',empty=false,offline=false,slow=false;
const count=key=>counts.get(key)||0;
const models=id=>empty?[]:[{id:id+'-test',displayName:names[id]+' Test',enabled:true,contextWindow:100000,maxOutputTokens:1000,reasoningEfforts:['low','high'],defaultEffort:'low',settingFields:['effort'],modelMetadata:{version:'v1'}}];
page.on('pageerror',error=>errors.push(error.message));
await page.route('**/api/proxy/**',async route=>{
 const url=new URL(route.request().url()),key=url.pathname+url.search;counts.set(key,count(key)+1);
 let body;
 if(url.pathname.endsWith('/status'))body={state:'running',activeRequests:0,port:4319,baseUrl:'http://127.0.0.1:4319/v1',sources:Object.fromEntries(Object.keys(names).map(id=>[id,{connected:true}]))};
 else if(url.pathname==='/api/proxy/sources')body={sources:Object.entries(names).map(([id,name])=>({id,name,identityKey:identity,revision:String(revision),enabled:true,configured:true,authentication:{operations:['refresh']},capabilities:{quota:true}}))};
 else if(url.pathname.endsWith('/view'))body={version:0,hiddenSources:[]};
 else if(url.pathname.endsWith('/key'))body={apiKey:'isolated-key'};
 else if(url.pathname.endsWith('/model-metadata'))body={models:[],meta:{data_version:'v1'}};
 else if(url.pathname.endsWith('/quota'))body={buckets:[],checkedAt:Date.now()};
 else if(url.pathname.endsWith('/models')){
  if(slow)await new Promise(resolve=>setTimeout(resolve,typeof slow==='number'?slow:250));
  if(offline)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'isolated offline'})});
  body={models:models(url.pathname.split('/')[4])};
 }else throw Error('Unexpected fixture request: '+key);
 await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
});
const panel=id=>page.locator('#proxy-panel-'+id),details=id=>panel(id).locator('#'+id+'-models-details'),toggle=id=>details(id).locator(':scope > summary');
try{
 await page.goto(`http://127.0.0.1:${server.address().port}/#proxy`);await page.getByRole('heading',{name:'运行中',exact:true}).waitFor();
 for(const [id,name] of Object.entries(names)){
  await page.getByRole('tab',{name,exact:true}).click();await toggle(id).click();await panel(id).getByRole('checkbox',{name:'启用 '+id+'-test',exact:true}).waitFor();
  const key='/api/proxy/sources/'+id+'/models',before=count(key),metadata=count('/api/proxy/model-metadata');
  await details(id).locator('.proxy-model').evaluate(element=>element.dataset.retained='yes');
  await toggle(id).focus();await page.keyboard.press('Space');await page.keyboard.press('Space');
  await page.waitForTimeout(60);assert.equal(count(key),before);assert.equal(count('/api/proxy/model-metadata'),metadata);
  assert.equal(await details(id).locator('.proxy-model').getAttribute('data-retained'),'yes');assert.equal(await toggle(id).evaluate(element=>document.activeElement===element),true);
  await page.getByRole('button',{name:'任务',exact:true}).click();await page.getByRole('button',{name:'反向代理',exact:true}).click();await panel(id).waitFor();await page.waitForTimeout(60);
  assert.equal(count(key),before);assert.equal(await details(id).locator('.proxy-model').getAttribute('data-retained'),'yes');
  checks.push(name+': repeated opening and navigation retain rows, focus and request counts');
 }
 assert.equal(count('/api/proxy/model-metadata'),1);checks.push('all five sources share one reference request');
 await page.getByRole('tab',{name:'Codex',exact:true}).click();
 const refresh=()=>panel('codex').getByRole('button',{name:'刷新模型',exact:true});
 slow=true;const before=count('/api/proxy/sources/codex/models?refresh=1');await refresh().click();await page.waitForFunction(()=>document.querySelector('#codex-models-details [data-refresh-models]').getAttribute('aria-busy')==='true');
 assert.equal(await details('codex').locator('.proxy-model').count(),1);await page.waitForFunction(()=>document.querySelector('#codex-models-details [data-refresh-models]').getAttribute('aria-busy')==='false');assert.equal(count('/api/proxy/sources/codex/models?refresh=1'),before+1);slow=false;
 checks.push('manual refresh keeps old rows while loading');
 offline=true;await refresh().click();await panel('codex').getByText('isolated offline',{exact:true}).waitFor();assert.equal(await details('codex').locator('.proxy-model').count(),1);
 offline=false;await refresh().click();await page.waitForFunction(()=>document.querySelector('#codex-models-details [data-refresh-models]').getAttribute('aria-busy')==='false');checks.push('failed refresh preserves rows and retry recovers');
 empty=true;await refresh().click();await panel('codex').getByText('账号暂无可用模型',{exact:true}).waitFor();const emptyRequests=count('/api/proxy/sources/codex/models?refresh=1')+count('/api/proxy/sources/codex/models');
 await toggle('codex').click();await toggle('codex').click();await page.waitForTimeout(60);assert.equal(count('/api/proxy/sources/codex/models?refresh=1')+count('/api/proxy/sources/codex/models'),emptyRequests);checks.push('empty catalog is cached');
 const catalogKey='/api/proxy/sources/codex/models';let previous=count(catalogKey),request=page.waitForRequest(r=>new URL(r.url()).pathname===catalogKey);empty=false;revision++;await request;
 await panel('codex').getByRole('checkbox',{name:'启用 codex-test',exact:true}).waitFor();assert.ok(count(catalogKey)>previous);checks.push('source revision invalidates the catalog even while open');
 previous=count(catalogKey);request=page.waitForRequest(r=>new URL(r.url()).pathname===catalogKey);identity='account-b';await request;
 await panel('codex').getByRole('checkbox',{name:'启用 codex-test',exact:true}).waitFor();assert.ok(count(catalogKey)>previous);checks.push('account change reloads the visible catalog');
 slow=4000;previous=count(catalogKey);request=page.waitForRequest(r=>new URL(r.url()).pathname===catalogKey&&!new URL(r.url()).search);await refresh().click();revision++;await request;slow=false;
 await page.waitForFunction(()=>document.querySelector('#codex-models-details [data-refresh-models]').getAttribute('aria-busy')==='false');assert.ok(count(catalogKey)>previous);assert.equal(await details('codex').locator('.proxy-model').count(),1);checks.push('invalidation during loading cancels the old request and starts a fresh one');
 const layouts=[];
 for(const width of [1360,800,390]){
  await page.setViewportSize({width,height:900});let anchor;
  for(const [id,name] of Object.entries(names)){
   await page.getByRole('tab',{name,exact:true}).click();
   const box=await toggle(id).boundingBox();anchor||=box;assert.equal(box.x,anchor.x);assert.equal(box.width,anchor.width);assert.equal(box.y,anchor.y);assert.equal(box.height,anchor.height);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));layouts.push({width,source:id,box});
  }
  await page.screenshot({path:path.join(output,'models-'+width+'.png'),fullPage:true});
 }
 checks.push('five related source layouts align at wide, medium and narrow widths');assert.deepEqual(errors,[]);
 const report={checks,errors,layouts,requests:Object.fromEntries(counts),scope:'isolated UI with mock proxy responses'};
 await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:checks.length,errors,output}));
}finally{await browser.close();await server.closeProxy();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(directory,{recursive:true,force:true});}
