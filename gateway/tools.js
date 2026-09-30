import {createHash} from 'node:crypto';
import {readJson,writeJson,serial} from '../qoder/store.js';
import path from 'node:path';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sourceFields=['id','name','baseUrl','protocol','auth','enabled','models','endpoint','modelsEndpoint','defaultMaxTokens'];
const modelFields=['id','upstreamId','enabled','contextWindow','maxOutputTokens','defaultMaxTokens'];
const only=(value,keys)=>Object.fromEntries(Object.entries(value||{}).filter(([k])=>keys.includes(k)));
const prefix=id=>id==='codex'?'codex-proxy':id;
export function createProxyTools({call,custom,dataDir,discoverCustom=id=>custom.discover(id),getSources=async()=>[]}) {
  const mutate=serial(),file=path.join(dataDir,'proxy-tool-receipts.json');
  async function state() {
    const runtime=await call('/api/qoder/status');
    const sources=custom?await custom.list():[];
    const builtins=await Promise.all(['qoder','agy','grok','codex'].map(async id=>{
      try {const r=await call(`/api/${prefix(id)}/models`);return{id,kind:'builtin',models:r.models};}
      catch {return{id,kind:'builtin',models:[],error:'模型目录暂不可用，请检查登录状态或网络'};}
    }));
    const service=only(runtime,['state','port','autoStart','baseUrl','activeRequests']);
    const rows=[...builtins,...sources.map(s=>({...only(s,sourceFields),kind:'custom',hasKey:s.hasKey,hasHeaders:s.hasHeaders}))];
    const diagnostics=await getSources();
    for(const row of rows)row.diagnostics=diagnostics.find(s=>s.id===(row.kind==='custom'?'custom:'+row.id:row.id));
    return{version:hash({service:only(service,['state','port','autoStart']),sources:rows.map(s=>({...only(s,[...sourceFields,'kind','hasKey','hasHeaders']),models:s.models.map(m=>only(m,['id','upstreamId','enabled','contextWindow','maxOutputTokens','defaultMaxTokens','effort','fast','serviceTier']))}))}),service,sources:rows,
      operations:['source.save','source.enabled','model.setting','service.enabled'],credentials:'API Key 仅在用户审阅时填写，不得传入工具参数'};
  }
  async function prepare(input) {
    const a=input.action;if(!a||typeof a!=='object'||Array.isArray(a))fail('需要代理 action');
    // Credentials and arbitrary headers never belong in model-visible arguments.
    const allowed={ 'source.save':['type','source'], 'source.enabled':['type','sourceId','enabled'], 'model.setting':['type','sourceId','id','field','value'], 'service.enabled':['type','enabled'] };
    if(!allowed[a.type]||Object.keys(a).some(k=>!allowed[a.type].includes(k)))fail('代理操作或字段不支持');
    let action=structuredClone(a),requiresKey=false,impact=[];
    if(a.type==='source.save') {
      if(!custom)fail('自定义来源未启用');
      if(!a.source||Object.keys(a.source).some(k=>!sourceFields.includes(k)))fail('来源仅接受公开配置字段，不能包含 Key 或请求头');
      if(a.source.models?.some(m=>Object.keys(m).some(k=>!modelFields.includes(k))))fail('模型字段无效');
      const old=a.source.id?(await custom.list()).find(s=>s.id===a.source.id):null;
      if(a.source.id&&!old)fail('来源不存在');
      if(old?.hasKey&&a.source.baseUrl&&a.source.baseUrl!==old.baseUrl)impact.push('已保存的凭据将用于新的上游地址，请核对地址。');
      const source={...(old?only(old,sourceFields):{enabled:true,auth:'bearer',models:[]}),...a.source};
      const check={...source};if(!old)delete check.id;
      const validated=await custom.save(check,{validateOnly:true});
      action.source=only(validated.source,sourceFields);if(!old)delete action.source.id;
      requiresKey=action.source.enabled&&action.source.auth!=='none'&&!old?.hasKey;
    } else if(a.type==='source.enabled') {
      if(typeof a.enabled!=='boolean'||!(await custom.list()).some(s=>s.id===a.sourceId))fail('来源或开关无效');
      const s=(await custom.list()).find(s=>s.id===a.sourceId);requiresKey=a.enabled&&s.auth!=='none'&&!s.hasKey;
    } else if(a.type==='model.setting') {
      const snap=await state(),s=snap.sources.find(s=>s.id===a.sourceId),m=s?.models.find(m=>m.id===a.id);
      if(!m)fail('来源或模型不存在');
      const fields=s.kind==='custom'?['enabled','contextWindow','maxOutputTokens','defaultMaxTokens']:s.id==='codex'?['enabled','effort','serviceTier']:s.id==='grok'?['enabled','effort','maxTokens']:s.id==='agy'?['enabled','effort']:['enabled','context','effort','fast'];
      if(!fields.includes(a.field))fail('此来源不支持该模型设置');
      if(['enabled','fast'].includes(a.field)){if(typeof a.value!=='boolean')fail('开关必须为布尔值');}
      else if(['context','contextWindow','maxOutputTokens','defaultMaxTokens','maxTokens'].includes(a.field)){if(!Number.isSafeInteger(a.value)||a.value<1)fail('Token 参数必须为正整数');}
      else if(a.field==='effort'&&a.value!=='auto'&&!m.reasoningEfforts?.includes(a.value))fail('该模型未提供此思考强度');
      else if(a.field==='serviceTier'&&!['auto','default',...(m.serviceTiers||[]).map(t=>t.id)].includes(a.value))fail('该模型未提供此速度档位');
      if(a.field==='fast'&&a.value&&!m.supportsFast)fail('该模型不支持 Fast');
    } else if(typeof a.enabled!=='boolean')fail('开关必须为布尔值');
    return{action,requiresKey,impact};
  }
  async function discover({sourceId}) {
    const s=custom&&(await custom.list()).find(s=>s.id===sourceId);
    if(s)return{models:await discoverCustom(sourceId)};
    if(!['qoder','agy','grok','codex'].includes(sourceId))fail('来源不存在');
    return call(`/api/${prefix(sourceId)}/models?refresh=1`);
  }
  async function test({sourceId}) {
    // Read-only connectivity test; no inference cost or user prompts sent upstream.
    const result=sourceId?await discover({sourceId}):await call('/api/qoder/test',{});
    return{ok:true,message:sourceId?`模型目录读取成功，共 ${result.models.length} 个模型；未发送推理请求，生成和工具能力尚未验证。`:result.message};
  }
  async function apply(input) {return mutate(async()=>{
    if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId))fail('需要 requestId');
    const fingerprint=hash({action:input.action,expectedVersion:input.expectedVersion,apiKey:input.apiKey});
    const receipts=await readJson(file,[]),receipt=receipts.find(r=>r.id===input.requestId);
    if(receipt){if(receipt.fingerprint!==fingerprint)fail('requestId 已用于其他操作',409);return{ok:true,replayed:true,action:receipt.action};}
    if((await state()).version!==input.expectedVersion)fail('代理配置已发生变化，请取消草稿并重新核对',409);
    const p=await prepare(input),a=p.action;
    if(p.requiresKey&&!input.apiKey)fail('请在安全输入框填写 API Key');
    if(a.type==='source.save') {
      const old=(await custom.list()).some(s=>s.id===a.source.id);
      const source={...a.source,...(input.apiKey?{apiKey:input.apiKey}:{})};if(!old)delete source.id;
      const {source:saved}=await call('/api/custom-proxy/save',source);a.source.id=saved.id;
    } else if(a.type==='source.enabled'||a.type==='model.setting'&&(await custom.list()).some(s=>s.id===a.sourceId)) {
      const s=(await custom.list()).find(s=>s.id===a.sourceId),next={...only(s,sourceFields)};
      if(a.type==='source.enabled')next.enabled=a.enabled;
      else next.models=next.models.map(m=>m.id===a.id?{...m,[a.field]:a.value}:m);
      await call('/api/custom-proxy/save',{...next,...(input.apiKey?{apiKey:input.apiKey}:{})});
    } else if(a.type==='model.setting')await call(`/api/${prefix(a.sourceId)}/models/setting`,{id:a.id,field:a.field,value:a.value});
    else await call('/api/qoder/service',{enabled:a.enabled});
    await writeJson(file,[...receipts,{id:input.requestId,fingerprint,action:a}].slice(-100));
    return{ok:true,action:a};
  });}
  return{state,prepare,discover,test,apply};
}
