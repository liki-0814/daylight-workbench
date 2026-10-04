import {catalogModels} from './models.js';
import {sourceSnapshot,modelCapabilities} from '../shared/contracts.js';
import {omitKimiTemperature,isOfficialKimiUrl} from '../shared/request-parameters.js';
import {createHash} from 'node:crypto';
import {invalid,convertRequest} from '../shared/protocol.js';
const paths={chat:'chat/completions',responses:'responses',messages:'messages'};
export class CustomProvider {
  async listModels(force=false){return modelCapabilities(await this.catalogModels(typeof force==='object'?force.refresh===true:force),['enabled', 'effort', 'maxTokens']);}
  close(){}
  async execute({raw,protocol},context){return{kind:'response',...await this.forward(raw,protocol,context)};}
  snapshot(){return sourceSnapshot({id:'custom:'+this.source.id,name:this.source.name,identityKey:createHash('sha256').update(JSON.stringify(this.source)).digest('hex'),configured:this.source.auth==='none'||this.source.hasKey,connected:true,authentication:{mode:this.source.auth==='none'?'none':'key',operations:[]},capabilities:{quota:false,editableSource:true,pi:this.source.protocol==='messages'?{}:{'anthropic-messages':'此通道不能转换 Pi Messages 的缓存与思考字段，请选择 Responses 或 Chat Completions'}},nativeProtocols:[this.source.protocol]});}
 constructor(owner,source){Object.assign(this,{owner,source});this.cache=true;}
 async catalogModels(){return catalogModels(this.source);}

 async forward(raw,protocol,{signal,observe=()=>{},conversationId,keyId}={}){
  const s=this.source,owner=this.owner;
  let candidates=s.keys.filter(k=>k.enabled!==false&&(s.auth==='none'||k.hasKey)&&k.models.some(m=>m.id===raw.model&&m.enabled));
  if(keyId)candidates=candidates.filter(k=>k.id===keyId);
  if(!candidates.length)throw invalid('模型已停用或没有可用 Key');
  const stateful=!!(raw.previous_response_id||raw.conversation);
  const affinityId=conversationId?`${s.id}:${createHash('sha256').update(conversationId).digest('hex')}`:null;
  const sticky=affinityId&&owner.affinities.get(affinityId),validSticky=sticky&&Date.now()-sticky.at<86400000,pinned=validSticky&&candidates.find(k=>k.id===sticky.keyId);
  // A single-key source keeps its original continuation semantics.
  if(stateful&&s.keys.length>1&&!pinned)throw invalid('多 Key 上游续接需要稳定的对话标识及已绑定的 Key，请发送完整历史');
  if(stateful&&pinned)candidates=[pinned];
  else if(!stateful){const ready=candidates.filter(k=>(owner.cooldowns.get(`${s.id}:${k.id}`)||0)<=Date.now());if(ready.length)candidates=ready;
   if(pinned&&candidates.includes(pinned))candidates=[pinned,...candidates.filter(k=>k!==pinned)];}
  let lastError;
  for(let i=0;i<candidates.length;i++){
   signal?.throwIfAborted();const key=candidates[i],m=key.models.find(m=>m.id===raw.model&&m.enabled),input=structuredClone(raw);
   const budget=protocol==='responses'?'max_output_tokens':'max_tokens';if(input[budget]===undefined&&input.max_completion_tokens===undefined&&(m.defaultMaxTokens||s.defaultMaxTokens))input[budget]=m.defaultMaxTokens||s.defaultMaxTokens;
   observe({stage:'conversion',keyId:key.id,retries:i,upstreamModel:m.upstreamId});
   if(isOfficialKimiUrl(s.baseUrl))omitKimiTemperature(input,m.upstreamId,observe);
   const body=convertRequest(input,protocol,s.protocol);body.model=m.upstreamId;
   if(m.effort){
    if(s.protocol==='chat'&&body.reasoning_effort===undefined)body.reasoning_effort=m.effort;
    else if(s.protocol==='responses'&&body.reasoning?.effort===undefined)body.reasoning={...body.reasoning,effort:m.effort};
    else if(s.protocol==='messages'&&body.output_config?.effort===undefined&&raw.thinking===undefined)body.output_config={...body.output_config,effort:m.effort};
   }
   observe({stage:'authentication'});let response;
   try{
    const headers=await owner.headers(s,{key});observe({stage:'upstream'});
    response=await owner.fetchImpl(owner.url(s,s.endpoint||paths[s.protocol]),{method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000),headers,body:JSON.stringify(body)});
   }catch(error){if(signal?.aborted)throw error;
    if(!(error.status===401||error.name==='TimeoutError'||error instanceof TypeError||['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ETIMEDOUT'].includes(error.code||error.cause?.code)))throw error;
    lastError=error;owner.cooldowns.set(`${s.id}:${key.id}`,Date.now()+30000);if(stateful)throw error;continue;
   }
   const retryable=[401,403,404,408,429].includes(response.status)||response.status>=500;
   if(retryable){const delay=response.headers.get('retry-after'),seconds=Number(delay),until=delay&&(Number.isFinite(seconds)?Date.now()+seconds*1000:Date.parse(delay));
    owner.cooldowns.set(`${s.id}:${key.id}`,Math.min(Date.now()+300000,Math.max(Date.now()+30000,until||0)));
    if(!stateful&&i+1<candidates.length){await response.body?.cancel();continue;}
   }
   if(response.ok){owner.cooldowns.delete(`${s.id}:${key.id}`);
    if(affinityId){owner.affinities.delete(affinityId);owner.affinities.set(affinityId,{keyId:key.id,at:Date.now()});if(owner.affinities.size>10000)owner.affinities.delete(owner.affinities.keys().next().value);}
   }
   return{response,protocol:s.protocol,model:m.id,upstreamModel:m.upstreamId,requestedTier:input.service_tier};
  }
  throw lastError;
 }
}
