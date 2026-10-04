import {createHash} from 'node:crypto';
import {readJson,writeJson,serial} from './store.js';
import path from 'node:path';
import { validateModelSetting } from './contracts.js';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sourceFields=['id','name','baseUrl','protocol','auth','enabled','models','endpoint','modelsEndpoint','defaultMaxTokens','keys'];
const modelFields=['id','upstreamId','enabled','contextWindow','maxOutputTokens','defaultMaxTokens','reasoningEfforts','effort','isVL','isReasoning','contextLimit','outputLimit'];
const only=(value,keys)=>Object.fromEntries(Object.entries(value||{}).filter(([k])=>keys.includes(k)));
const sourceURL = id => '/api/proxy/sources/' + encodeURIComponent(id);
const customModels = source => source.models.map(m => ({ ...m, settingFields: source.settingFields || [] }));
export function createProxyTools({call,custom,dataDir,discoverCustom=id=>custom.discover(id),getSources=async()=>[],getRoutes=async()=>[],readConfiguration=async()=>{fail('读取资源不存在');}}) {
  const mutate=serial(),file=path.join(dataDir,'proxy-tool-receipts.json');
  async function state() {
    const runtime=await call('/api/proxy/status');
    const sources=custom?await custom.list():[];
    const diagnostics=await getSources();
    const builtins=await Promise.all(diagnostics.filter(s=>s.kind!=='custom'&&!s.id.startsWith('custom:')).map(async description=>{
      const {id,authentication,capabilities}=description;
      try {const r=await call(sourceURL(id)+'/models');return{id,kind:'builtin',authentication,capabilities,models:r.models};}
      catch {return{id,kind:'builtin',authentication,capabilities,models:[],error:'模型目录暂不可用，请检查登录状态或网络'};}
    }));
    const service=only(runtime,['state','port','autoStart','baseUrl','activeRequests']);
    const rows=[...builtins,...sources.map(s=>({...only(s,sourceFields),kind:'custom',hasKey:s.hasKey,hasHeaders:s.hasHeaders,keys:s.keys,revision:s.revision,models:customModels(s)}))];
    const routes=await getRoutes();
    for(const row of rows)row.diagnostics=diagnostics.find(s=>s.id===(row.kind==='custom'?'custom:'+row.id:row.id));
    return{version:hash({account:only(runtime.account,['uid','organization']),routes:routes.map(r=>only(r,['id','order','excluded'])),service:only(service,['state','port','autoStart']),sources:rows.map(s=>({...only(s,[...sourceFields,'kind','hasKey','hasHeaders','keys','revision']),models:s.models.map(m=>only(m,['id','upstreamId','enabled','contextWindow','maxOutputTokens','defaultMaxTokens','effort','fast','serviceTier','contextWindows','reasoningEfforts','isVL','isReasoning']))}))}),service,sources:rows,routes,
      operations:['pi.configuration','pi.apply','pi.automatic','pi.restore','service.settings','source.save','source.enabled','source.delete','model.setting','route.save','auth.login','auth.cancel','auth.logout','service.enabled'],credentials:'API Key 仅在用户审阅时填写，不得传入工具参数'};
  }
  async function prepare(input) {
    const a=input.action;if(!a||typeof a!=='object'||Array.isArray(a))fail('需要代理 action');
    // Credentials and arbitrary headers never belong in model-visible arguments.
    const allowed={ 'source.save':['type','source'], 'source.enabled':['type','sourceId','enabled'], 'model.setting':['type','sourceId','id','field','value'], 'service.enabled':['type','enabled'], 'source.delete':['type','sourceId'], 'route.save':['type','id','order','excluded'], 'auth.login':['type','sourceId'], 'auth.cancel':['type','sourceId'], 'auth.logout':['type','sourceId'], 'service.settings':['type','port','autoStart'], 'pi.configuration':['type','options'], 'pi.apply':['type','options'], 'pi.automatic':['type','options'], 'pi.restore':['type','options'] };
    if(!allowed[a.type]||Object.keys(a).some(k=>!allowed[a.type].includes(k)))fail('代理操作或字段不支持');
    let action=structuredClone(a),requiresKey=false,requiresKeys=[],impact=[];
    if(a.type.startsWith('pi.')) {
      const options=a.options||{};
      const allowedPi={configuration:['api','modelOverrides'],apply:['api','defaultModel','modelOverrides'],automatic:['api','enabled'],restore:[]};
      if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!allowedPi[a.type.slice(3)].includes(k)))fail('Pi 配置字段不支持');
      if(a.type==='pi.automatic'&&typeof options.enabled!=='boolean')fail('自动同步开关需为布尔值');
      const snapshot=await call('/api/cli/pi/state'+(options.api?'?api='+encodeURIComponent(options.api):''));
      if(['pi.configuration','pi.apply'].includes(a.type))await call('/api/cli/pi/prepare',options);
      return{action,requiresKey:false,requiresKeys:[],version:snapshot.version,impact:[a.type==='pi.restore'?'将恢复上次 Pi 接入备份。':'将更新 Pi 配置；其他 providers 保留，同步前自动备份。']};
    } else if(a.type==='service.settings') {
      if(!Number.isInteger(a.port)||a.port<1024||a.port>65535||typeof a.autoStart!=='boolean')fail('代理端口或自动启动设置无效');
      if((await call('/api/proxy/status')).state!=='stopped')fail('请先停止代理再修改设置',409);
    } else if(a.type==='source.save') {
      if(!custom)fail('自定义来源未启用');
      if(!a.source||Object.keys(a.source).some(k=>!sourceFields.includes(k)))fail('来源仅接受公开配置字段，不能包含 Key 或请求头');
      if(a.source.models?.some(m=>Object.keys(m).some(k=>!modelFields.includes(k))))fail('模型字段无效');
      if(a.source.keys?.some(k=>!k||Object.keys(k).some(f=>!['id','enabled','models'].includes(f))||k.models?.some(m=>Object.keys(m).some(f=>!modelFields.includes(f)))))fail('Key 配置仅接受 id/enabled/models，不能包含凭据');
      const old=a.source.id?(await custom.list()).find(s=>s.id===a.source.id):null;
      if(a.source.id&&!old)fail('来源不存在');
      if(old?.hasKey&&a.source.baseUrl&&a.source.baseUrl!==old.baseUrl)impact.push('已保存的凭据将用于新的上游地址，请核对地址。');
      const source={...(old?only(old,sourceFields):{enabled:true,auth:'bearer',models:[]}),...a.source};
      const check={...source};if(a.source.keys&&a.source.models===undefined)delete check.models;if(!old)delete check.id;
      const validated=await custom.save(check,{validateOnly:true});
      action.source=only(validated.source,sourceFields);action.source.keys=validated.source.keys.map(k=>only(k,['id','enabled','models']));if(!old)delete action.source.id;
      requiresKeys=validated.source.enabled&&validated.source.auth!=='none'?validated.source.keys.filter(k=>k.enabled&&!k.hasKey).map((k,i)=>({id:k.id,label:'API Key '+(i+1)})):[];
      requiresKey=requiresKeys.length===1&&requiresKeys[0].id==='default';
    } else if(a.type==='source.enabled') {
      if(typeof a.enabled!=='boolean'||!(await custom.list()).some(s=>s.id===a.sourceId))fail('来源或开关无效');
      const s=(await custom.list()).find(s=>s.id===a.sourceId);requiresKeys=a.enabled&&s.auth!=='none'?s.keys.filter(k=>k.enabled&&!k.hasKey).map((k,i)=>({id:k.id,label:'API Key '+(i+1)})):[];requiresKey=requiresKeys.length===1&&requiresKeys[0].id==='default';
    } else if(a.type==='model.setting') {
      const snap=await state(),s=snap.sources.find(s=>s.id===a.sourceId),m=s?.models.find(m=>m.id===a.id);
      if(!m)fail('来源或模型不存在');
      validateModelSetting(m,a);
    } else if(a.type==='source.delete'){
      const source=custom&&(await custom.list()).find(s=>s.id===a.sourceId);if(!source)fail('自定义来源不存在');impact.push(`将删除来源“${source.name}”、模型配置及已保存的 Key；剩余来源按路由顺序接管。`);
    } else if(a.type==='route.save'){
      const route=(await getRoutes()).find(r=>r.id===a.id);if(!route||!Array.isArray(a.order)||!Array.isArray(a.excluded||[]))fail('模型路由无效');
      if(a.order.length!==route.order.length||new Set(a.order).size!==a.order.length||a.order.some(id=>!route.order.includes(id))||new Set(a.excluded||[]).size!==(a.excluded||[]).length||(a.excluded||[]).some(id=>!a.order.includes(id)))fail('路由来源不完整或无效');
      const primary=a.order.find(id=>!(a.excluded||[]).includes(id));if(!route.sources.find(s=>s.id===primary)?.available)fail('至少保留一个可用主用来源');action.excluded=a.excluded||[];impact.push('将更新该模型的主用与备用顺序，并清除旧会话来源绑定。');
    } else if(['auth.login','auth.cancel','auth.logout'].includes(a.type)){const source=(await getSources()).find(s=>s.id===a.sourceId);if(!source?.authentication?.operations?.includes(a.type.slice(5)))fail('此来源不支持该授权操作');impact.push(a.type==='auth.login'?'启动官方网页授权，需要用户在网页完成登录。':a.type==='auth.logout'?`退出 ${source.name||source.id} 登录；需要重新授权才能使用。`:'取消当前待完成的网页授权。');
    } else if(typeof a.enabled!=='boolean')fail('开关必须为布尔值');
    return{action,requiresKey,requiresKeys,impact};
  }
  async function discover({sourceId}) {
    const s=custom&&(await custom.list()).find(s=>s.id===sourceId);
    if(s){const discovered=await discoverCustom(sourceId);return Array.isArray(discovered)?{models:discovered}:discovered;}
    if(!(await getSources()).some(s=>s.id===sourceId))fail('来源不存在');
    return call(sourceURL(sourceId)+'/models?refresh=1');
  }
  async function test({sourceId}) {
    // Read-only connectivity test; no inference cost or user prompts sent upstream.
    const result=sourceId?await discover({sourceId}):await call('/api/proxy/check',{});
    return{ok:true,message:sourceId?`模型目录读取成功，共 ${result.models.length} 个模型；未发送推理请求，生成和工具能力尚未验证。`:result.message};
  }
  async function apply(input) {return mutate(async()=>{
    if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId))fail('需要 requestId');
    const fingerprint=hash({action:input.action,expectedVersion:input.expectedVersion,apiKey:input.apiKey,apiKeys:input.apiKeys});
    const receipts=await readJson(file,[]),receipt=receipts.find(r=>r.id===input.requestId);
    if(receipt){if(receipt.fingerprint!==fingerprint)fail('requestId 已用于其他操作',409);return{ok:true,replayed:true,action:receipt.action,...(receipt.action.type==='auth.login'?{login:(await loginState({sourceId:receipt.action.sourceId})).login}: {})};}
    if((input.action?.type?.startsWith('pi.')?(await call('/api/cli/pi/state'+(input.action.options?.api?'?api='+encodeURIComponent(input.action.options.api):''))).version:(await state()).version)!==input.expectedVersion)fail('代理配置已发生变化，请取消草稿并重新核对',409);
    const p=await prepare(input),a=p.action;
    if(input.apiKey!==undefined&&typeof input.apiKey!=='string')fail('安全 Key 输入无效');
    const apiKeys={...(input.apiKeys||{}),...(input.apiKey?{default:input.apiKey}:{})};
    if(input.apiKeys&&(!input.apiKeys||typeof input.apiKeys!=='object'||Array.isArray(input.apiKeys)||Object.values(input.apiKeys).some(k=>typeof k!=='string')))fail('安全 Key 输入无效');
    const keyIds=a.type==='source.save'?a.source.keys.map(k=>k.id):a.type==='source.enabled'?(await custom.list()).find(s=>s.id===a.sourceId).keys.map(k=>k.id):[];
    if(Object.keys(apiKeys).some(id=>!keyIds.includes(id)))fail('安全 Key 标识无效');
    for(const key of p.requiresKeys)if(!apiKeys[key.id])fail(`请在安全输入框填写 ${key.label}`);
    if(p.requiresKey&&!input.apiKey&&!apiKeys.default)fail('请在安全输入框填写 API Key');
    let login;
    if(a.type.startsWith('pi.'))await call('/api/cli/pi/'+a.type.slice(3),{...a.options,expectedVersion:input.expectedVersion,requestId:input.requestId});
    else if(a.type==='service.settings')await call('/api/proxy/settings',{port:a.port,autoStart:a.autoStart});
    else if(a.type==='source.save') {
      const old=(await custom.list()).some(s=>s.id===a.source.id);
      const source={...a.source,keys:a.source.keys?.map(k=>({...k,...(apiKeys[k.id]?{apiKey:apiKeys[k.id]}:{})})),...(input.apiKey?{apiKey:input.apiKey}:{})};if(!old)delete source.id;
      const {source:saved}=await call('/api/custom-proxy/save',source);a.source.id=saved.id;
    } else if(a.type==='source.delete')await call('/api/custom-proxy/delete',{id:a.sourceId});
    else if(a.type==='route.save')await call('/api/proxy/routes',{id:a.id,order:a.order,excluded:a.excluded});
    else if(a.type==='auth.login')login=await call(sourceURL(a.sourceId)+'/auth/login',{});
    else if(a.type==='auth.cancel')await call(sourceURL(a.sourceId)+'/auth/cancel',{});
    else if(a.type==='auth.logout')await call(sourceURL(a.sourceId)+'/auth/logout',{});
    else if(a.type==='source.enabled'||a.type==='model.setting'&&custom&&(await custom.list()).some(s=>s.id===a.sourceId)) {
      const s=(await custom.list()).find(s=>s.id===a.sourceId),next={...only(s,sourceFields)};
      if(a.type==='source.enabled')next.enabled=a.enabled;
      else next.models=next.models.map(m=>m.id===a.id?{...m,[a.field]:a.value}:m);
      next.keys=next.keys.map(k=>({...k,...(apiKeys[k.id]?{apiKey:apiKeys[k.id]}:{})}));
      await call('/api/custom-proxy/save',next);
    } else if(a.type==='model.setting')await call(sourceURL(a.sourceId)+'/models/setting',{id:a.id,field:a.field,value:a.value});
    else await call('/api/proxy/service',{enabled:a.enabled});
    await writeJson(file,[...receipts,{id:input.requestId,fingerprint,action:a}].slice(-100));
    return{ok:true,action:a,...(login?{login}:{})};
  });}
  async function loginState({sourceId}) {
    const source=(await getSources()).find(s=>s.id===sourceId);
    if(!source?.authentication?.operations?.includes('poll'))fail('此来源不支持网页授权状态查询');
    const status=await call(sourceURL(sourceId)+'/status');
    let login=null;try{login=await call(sourceURL(sourceId)+'/auth/poll');}catch{}
    return{connected:status.connected,error:status.error,login};
  }
  const read = ({resource,options={}}) => readConfiguration(resource,options);
  async function requests({limit=20}={}){if(!Number.isInteger(limit)||limit<1||limit>1000)fail('记录数量需为 1–1000 的整数');return call('/api/proxy/requests?limit='+limit);}
  return{state,prepare,discover,test,apply,loginState,requests,read};
}
