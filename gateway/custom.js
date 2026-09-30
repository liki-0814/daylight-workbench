import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readJson,writeJson,serial} from '../qoder/store.js';
import {invalid,convertRequest} from './protocol.js';
import {Secrets} from './secrets.js';
const paths={chat:'chat/completions',responses:'responses',messages:'messages'};
export class CustomSources {
 constructor({dataDir,fetchImpl=fetch,secrets=new Secrets(),getPort=()=>4319}){Object.assign(this,{fetchImpl,secrets,getPort});this.file=path.join(dataDir,'custom-proxy/sources.json');this.mutate=serial();}
 async list(){return await readJson(this.file,[]);}
 url(source,endpoint){let u;try{u=new URL(source.baseUrl);}catch{throw invalid('Base URL 无效');}if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw invalid('Base URL 需为不含账号、查询参数的 HTTP(S) 地址');
  if(['localhost','127.0.0.1','[::1]','0.0.0.0'].includes(u.hostname)&&[this.getPort(),4318].includes(Number(u.port||80)))throw invalid('上游不能指向 Daylight 自身');
  return u.href.replace(/\/$/,'')+'/'+endpoint.replace(/^\//,'');}
 async save(input,{preview=false,validateOnly=false}={}){return this.mutate(async()=>{const list=await this.list(),old=list.find(s=>s.id===input.id);if(input.id&&!old)throw invalid('来源不存在');
  const s={revision:randomUUID(),id:old?.id||randomUUID(),name:String(input.name||'').trim(),baseUrl:String(input.baseUrl||'').trim().replace(/\/$/,''),protocol:input.protocol,auth:input.auth||'bearer',enabled:input.enabled!==false,models:input.models,hasKey:old?.hasKey||false,hasHeaders:old?.hasHeaders||false,endpoint:input.endpoint||'',modelsEndpoint:input.modelsEndpoint||'models',defaultMaxTokens:input.defaultMaxTokens||undefined};
  if(!s.name||s.name.length>100||!paths[s.protocol]||!['bearer','x-api-key','none'].includes(s.auth)||!Array.isArray(s.models))throw invalid('来源配置无效');if(s.defaultMaxTokens!==undefined&&(!Number.isSafeInteger(s.defaultMaxTokens)||s.defaultMaxTokens<1))throw invalid('默认输出预算需为正整数');
  for(const endpoint of [s.endpoint,s.modelsEndpoint])if(endpoint&&(!/^[a-zA-Z0-9_./-]+$/.test(endpoint)||endpoint.includes('..')))throw invalid('端点路径只能填写相对路径');
  this.url(s,s.endpoint||paths[s.protocol]);
  const seen=new Set();s.models=s.models.map(m=>{const id=String(m.id||'').trim(),upstreamId=String(m.upstreamId||id).trim();if(!id||!upstreamId||seen.has(id)||id.length>200)throw invalid('模型名无效或重复');seen.add(id);
   const n={id,upstreamId,enabled:m.enabled!==false};for(const k of ['contextWindow','maxOutputTokens','defaultMaxTokens'])if(m[k]!=null){if(!Number.isSafeInteger(m[k])||m[k]<1)throw invalid('Token 参数需为正整数');n[k]=m[k];}return n;});
  if(input.apiKey&&(typeof input.apiKey!=='string'||input.apiKey.length>16384||/[\r\n]/.test(input.apiKey)))throw invalid('API Key 无效');
  if(!validateOnly&&s.enabled&&s.auth!=='none'&&!input.apiKey&&(!s.hasKey||input.clearKey))throw invalid('请填写 API Key，或选择无认证');
  let extra;
  if(input.extraHeaders){try{extra=JSON.parse(input.extraHeaders);}catch{throw invalid('自定义请求头需为 JSON 对象');}
    if(!extra||Array.isArray(extra)||typeof extra!=='object')throw invalid('自定义请求头需为 JSON 对象');
    for(const [k,v] of Object.entries(extra))if(!/^[a-zA-Z0-9-]+$/.test(k)||typeof v!=='string'||/[\r\n]/.test(v)||['host','authorization','x-api-key','content-length','transfer-encoding','connection','content-type'].includes(k.toLowerCase()))throw invalid('请求头无效或应由认证方式管理');
  }
  if(validateOnly)return{source:s};
  if(preview)return{source:s,headers:await this.headers({...s,hasHeaders:input.clearHeaders?false:s.hasHeaders},{apiKey:input.apiKey,extraHeaders:extra})};
  if(input.clearHeaders){await this.secrets.delete(s.id+':headers');s.hasHeaders=false;}
  if(extra){await this.secrets.set(s.id+':headers',JSON.stringify(extra));s.hasHeaders=true;}
  if(input.clearKey){await this.secrets.delete(s.id);s.hasKey=false;}if(input.apiKey){if(typeof input.apiKey!=='string'||/[\r\n]/.test(input.apiKey))throw invalid('API Key 无效');await this.secrets.set(s.id,input.apiKey);s.hasKey=true;}
  if(s.enabled&&s.auth!=='none'&&!s.hasKey)throw invalid('请填写 API Key，或选择无认证');
  await writeJson(this.file,[...list.filter(x=>x.id!==s.id),s]);return s;});}
 async readKey(id){const s=(await this.list()).find(s=>s.id===id);if(!s?.hasKey)throw invalid('尚未保存 API Key');const key=await this.secrets.get(id);if(!key)throw invalid('已保存的 API Key 不可用，请重新填写');return key;}
 async remove(id){return this.mutate(async()=>{const list=await this.list();if(!list.some(s=>s.id===id))throw invalid('来源不存在');await writeJson(this.file,list.filter(s=>s.id!==id));await this.secrets.delete(id);await this.secrets.delete(id+':headers');});}
 async headers(s,override={}){const extra=override.extraHeaders??(s.hasHeaders?JSON.parse(await this.secrets.get(s.id+':headers')||'{}'):{});const h={...extra,'Content-Type':'application/json',Accept:'application/json'};if(s.auth!=='none'){const key=override.apiKey||await this.secrets.get(s.id);if(!key)throw Object.assign(new Error('上游 Key 不可用'),{status:401});h[s.auth==='bearer'?'Authorization':'x-api-key']=s.auth==='bearer'?`Bearer ${key}`:key;}if(s.protocol==='messages')h['anthropic-version']='2023-06-01';return h;}
 async discover(id){const draft=typeof id==='object'?await this.save(id,{preview:true}):null;const s=draft?.source||(await this.list()).find(s=>s.id===id);if(!s)throw invalid('来源不存在');const r=await this.fetchImpl(this.url(s,s.modelsEndpoint||'models'),{headers:draft?.headers||await this.headers(s),redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok){await r.body?.cancel();throw Object.assign(new Error(r.status===401?'认证失败（401）：API Key 无效、已过期或与此地址不匹配':r.status===403?'访问被拒绝（403）：请检查账号权限':`模型发现失败（${r.status}），请检查地址或稍后重试`),{status:400});}const d=await r.json();if(!Array.isArray(d.data))throw invalid('上游没有返回标准模型列表，请手动填写');return d.data.filter(m=>typeof m.id==='string').map(m=>{
   const positive=values=>values.map(v=>typeof v==='string'&&/^\d+$/.test(v)?Number(v):v).find(v=>Number.isSafeInteger(v)&&v>0);
   const contextWindow=positive([m.context_length,m.context_window,m.contextWindow,m.limit?.context]);
   const maxOutputTokens=positive([m.max_output_tokens,m.max_completion_tokens,m.maxOutputTokens,m.limit?.max_output_tokens,m.limit?.output]);
   return{id:m.id,upstreamId:m.id,...(contextWindow?{contextWindow}:{}),...(maxOutputTokens?{maxOutputTokens}:{})};
  });}
 async providers(){const sources=await this.list();return Object.fromEntries(sources.filter(s=>s.enabled).map(s=>['custom:'+s.id,new CustomProvider(this,s)]));}
}
class CustomProvider {
 constructor(owner,source){Object.assign(this,{owner,source});this.cache=true;}
 async listModels(){return this.source.models.map(m=>({...m,provider:'custom:'+this.source.id,source:'custom:'+this.source.id,displayName:m.id,contextWindows:[],reasoningEfforts:[],capabilities:{native_protocol:this.source.protocol}}));}
 async forward(raw,protocol,{signal,observe=()=>{}}){const s=this.source,m=s.models.find(m=>m.id===raw.model&&m.enabled);if(!m)throw invalid('模型已停用');const input=structuredClone(raw);
  const budget=protocol==='responses'?'max_output_tokens':'max_tokens';if(input[budget]===undefined&&input.max_completion_tokens===undefined&&(m.defaultMaxTokens||s.defaultMaxTokens))input[budget]=m.defaultMaxTokens||s.defaultMaxTokens;
  observe({stage:'conversion'});
  const body=convertRequest(input,protocol,s.protocol);body.model=m.upstreamId;
  observe({stage:'authentication'});
  const headers=await this.owner.headers(s);
  observe({stage:'upstream'});
  const r=await this.owner.fetchImpl(this.owner.url(s,s.endpoint||paths[s.protocol]),{method:'POST',redirect:'error',signal,headers,body:JSON.stringify(body)});
  return{response:r,protocol:s.protocol,model:m.id,upstreamModel:m.upstreamId,requestedTier:input.service_tier};}
}
