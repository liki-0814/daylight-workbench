import {validateModelSetting} from './shared/contracts.js';
import {send,readBody,fail} from './gateway.js';
import {RequestTrace} from './shared/request-records.js';
import {events,observeResponse} from './shared/protocol.js';
import {normalizeQuota} from './shared/quota.js';

export const legacyReadResources={'pi.state':'/api/cli/pi/state','qoder.credits':'/api/qoder/credits','agy.quota':'/api/agy/quota','grok.quota':'/api/grok/quota','kimi.quota':'/api/kimi-proxy/quota','codex.quota':'/api/codex-proxy/quota','qoder.login':'/api/proxy/status'};
export function createLegacyReader(call) {
 return async(resource,options={})=>{
  if(resource==='pi.prepare')return call('/api/cli/pi/prepare',options);
  const route=legacyReadResources[resource];if(!route)fail('读取资源不存在');
  if(resource==='pi.state'&&Object.keys(options).some(k=>!['api','refresh'].includes(k)))fail('Pi 参数无效');
  const query=resource==='pi.state'?new URLSearchParams({...options.api?{api:options.api}:{},...options.refresh?{refresh:'1'}:{}}).toString():'';
  let result=await call(route+(query?'?'+query:''));
  if(resource==='qoder.login'){
   if(result.login){await call('/api/proxy/sources/qoder/auth/poll');result=await call('/api/proxy/status');}
   return Object.fromEntries(Object.entries(result).filter(([key])=>['account','login','state','port','autoStart'].includes(key)));
  }
  return result;
 };
}

const legacy={qoder:'qoder',agy:'agy',grok:'grok','codex-proxy':'codex','kimi-proxy':'kimi'};

