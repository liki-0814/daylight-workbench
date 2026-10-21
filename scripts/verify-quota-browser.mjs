// Shared UI acceptance with synthetic accounts; never accesses installed-App credentials.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTaskWorkbench,closeWorkbench} from '../fixtures/workbench.mjs';
import {copilotQuota} from '../proxy/copilot/quota.js';
import {kimiQuota} from '../proxy/kimi/quota.js';
import {normalizeQuota} from '../proxy/shared/quota.js';
const {chromium}=await import(process.env.DAYLIGHT_PLAYWRIGHT_MODULE||'playwright');
const directory=await mkdtemp(path.join(os.tmpdir(),'daylight-quota-ui-')),output=path.resolve(process.argv[2]||'.local/verification/quota');await mkdir(output,{recursive:true});
const server=await createTaskWorkbench(directory);await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser,identity='account-a',mode='normal',hold;
const names={qoder:'Qoder',agy:'AGY',grok:'Grok',codex:'Codex',kimi:'Kimi',copilot:'GitHub Copilot'},errors=[],checks=[],counts=new Map();
const quotas={
 qoder:{buckets:[{name:'团队资源包',unit:'credits',limit:26000,used:19761,remaining:6239}]},
 agy:{buckets:[{name:'Gemini',period:'5 小时',unit:'percent',usedPercent:15}]},
 grok:{buckets:[{name:'本月',unit:'percent',usedPercent:0}]},
 codex:{buckets:[]},
 kimi:kimiQuota({usage:{limit:100,remaining:100,resetAt:new Date(Date.now()+86400000).toISOString()},limits:[{window:{duration:5,timeUnit:'TIME_UNIT_HOUR'},detail:{limit:100,used:0,resetAt:new Date(Date.now()+7200000).toISOString()}}]}),
 copilot:copilotQuota({token_based_billing:true,copilot_plan:'individual_max',quota_reset_date:'2026-11-01',quota_snapshots:{premium_interactions:{entitlement:20000,quota_remaining:19677.6,percent_remaining:98.3},chat:{unlimited:true},completions:{unlimited:true}}}),
};
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.DAYLIGHT_CHROME_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/proxy/**',async route=>{
  const url=new URL(route.request().url()),key=url.pathname;counts.set(key,(counts.get(key)||0)+1);let body;
  if(key==='/api/proxy/status')body={state:'stopped',activeRequests:0,sources:Object.fromEntries(Object.keys(names).map(id=>[id,{connected:true}]))};
  else if(key==='/api/proxy/sources')body={sources:Object.entries(names).map(([id,name])=>({id,name,configured:true,connected:true,identityKey:identity,revision:identity,account:{login:identity+'@example.test'},authentication:{operations:['refresh']},capabilities:{quota:true}}))};
  else if(key.endsWith('/view'))body={version:0,hiddenSources:[]};
  else if(key.endsWith('/key'))body={apiKey:'synthetic-key'};
  else if(key.endsWith('/model-metadata'))body={models:[],meta:{}};
  else if(key.endsWith('/routes'))body={routes:[]};
  else if(key.endsWith('/models'))body={models:[]};
  else if(key.endsWith('/quota')){
   const requestIdentity=identity,requestMode=mode;
   if(hold)await hold.promise;
   if(requestMode==='error'&&key.includes('/kimi/'))return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'synthetic quota failure'})});
   body=requestMode==='empty'?{buckets:[]}:{...quotas[key.split('/')[4]],checkedAt:new Date().toISOString()};
   if(requestIdentity==='account-b'&&key.includes('/copilot/'))body={buckets:[{name:'AI Credits',unit:'credits',limit:20000,remaining:10000}],checkedAt:new Date().toISOString()};
   body=normalizeQuota(body);
  }else throw Error('Unexpected quota fixture request: '+key);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 const tab=name=>page.getByRole('tab',{name,exact:true}),panel=page.locator('#proxy-panel-quota'),refresh=panel.getByRole('button',{name:'刷新账户额度',exact:true});
 const settled=()=>page.waitForFunction(()=>document.querySelector('#proxy-panel-quota [data-quota-accounts]').getAttribute('aria-busy')==='false');
 const reload=async()=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/proxy/sources/copilot/quota');await refresh.click();await response;await settled();};
 await page.goto(`http://127.0.0.1:${server.address().port}/#proxy`);await tab('账户额度').waitFor();
 assert.equal(await page.locator('[data-refresh-quota]').count(),1);
 for(const name of ['Qoder','Kimi','Copilot','Codex']){await tab(name).click();assert.equal(await page.locator('#proxy-panel-'+(name==='Copilot'?'copilot':name.toLowerCase())).locator('[data-refresh-quota]').count(),0);}
 assert.equal([...counts.keys()].filter(key=>key.endsWith('/quota')).length,0);checks.push('provider pages have no quota UI and do not fetch quota');
 hold=Promise.withResolvers();await tab('账户额度').click();await panel.getByText('正在读取额度…',{exact:true}).first().waitFor();hold.resolve();hold=null;
 await panel.getByText('98.39%',{exact:true}).waitFor();await settled();
 assert.equal(await panel.locator('[data-quota-source="codex"]').count(),0);assert.doesNotMatch(await panel.textContent(),/未提供|暂无占比|Premium 请求/);
 assert.equal(await panel.locator('[data-quota-source="kimi"] progress').count(),2);assert.equal(await panel.locator('[data-quota-source="copilot"] progress').count(),1);
 assert.match(await panel.textContent(),/19,677.6 \/ 20,000 Credits/);checks.push('loading, AI Credits, exact remaining percentage, Kimi windows and omitted Codex placeholders');
 const colors=await panel.locator('[data-quota-source]').evaluateAll(rows=>rows.map(row=>({source:row.dataset.quotaSource,colors:[...row.querySelectorAll('progress')].map(meter=>getComputedStyle(meter).accentColor)})));
 assert.equal(new Set(colors.map(row=>row.colors[0])).size,colors.length);assert(colors.every(row=>new Set(row.colors).size===1));
 await page.evaluate(async()=>{const {createProgressMeter}=await import('/components/progress-meter.js');const meter=createProgressMeter({label:'Default component regression'});meter.setValue(0.5);document.body.append(meter.element);const actual=getComputedStyle(meter.element).accentColor,expected=document.createElement('div');expected.style.color='var(--green)';document.body.append(expected);if(actual!==getComputedStyle(expected).color)throw Error('Default progress color changed');meter.dispose();expected.remove();});
 checks.push('source colors are distinct, windows share their source color and default shared meter stays green');
 for(const width of [1440,900,390]){
  await page.setViewportSize({width,height:1000});let anchor;
  for(const name of ['Qoder','Kimi','Copilot','Codex','模型路由','账户额度']){
   await tab(name).click();const selected=await page.locator('[role="tabpanel"]:visible').boundingBox();anchor||=selected;
   assert(Math.abs(selected.x-anchor.x)<1.1);assert(Math.abs(selected.width-anchor.width)<1.1);assert(Math.abs(selected.y-anchor.y)<1.1);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  }
  await settled();await page.screenshot({path:path.join(output,'quota-'+width+'.png'),fullPage:true});
 }
 checks.push('six related tabs share container anchors at 1440, 900 and 390px without horizontal page overflow');
 await page.setViewportSize({width:1440,height:1000});await tab('模型路由').click();await tab('模型路由').focus();await page.keyboard.press('ArrowRight');assert.equal(await tab('账户额度').getAttribute('aria-selected'),'true');assert(await tab('账户额度').evaluate(e=>e===document.activeElement));
 await panel.locator('.proxy-quota-panel').screenshot({path:path.join(output,'overview.png')});
 const keyboardResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/proxy/sources/copilot/quota');await refresh.focus();await page.keyboard.press('Enter');await keyboardResponse;await settled();assert(await refresh.evaluate(e=>e===document.activeElement));checks.push('keyboard tab selection and refresh focus retention');
 mode='error';await reload();await panel.getByText('刷新失败 · 显示上次数据，请点击刷新重试。',{exact:true}).waitFor();assert.equal(await panel.locator('[data-quota-source="kimi"] progress').count(),2);
 mode='normal';await reload();assert.equal(await panel.getByRole('alert').count(),0);checks.push('one source failure retains its last data, does not block others and recovers');
 mode='empty';await reload();await panel.getByText('暂无可展示的账户额度',{exact:true}).waitFor();assert.equal(await panel.locator('progress').count(),0);checks.push('empty results omit source rows without fabricated values');
 mode='normal';await reload();await panel.getByText('98.39%',{exact:true}).waitFor();await settled();
 hold=Promise.withResolvers();await refresh.click();await page.waitForFunction(()=>document.querySelector('#proxy-panel-quota [data-quota-accounts]').getAttribute('aria-busy')==='true');
 identity='account-b';await page.waitForTimeout(3300);hold.resolve();hold=null;
 await panel.getByText('50%',{exact:true}).waitFor();await settled();assert.doesNotMatch(await panel.textContent(),/account-a|98.39%|19,677.6/);checks.push('account switch during in-flight refresh discards old balances and identity');
 await page.getByRole('button',{name:'显示来源',exact:true}).click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');assert(await tab('账户额度').isVisible());checks.push('shared display dialog Escape and utility tab remain available');
 assert.deepEqual(errors,[]);await writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors,scope:'isolated browser with synthetic quota responses'},null,2));console.log(JSON.stringify({passed:checks.length,errors,output}));
}finally{hold?.resolve();await browser?.close();await closeWorkbench(server);await rm(directory,{recursive:true,force:true});}
