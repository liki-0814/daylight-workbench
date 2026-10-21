// Isolated settings UI acceptance. All proxy/AI requests use synthetic fixtures.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {createTaskWorkbench,closeWorkbench} from '../fixtures/workbench.mjs';
const {chromium}=await import(process.env.DAYLIGHT_PLAYWRIGHT_MODULE||'playwright');
const dir=await mkdtemp(path.join(os.tmpdir(),'daylight-proxy-settings-')),output=path.resolve(process.argv[2]||'.local/verification/proxy-settings');await mkdir(output,{recursive:true});
const server=await createTaskWorkbench(dir);await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser,running=false,statusFailure=false,saveFailure=false,port=4319,autoStart=false,runtimeError='',hold,rotations=0;
const names={qoder:'Qoder',agy:'AGY',grok:'Grok',codex:'Codex',kimi:'Kimi',copilot:'GitHub Copilot'},writes=[],errors=[],checks=[];
try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/ai/**',async route=>{
  const op=new URL(route.request().url()).pathname.split('/').at(-1);
  const settings={backend:'qoder',qoder:{path:'/fixture/qoder',model:'fixture-model',effort:'high',accessMode:'standard',contextWindow:100000},codex:{path:'/fixture/codex',model:'fixture-model',accessMode:'standard'}};
  const body=op==='settings'?{settings}:{path:'/fixture/qoder',models:[{id:'fixture-model',name:'Fixture Model',efforts:['low','high'],contextWindows:[100000,200000]}]};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.route('**/api/proxy/**',async route=>{
  const url=new URL(route.request().url()),op=url.pathname.slice('/api/proxy/'.length),bodyIn=route.request().postDataJSON();let body;
  if(op==='status'){
   if(hold)await hold.promise;
   if(statusFailure)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'模拟状态读取失败'})});
   body={state:running?'running':'stopped',native:true,runtimeError,activeRequests:0,port,autoStart,baseUrl:`http://127.0.0.1:${port}/v1`,node:{version:'v22.0.0',path:'/fixture/node'},sources:Object.fromEntries(Object.keys(names).map(id=>[id,{connected:true}]))};
  }else if(op==='sources')body={sources:Object.entries(names).map(([id,name])=>({id,name,configured:true,connected:true,identityKey:'fixture',revision:'fixture',authentication:{operations:['refresh']},capabilities:{quota:true}}))};
  else if(op==='view')body={version:0,hiddenSources:[]};
  else if(op==='key')body={apiKey:'synthetic-key-'+rotations};
  else if(op==='key/rotate'){rotations++;body={ok:true};}
  else if(op==='settings'){
   if(saveFailure)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'模拟保存失败'})});
   writes.push(bodyIn);port=bodyIn.port;autoStart=bodyIn.autoStart;body={ok:true};
  }else if(op==='runtime'){writes.push(bodyIn);body={ok:true};}
  else if(op==='routes')body={routes:[]};
  else if(op==='model-metadata'||op.endsWith('/models'))body={models:[]};
  else if(op.endsWith('/quota'))body={buckets:[]};
  else throw Error('Unexpected proxy request: '+op);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 const settings=page.locator('#settings-page'),form=settings.locator('#settings-form'),refresh=settings.getByRole('button',{name:'刷新代理设置',exact:true});
 const sidebar=name=>page.locator('.sidebar').getByRole('button',{name,exact:true});
 const reloadSettings=async()=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/proxy/status');await refresh.click();await response;await page.waitForFunction(()=>document.querySelector('#refresh-proxy-settings').getAttribute('aria-busy')==='false');};
 hold=Promise.withResolvers();await page.goto(`http://127.0.0.1:${server.address().port}/#settings`);await settings.getByText('正在读取代理状态…',{exact:true}).waitFor();hold.resolve();hold=null;
 await form.locator('#proxy-port').waitFor({state:'visible'});await settings.locator('.ai-settings [name="path"]').waitFor();assert.equal(await page.locator('#settings-form').count(),1);assert.equal(await page.locator('#proxy-page #settings-form').count(),0);checks.push('direct settings entry loads the single shared proxy settings form');
 await form.locator('#proxy-port').fill('4390');await form.getByRole('checkbox',{name:'随 Daylight 启动代理'}).check();await sidebar('反向代理').click();
 for(const name of ['Qoder','Kimi','Copilot','Codex','模型路由','账户额度']){await page.getByRole('tab',{name,exact:true}).click();assert.equal(await page.locator('#proxy-page #settings-details,#proxy-page #settings-form,.proxy-footer').count(),0);}
 await sidebar('设置').click();assert.equal(await form.locator('#proxy-port').inputValue(),'4390');assert(await form.getByRole('checkbox',{name:'随 Daylight 启动代理'}).isChecked());assert.equal(await page.locator('#settings-form').count(),1);checks.push('all related tabs omit the footer; unsaved proxy settings survive navigation');
 await form.getByRole('button',{name:'保存设置',exact:true}).click();await form.getByText('设置已保存',{exact:true}).waitFor();assert.deepEqual(writes,[{port:4390,autoStart:true}]);
 saveFailure=true;await form.locator('#proxy-port').fill('4391');await form.getByRole('button',{name:'保存设置',exact:true}).click();await form.getByText('模拟保存失败',{exact:true}).waitFor();assert.equal(await form.locator('#proxy-port').inputValue(),'4391');saveFailure=false;checks.push('save payload, failure feedback and dirty field retention');
 const rotate=form.getByRole('button',{name:'更换 API Key',exact:true});await rotate.click();const dialog=page.getByRole('dialog',{name:'更换 API Key？',exact:true});await dialog.waitFor();assert.equal(await page.locator('#proxy-page').isVisible(),false);await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(rotations,0);assert(await rotate.evaluate(e=>e===document.activeElement));
 await rotate.click();await dialog.getByRole('button',{name:'更换密钥',exact:true}).click();await form.getByText('密钥已更换，请更新客户端配置',{exact:true}).waitFor();assert.equal(rotations,1);checks.push('shared confirmation works from left settings; Escape cancels and restores focus');
 running=true;await reloadSettings();await form.locator('#settings-readonly').waitFor({state:'visible'});assert(await form.locator('#proxy-port').isDisabled());assert(await form.locator('#node-path').isDisabled());assert.equal(await form.locator('#settings-actions').isVisible(),false);checks.push('running proxy locks port, runtime and key changes');
 running=false;runtimeError='模拟 Node 不可用';await reloadSettings();assert(await form.locator('#save-node').isEnabled());assert(await form.locator('#save-settings').isDisabled());await settings.getByRole('alert').getByText('模拟 Node 不可用',{exact:true}).waitFor();runtimeError='';await reloadSettings();
 statusFailure=true;await reloadSettings();await settings.getByRole('alert').getByText('模拟状态读取失败',{exact:true}).waitFor();statusFailure=false;await reloadSettings();assert.equal(await settings.locator('[role="alert"]:visible').count(),0);checks.push('runtime repair remains available and status error recovers');
 const layouts=[];
 for(const width of [1440,1000,390]){
  await page.setViewportSize({width,height:1000});
  for(const backend of ['Qoder','Codex']){
   const field=settings.locator('workbench-select').filter({has:page.locator('input[name="backend"]')});await field.locator('.select-trigger').click();await field.getByRole('option',{name:backend,exact:true}).click();
   await settings.locator('.ai-settings [name="path"]').waitFor();
   await settings.locator('.ai-settings form').waitFor({state:'visible'});
   const {card,formBox}=await settings.locator('.ai-settings').evaluate(e=>({card:e.getBoundingClientRect().toJSON(),formBox:e.querySelector('form').getBoundingClientRect().toJSON()}));
   const padding=await settings.locator('.ai-settings').evaluate(e=>Number.parseFloat(getComputedStyle(e).paddingRight));assert(Math.abs(card.x+card.width-padding-1-formBox.x-formBox.width)<1.1,JSON.stringify({width,backend,card,formBox,padding}));
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));layouts.push({width,backend,cardWidth:card.width,formWidth:formBox.width});
  }
  await page.screenshot({path:path.join(output,'settings-'+width+'.png'),fullPage:true});
 }
 checks.push('Qoder and Codex forms fill their cards at wide, medium and narrow widths without overflow');
 await page.setViewportSize({width:1440,height:1000});await settings.locator('.ai-settings').screenshot({path:path.join(output,'ai-settings.png')});await settings.locator('.proxy-global-settings').screenshot({path:path.join(output,'proxy-settings.png')});assert.deepEqual(errors,[]);
 await writeFile(path.join(output,'report.json'),JSON.stringify({checks,layouts,errors,scope:'isolated browser with synthetic proxy and AI responses'},null,2));console.log(JSON.stringify({passed:checks.length,errors,output}));
}finally{hold?.resolve();await browser?.close();await closeWorkbench(server);await rm(dir,{recursive:true,force:true});}
