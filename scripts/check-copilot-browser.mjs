// Optional UI acceptance: node scripts/check-copilot-browser.mjs /path/to/playwright [output]
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createWorkbench} from '../server.mjs';
import {fixture} from '../fixtures/copilot/upstream.mjs';
if(!process.argv[2])throw Error('Pass the Playwright package directory');
const {chromium}=await import(pathToFileURL(path.join(process.argv[2],'index.mjs')));
const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-copilot-browser-')),output=process.argv[3]||path.join(dataDir,'screenshots');await mkdir(output,{recursive:true});
const f=fixture({dataDir}),stub=()=>({cache:{},listModels:async()=>[],auth:{login:async()=>({status:'pending'}),cancel:async()=>({status:'cancelled'})}});
const server=await createWorkbench({dataDir,proxyOptions:{provider:stub(),kimiProvider:stub(),copilotProvider:f.p,includeGateway:false,includeAgy:false,includeGrok:false,pricingOptions:{enabled:false},piOptions:{piDir:path.join(dataDir,'pi'),getInfo:async()=>({installed:true})}}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;const clock=setInterval(()=>f.advance(1000),1000),checks=[],errors=[];
try{
 browser=await chromium.launch({headless:true,channel:process.env.DAYLIGHT_BROWSER_CHANNEL||'chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port);await page.getByText('反向代理',{exact:true}).first().click();
 const tab=name=>page.getByRole('tab',{name,exact:true}),panel=page.locator('#proxy-panel-copilot');
 for(const width of [1440,900]){
  await page.setViewportSize({width,height:1000});const layouts=[];
  for(const [id,name] of [['qoder','Qoder'],['kimi','Kimi'],['copilot','Copilot']]){
   await tab(name).click();const p=page.locator('#proxy-panel-'+id);
   const rect=await p.locator('.proxy-account').boundingBox(),models=await p.locator('details').first().boundingBox();
   layouts.push({id,x:rect.x,width:rect.width,y:rect.y,modelX:models.x,modelY:models.y});
  }
  for(const layout of layouts.slice(1))for(const field of ['x','width','y','modelX','modelY'])assert(Math.abs(layout[field]-layouts[0][field])<1.1,JSON.stringify({width,layouts}));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));checks.push({width,layouts});
  await page.screenshot({path:path.join(output,`layout-${width}.png`),fullPage:true});
 }
 await page.setViewportSize({width:1440,height:1000});await tab('Kimi').click();await tab('Kimi').focus();await page.keyboard.press('ArrowRight');assert.equal(await tab('Copilot').getAttribute('aria-selected'),'true');assert(await tab('Copilot').evaluate(e=>e===document.activeElement));
 await page.getByRole('button',{name:'显示来源',exact:true}).click();const dialog=page.getByRole('dialog');assert(await dialog.isVisible());await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),false);checks.push('keyboard tabs, dialog Escape and focus');
 await panel.getByRole('button',{name:'网页登录',exact:true}).click();await panel.getByText('授权码：TEST-CODE',{exact:true}).waitFor();assert.equal(await panel.locator('[data-login-link]').getAttribute('href'),'https://github.com/login/device');
 await panel.getByRole('button',{name:'取消',exact:true}).click();await panel.locator('[data-login]').waitFor({state:'hidden'});
 f.setPoll({error:'access_denied'});await panel.getByRole('button',{name:'网页登录',exact:true}).click();await panel.getByText('授权已取消，请重新登录',{exact:true}).waitFor();assert.equal(await panel.locator('[data-login-link]').isVisible(),false);
 const polls=f.calls.filter(c=>c.url.endsWith('/access_token')).length;await page.waitForTimeout(3500);assert.equal(f.calls.filter(c=>c.url.endsWith('/access_token')).length,polls);await panel.getByRole('button',{name:'取消',exact:true}).click();
 await panel.locator('[data-login]').waitFor({state:'hidden'});f.setPoll({access_token:'synthetic-github-secret'});await panel.getByRole('button',{name:'网页登录',exact:true}).click();await panel.getByText('fixture-user',{exact:true}).waitFor();await panel.getByRole('button',{name:'退出账号',exact:true}).waitFor();checks.push('login, cancellation, denied terminal, automatic successful discovery');
 const details=panel.locator('details').first();await details.locator('summary').click();await panel.locator('.proxy-model-heading').filter({hasText:'Copilot Chat Fixture'}).first().waitFor();assert.equal(await panel.locator('select').count(),0);assert(await panel.locator('workbench-select').count()>0);
 const select=panel.locator('workbench-select').first();await select.locator('.select-trigger').focus();await page.keyboard.press('Enter');await page.keyboard.press('Escape');assert(await select.evaluate(e=>e.contains(document.activeElement)));checks.push('shared model fields and keyboard focus');
 assert.equal(await panel.locator('[data-refresh-quota]').count(),0);await tab('账户额度').click();await page.locator('#proxy-panel-quota').getByText('Premium 请求',{exact:true}).waitFor();await tab('Copilot').click();
 const modelsRoute='**/api/proxy/sources/copilot/models*';let release;const waiting=new Promise(r=>{release=r;});await page.route(modelsRoute,async route=>{await waiting;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({models:[]})});});
 await panel.getByRole('button',{name:'刷新模型',exact:true}).click();await panel.getByText('正在刷新模型…',{exact:true}).waitFor();release();await panel.getByText('账号暂无可用模型',{exact:true}).waitFor();await page.unroute(modelsRoute);
 await page.route(modelsRoute,route=>route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:'模拟目录失败'})}));await panel.getByRole('button',{name:'刷新模型',exact:true}).click();await panel.getByText('模拟目录失败',{exact:true}).waitFor();await page.unroute(modelsRoute);
 await panel.getByRole('button',{name:'刷新模型',exact:true}).click();await panel.locator('.proxy-model-heading').filter({hasText:'Copilot Chat Fixture'}).first().waitFor();checks.push('model loading, empty, failure and recovery');
 await page.screenshot({path:path.join(output,'connected.png'),fullPage:true});
 await page.getByText('CLI 配置',{exact:true}).first().click();await page.getByText('Pi',{exact:true}).first().waitFor();await page.getByText('反向代理',{exact:true}).first().click();await tab('Copilot').click();assert.equal(await panel.getByText('fixture-user',{exact:true}).isVisible(),true);checks.push('CLI page switch and return');
 assert.deepEqual(errors,[]);await writeFile(path.join(output,'checks.json'),JSON.stringify({checks,errors,dataDir},null,2));console.log(JSON.stringify({checks,errors,output}));
}finally{clearInterval(clock);await browser?.close();await server.closeProxy();server.closeAllConnections();await new Promise(r=>server.close(r));}