// Direct operations and HTTP routes share this boundary. No fake req/res for tools.
export function createManagement({registry,router,sourceState,records,status,sources,service,pi,getTools}){
 const {providers,custom}=registry;
 function provider(id){const p=providers[id];if(!p)fail('来源不存在或未启用',404);return p;}
 async function listModels(id,refresh=false){return router.refreshSource(id,refresh);}
 async function updateModel(id,input){
  const source=provider(id);
  if(typeof source.setModel!=='function')fail('请在来源配置中编辑并保存模型',400);
  const model=(router.catalogs?.get(id)||await listModels(id)).find(m=>m.id===input.id);if(!model)fail('模型不存在',400);
  validateModelSetting(model,input);
  const models=await source.setModel(input);router.setCatalog(id,models);return{models};
 }
 async function syncSources(){
  const {next,removed}=await registry.sync();
  for(const id of removed)router.invalidateSource(id);
  for(const [id,p] of Object.entries(next))router.setCatalog(id,await p.listModels());
 }
 async function discoverCustom(input,{withKeys=false}={}){
  if(!custom)fail('自定义上游未启用',404);
  const source=typeof input==='object'?input:(await custom.list()).find(s=>s.id===input);
  try{const result=await custom.discoverAll(input);if(typeof input==='string')sourceState.discovered(source,result.models);return withKeys?result:result.models;}
  catch(error){if(typeof input==='string'&&source)sourceState.discovered(source,null,error);throw error;}
 }
 async function catalogStatus(id,refresh=false){
  const p=provider(id);
  let result;
  if(p.status)result=await p.status(refresh);
  else{try{await listModels(id,refresh);result={connected:true};}catch{result={connected:false,error:'无法连接来源，请检查登录状态与网络'};}}
  if(result.connected){router.failedAt.delete(id);await listModels(id);}
  else router.setCatalog(id,undefined,new Error('Source unavailable'));
  return result;
 }
 async function auth(id,operation){
  const p=provider(id),description=registry.snapshot(id);
  if(!description.authentication.operations.includes(operation))fail('来源不支持此认证操作',404);
  if(description.authentication.requiresStoppedService&&['login','logout'].includes(operation))return service.accountChange(operation,async()=>{const result=await p.auth[operation]();if(operation==='logout'){sourceState.invalidate(id);router.invalidateSource(id);}return result;});
  if(operation==='refresh')return catalogStatus(id,true);
  const result=await p.auth[operation]();
  if(result.authorized||operation==='logout'){sourceState.invalidate(id);router.invalidateSource(id);}
  return result;
 }
 async function inferenceCheck(id,modelId){
  const p=provider(id),model=(await listModels(id)).find(m=>m.enabled&&(!modelId||m.id===modelId));if(!model)fail('请先保存并启用至少一个模型');
  const protocol=registry.snapshot(id).nativeProtocols[0],endpoint={chat:'/chat/completions',responses:'/responses',messages:'/messages'}[protocol];
  const budget=registry.snapshot(id).capabilities.requestOutputBudget!==false?protocol==='responses'?{max_output_tokens:32}:{max_tokens:32}:{};
  const raw={model:model.id,stream:false,...budget,...(protocol==='responses'?{input:'Reply OK'}:{messages:[{role:'user',content:'Reply OK'}]})};
  const trace=new RequestTrace(endpoint);trace.observe({origin:'test',provider:id,model:model.id,streaming:false,sourceRevision:sourceState.revision(id,p),upstreamModel:model.upstreamId||model.id});let code=200;
  try{
   const result=await registry.execute(id,{raw,protocol,model},{signal:AbortSignal.timeout(60000),observe:info=>trace.observe(info)});
   if(result.kind==='response'){
    const response=result.response;trace.observe({upstreamStatus:response.status,upstreamProtocol:result.protocol,execution:'native'});
    if(!response.ok){await response.body?.cancel();fail(`推理测试失败（${response.status}）`,response.status);}
    if(result.streaming||response.headers.get('content-type')?.includes('text/event-stream')){
     for await(const event of events(response,result.protocol,model.id,info=>trace.observe(info)))trace.event(event);
    }else{
     const data=await response.json();observeResponse(data,result.protocol,info=>trace.observe(info));
     if(data.error||(!data.choices&&!data.content&&!data.output))fail('上游未返回有效的模型响应');
     trace.observe({finish:data.status==='incomplete'||data.choices?.[0]?.finish_reason==='length'||data.stop_reason==='max_tokens'?'length':'stop'});
    }
   }else{for await(const event of result.events){trace.event(event);if(event.type==='error')throw Object.assign(new Error(event.message),{code:event.code,status:502});}}
   if(!['completed','truncated'].includes(trace.entry.outcome))fail('上游未返回成功的完整推理响应',502);
   return {message:'推理请求成功；流式与工具能力需按实际使用验证。'};
  }catch(error){code=error.status||502;trace.fail(error);throw error;}finally{await records.append(trace.finish(code,code));}
 }
 async function customOperation(operation,input){
  if(!custom)fail('自定义上游未启用',404);
  if(operation==='sources'){await router.listModels().catch(()=>{});return{sources:await custom.list(),conflicts:router.conflicts};}
  if(operation==='key')return{apiKey:await custom.readKey(input.id,input.keyId)};
  if(operation==='save'){const source=await custom.save(input);sourceState.invalidate('custom:'+source.id);await syncSources();return{source};}
  if(operation==='delete'){await custom.remove(input.id);await router.forgetSource('custom:'+input.id);sourceState.invalidate('custom:'+input.id);await syncSources();return{ok:true};}
  if(operation==='discover')return discoverCustom(input.config||input.id,{withKeys:true});
  if(operation==='test')return inferenceCheck('custom:'+input.id);
  fail('接口不存在',404);
 }
 async function sourceOperation(id,operation,input,query){
  const p=provider(id);
  if(operation==='status')return catalogStatus(id,query.has('refresh'));
  if(operation==='models')return{models:await listModels(id,query.has('refresh'))};
  if(operation==='models/setting')return updateModel(id,input);
  if(operation==='quota'){
   if(!registry.snapshot(id).capabilities.quota)fail('来源不支持额度查询',404);
   return normalizeQuota(await p.quota());
  }
  if(operation.startsWith('auth/'))return auth(id,operation.slice(5));
  if(operation==='check'){
   if(!['catalog','inference'].includes(input.kind))fail('检查类型需为 catalog 或 inference');
   return input.kind==='inference'?inferenceCheck(id,input.model):{models:await listModels(id,true),message:'模型目录检查成功（未发送推理请求）'};
  }
  fail('接口不存在',404);
 }
 async function call(url,input,method=input===undefined?'GET':'POST'){
  const parsed=new URL(url,'http://localhost'),route=parsed.pathname,query=parsed.searchParams;
  const requireMethod=expected=>{if(method!==expected)fail('接口不存在',404);};
  if(route.startsWith('/api/cli/pi/')){
   const op=route.slice('/api/cli/pi/'.length);if(!['state','prepare','apply','restore','automatic','configuration'].includes(op))fail('接口不存在',404);
   requireMethod(op==='state'?'GET':'POST');return op==='state'?pi.state(query.get('api')||undefined,query.has('refresh')):pi[op](input);
  }
  if(route.startsWith('/api/proxy-tools/')){
   const op=route.slice('/api/proxy-tools/'.length);if(!['state','prepare','discover','test','apply','loginState','requests','read'].includes(op))fail('接口不存在',404);
   requireMethod(op==='state'?'GET':'POST');return getTools()[op](input);
  }
  if(route==='/api/proxy/routes'){
   if(method==='POST'){await router.routes();return router.saveRoute(input);}requireMethod('GET');return{routes:await router.routes({refresh:query.get('refresh')==='1',retry:query.get('retry')||undefined})};
  }
  if(['/api/proxy/status','/api/proxy/sources','/api/proxy/requests'].includes(route)){
   requireMethod('GET');if(route.endsWith('/status'))return{...await status(),recordsError:records.error};if(route.endsWith('/sources'))return{sources:await sources()};
   const filters=Object.fromEntries(query),limit=filters.limit===undefined?100:Number(filters.limit);if(!Number.isInteger(limit)||limit<1||limit>1000)fail('记录数量需为 1–1000 的整数');return records.query({...filters,limit});
  }
  if(['/api/proxy/service','/api/proxy/settings','/api/proxy/key','/api/proxy/key/rotate','/api/proxy/check','/api/proxy/runtime'].includes(route)){
   const op=route.slice('/api/proxy/'.length);requireMethod(op==='key'?'GET':'POST');
   if(op==='runtime')fail('请在桌面端设置 Node 运行环境',404);
   if(op==='check')return service.check();return service[op](input);
  }
  const customMatch=/^\/api\/(?:custom-proxy|proxy\/custom)\/(sources(?:\/(?:save|delete|discover|key))?|save|delete|discover|key|test)$/.exec(route);
  if(customMatch){const op=customMatch[1].replace(/^sources\//,'');requireMethod(op==='sources'?'GET':'POST');return customOperation(op,input);}
  const match=/^\/api\/proxy\/sources\/([^/]+)\/(status|models(?:\/setting)?|quota|auth\/(?:login|poll|cancel|refresh|logout)|check)$/.exec(route);
  if(match){const op=match[2];requireMethod(['status','models','quota','auth/poll'].includes(op)?'GET':'POST');return sourceOperation(decodeURIComponent(match[1]),op,input,query);}
  const old=/^\/api\/([^/]+)\/(.+)$/.exec(route),id=old&&legacy[old[1]],op=old?.[2];
  if(!id)fail('接口不存在',404);provider(id);
  if(id==='qoder'){
   if(['status','key','credits','usage','models'].includes(op)){requireMethod('GET');if(op==='status')return status();if(op==='key')return service.key();if(op==='credits')return providers[id].credits();if(op==='usage')return records.legacy();return sourceOperation(id,op,input,query);}
   requireMethod('POST');
   if(['service','settings','key/rotate','test'].includes(op))return service[op==='test'?'check':op](input);
   if(op==='auth/device')return auth(id,'login');
   if(op==='auth/logout'){await auth(id,'logout');return status();}
   if(op.startsWith('auth/'))return auth(id,op.slice(5));
   if(op==='models/setting')return updateModel(id,input);
  }else{
   requireMethod(op==='models/setting'||op==='test'||op==='auth/login'||op==='auth/cancel'?'POST':'GET');
   if(op==='quota')return providers[id].quota(); // Original shapes stay intact.
   if(op==='test'&&id==='kimi'){const result=await inferenceCheck(id);return{...result,message:'Kimi 推理请求成功；流式与工具调用需分别验证。'};}
   if(op==='models'&&['agy','grok'].includes(id)){const result=await sourceOperation(id,op,input,query);return{...result,discoveredAt:new Date(registry.snapshot(id).checkedAt).toISOString()};}
   return sourceOperation(id,op,input,query);
  }
  fail('接口不存在',404);
 }
 async function handle(req,res){
  try{const input=req.method==='GET'?undefined:await readBody(req);if(input!==undefined&&(!input||typeof input!=='object'||Array.isArray(input)))fail('请求格式不正确');send(res,200,await call(req.url,input,req.method));}
  catch(error){send(res,error.status||502,{error:error.status?error.message:'操作失败，请检查对应来源的登录状态、网络或本地配置'});}
 }
 return{handle,call,listModels,discoverCustom,testCustom:(id,model)=>inferenceCheck('custom:'+id,model),syncSources};
}
