import {modelUnion,validateModels,parseModels} from './models.js';
import {CustomProvider} from './provider.js';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {readJson,writeJson,serial} from '../shared/store.js';
import {invalid} from '../shared/protocol.js';
import {Secrets} from '../shared/secrets.js';
const paths={chat:'chat/completions',responses:'responses',messages:'messages'};
const secretId=(s,k)=>k.id==='default'?s.id:`${s.id}:key:${k.id}`;
const legacyKey=s=>({id:'default',enabled:true,hasKey:!!s.hasKey,models:s.models||[]});
const normalize=s=>{const keys=s.keys||[legacyKey(s)];return{...s,keys,hasKey:keys.some(k=>k.enabled!==false&&k.hasKey),models:modelUnion(keys)};};
export class CustomSources {
 constructor({dataDir,fetchImpl=fetch,secrets=new Secrets(),getPort=()=>4319}){Object.assign(this,{fetchImpl,secrets,getPort});this.file=path.join(dataDir,'custom-proxy/sources.json');this.mutate=serial();this.affinities=new Map();this.cooldowns=new Map();}
 async list(){return(await readJson(this.file,[])).map(normalize);}
 url(source,endpoint){let u;try{u=new URL(source.baseUrl);}catch{throw invalid('Base URL 无效');}if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw invalid('Base URL 需为不含账号、查询参数的 HTTP(S) 地址');
  if(['localhost','127.0.0.1','[::1]','0.0.0.0'].includes(u.hostname)&&[this.getPort(),4318].includes(Number(u.port||80)))throw invalid('上游不能指向 Daylight 自身');
  return u.href.replace(/\/$/,'')+'/'+endpoint.replace(/^\//,'');}
 async save(input,{preview=false,validateOnly=false}={}){return this.mutate(async()=>{
  const list=await this.list(),old=list.find(s=>s.id===input.id);if(input.id&&!old)throw invalid('来源不存在');
  const s={revision:randomUUID(),id:old?.id||randomUUID(),name:String(input.name||'').trim(),baseUrl:String(input.baseUrl||'').trim().replace(/\/$/,''),protocol:input.protocol,auth:input.auth||'bearer',enabled:input.enabled!==false,hasHeaders:old?.hasHeaders||false,endpoint:input.endpoint||'',modelsEndpoint:input.modelsEndpoint||'models',defaultMaxTokens:input.defaultMaxTokens||undefined};
  if(!s.name||s.name.length>100||!paths[s.protocol]||!['bearer','x-api-key','none'].includes(s.auth))throw invalid('来源配置无效');
  if(s.defaultMaxTokens!==undefined&&(!Number.isSafeInteger(s.defaultMaxTokens)||s.defaultMaxTokens<1))throw invalid('默认输出预算需为正整数');
  for(const endpoint of [s.endpoint,s.modelsEndpoint])if(endpoint&&(!/^[a-zA-Z0-9_./-]+$/.test(endpoint)||endpoint.includes('..')))throw invalid('端点路径只能填写相对路径');
  this.url(s,s.endpoint||paths[s.protocol]);
  const draft=input.keys??old?.keys??[legacyKey({models:input.models})];
  if(!Array.isArray(draft)||!draft.length||draft.length>50||draft.some(k=>!k||typeof k!=='object'))throw invalid('Key 列表无效，需配置 1–50 个 Key');
  const aggregate=input.models===undefined?undefined:validateModels(input.models),seen=new Set(),pending=[];
  s.keys=draft.map((k,i)=>{const id=k.id||randomUUID(),prior=old?.keys.find(n=>n.id===id);
   if(typeof id!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(id)||seen.has(id))throw invalid('Key 标识无效或重复');seen.add(id);
   let models=validateModels(k.models??prior?.models??[]);
   if(aggregate){if(draft.length===1&&(!old||old.keys.length===1))models=aggregate;
    else models=models.flatMap(m=>{const n=aggregate.find(n=>n.upstreamId===m.upstreamId||n.id===m.id);return n?[{...n,upstreamId:m.upstreamId}]:[];});
   }
   const key={id,enabled:k.enabled!==false,hasKey:!!prior?.hasKey,models};
   // Keep the original single-key API, including its blank-means-preserve behavior.
   const value=i===0&&input.apiKey?input.apiKey:k.apiKey,clear=!!(i===0&&input.clearKey||k.clearKey);
   if(value!==undefined&&typeof value!=='string'||value&&(value.length>16384||/[\r\n]/.test(value)))throw invalid('API Key 无效');
   if(clear)key.hasKey=false;if(value)key.hasKey=true;
   if(!validateOnly&&s.enabled&&key.enabled&&s.auth!=='none'&&!key.hasKey)throw invalid(`请填写 Key ${i+1} 的 API Key，或移除此 Key`);
   pending.push({key,value,clear});return key;
  });
  s.models=modelUnion(s.keys);s.hasKey=s.keys.some(k=>k.enabled&&k.hasKey);
  let extra;
  if(input.extraHeaders){try{extra=JSON.parse(input.extraHeaders);}catch{throw invalid('自定义请求头需为 JSON 对象');}
   if(!extra||Array.isArray(extra)||typeof extra!=='object')throw invalid('自定义请求头需为 JSON 对象');
   for(const [k,v] of Object.entries(extra))if(!/^[a-zA-Z0-9-]+$/.test(k)||typeof v!=='string'||/[\r\n]/.test(v)||['host','authorization','x-api-key','content-length','transfer-encoding','connection','content-type'].includes(k.toLowerCase()))throw invalid('请求头无效或应由认证方式管理');
  }
  if(validateOnly)return{source:s};
  if(preview)return{source:s,credentials:pending,extraHeaders:extra,clearHeaders:input.clearHeaders};
  if(input.clearHeaders){await this.secrets.delete(s.id+':headers');s.hasHeaders=false;}
  if(extra){await this.secrets.set(s.id+':headers',JSON.stringify(extra));s.hasHeaders=true;}
  for(const {key,value,clear} of pending){if(value)await this.secrets.set(secretId(s,key),value);else if(clear)await this.secrets.delete(secretId(s,key));}
  await writeJson(this.file,[...list.filter(x=>x.id!==s.id),s]);
  for(const key of old?.keys||[])if(!seen.has(key.id))await this.secrets.delete(secretId(s,key));
  for(const id of this.cooldowns.keys())if(id.startsWith(s.id+':'))this.cooldowns.delete(id);
  return s;
 });}
 async readKey(id,keyId){const s=(await this.list()).find(s=>s.id===id),key=keyId?s?.keys.find(k=>k.id===keyId):s?.keys[0];if(!key?.hasKey)throw invalid('尚未保存 API Key');const value=await this.secrets.get(secretId(s,key));if(!value)throw invalid('已保存的 API Key 不可用，请重新填写');return value;}
 async remove(id){return this.mutate(async()=>{const list=await this.list(),s=list.find(s=>s.id===id);if(!s)throw invalid('来源不存在');await writeJson(this.file,list.filter(s=>s.id!==id));for(const k of s.keys)await this.secrets.delete(secretId(s,k));await this.secrets.delete(id+':headers');});}
 async headers(s,override={}){const extra=override.extraHeaders??(s.hasHeaders?JSON.parse(await this.secrets.get(s.id+':headers')||'{}'):{});const h={...extra,'Content-Type':'application/json',Accept:'application/json'};
  if(s.auth!=='none'){const selected=override.key||s.keys?.[0]||legacyKey(s),key=override.apiKey||(!override.clearKey&&await this.secrets.get(secretId(s,selected)));if(!key)throw Object.assign(new Error('上游 Key 不可用'),{status:401});h[s.auth==='bearer'?'Authorization':'x-api-key']=s.auth==='bearer'?`Bearer ${key}`:key;}
  if(s.protocol==='messages')h['anthropic-version']='2023-06-01';return h;}
 async discover(input,keyId){const draft=typeof input==='object'?await this.save(input,{preview:true}):null,s=draft?.source||(await this.list()).find(s=>s.id===input);if(!s)throw invalid('来源不存在');
  const selected=keyId?s.keys.find(k=>k.id===keyId):s.keys[0];if(!selected)throw invalid('请选择 Key');const pending=draft?.credentials.find(p=>p.key.id===selected.id);
  const headers=await this.headers({...s,hasHeaders:draft?.clearHeaders?false:s.hasHeaders},{key:selected,apiKey:pending?.value,clearKey:pending?.clear,extraHeaders:draft?.extraHeaders});
  const r=await this.fetchImpl(this.url(s,s.modelsEndpoint||'models'),{headers:{...headers,'Cache-Control':'no-cache',Pragma:'no-cache'},redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!r.ok){await r.body?.cancel();throw Object.assign(new Error(r.status===401?'认证失败（401）：API Key 无效、已过期或与此地址不匹配':r.status===403?'访问被拒绝（403）：请检查账号权限':`模型发现失败（${r.status}），请检查地址或稍后重试`),{status:400});}
  const d=await r.json();return parseModels(d);}
 async discoverAll(input){const s=typeof input==='object'?input:(await this.list()).find(s=>s.id===input);if(!s)throw invalid('来源不存在');
  const keys=s.keys||[legacyKey(s)],results=await Promise.allSettled(keys.map(k=>this.discover(input,k.id)));
  const failed=results.findIndex(r=>r.status==='rejected');if(failed>=0)throw Object.assign(new Error(`Key ${failed+1}：${results[failed].reason.message}`),{status:results[failed].reason.status||400});
  const discovered=keys.map((k,i)=>({id:k.id,models:results[i].value}));return{keys:discovered,models:modelUnion(discovered)};
 }
 async providers(){return Object.fromEntries((await this.list()).filter(s=>s.enabled).map(s=>['custom:'+s.id,new CustomProvider(this,s)]));}
}
