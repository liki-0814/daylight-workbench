import {QoderProvider,sourceDescription as qoderDescription,loadConfig} from './qoder/provider.js';
import {AccountStore} from './qoder/auth.js';
import {QoderHttp} from './qoder/transport.js';
import {AgyProvider,sourceDescription as agyDescription} from './agy/provider.js';
import {GrokProvider,sourceDescription as grokDescription} from './grok/provider.js';
import {CodexProvider,sourceDescription as codexDescription} from './codex/provider.js';
import {KimiProvider,sourceDescription as kimiDescription} from './kimi/provider.js';
import {CopilotProvider,sourceDescription as copilotDescription} from './copilot/provider.js';
import {QwenWorkProvider,sourceDescription as qwenWorkDescription} from './qwenwork/provider.js';
import {CustomSources} from './custom/sources.js';
import {sourceSnapshot} from './shared/contracts.js';
import {withModelNames} from './shared/model-names.js';

// These descriptions also keep injected test providers on the public contract.
const builtins={qoder:qoderDescription,agy:agyDescription,grok:grokDescription,codex:codexDescription,kimi:kimiDescription,copilot:copilotDescription,qwenwork:qwenWorkDescription};
export function createProviders({dataDir,fetchImpl=fetch,config:overrides={},provider,agyProvider,grokProvider,codexProvider,kimiProvider,copilotProvider,qwenworkProvider,customSources,includeAgy=false,includeGrok=false,includeGateway=false,getPort,metadata}){
 const config={...loadConfig(dataDir),...overrides},accounts=new AccountStore(config.accountFile);
 const transport=(url,options={})=>fetchImpl(url,{...options,redirect:'error',signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(300000)]):AbortSignal.timeout(30000)});
 const qoder=provider||new QoderProvider(config,new QoderHttp(config,transport),accounts);
 const custom=customSources||(includeGateway?new CustomSources({dataDir,fetchImpl,getPort}):null);
 const providers={
  ...(copilotProvider||includeGateway?{copilot:copilotProvider||new CopilotProvider({dataDir,fetchImpl})}:{}),
  ...(qwenworkProvider||includeGateway?{qwenwork:qwenworkProvider||new QwenWorkProvider({dataDir,fetchImpl})}:{}),
  ...(kimiProvider||includeGateway?{kimi:kimiProvider||new KimiProvider({dataDir,fetchImpl})}:{}),
  ...(codexProvider||includeGateway?{codex:codexProvider||new CodexProvider({dataDir,fetchImpl})}:{}),
  qoder,
  ...(agyProvider||includeAgy?{agy:agyProvider||new AgyProvider({dataDir,fetchImpl})}:{}),
  ...(grokProvider||includeGrok?{grok:grokProvider||new GrokProvider({dataDir,fetchImpl})}:{}),
 };
 function decorate(id,p){
  if(!metadata)return ['qoder','qwenwork'].includes(id)?withModelNames(id,p):p;const list=p.listModels.bind(p);
  // Qoder validates inference against catalog(), while other adapters use listModels().
  if(id==='qoder'&&typeof p.catalog==='function'){const catalog=p.catalog.bind(p);p.catalog=async(...args)=>{const result=await catalog(...args);await metadata.refresh();return{...result,models:metadata.enrich(id,result.models)};};}
  p.listModels=async force=>{const [models]=await Promise.all([list(force),metadata.refresh(force)]);return metadata.enrich(id,models);};return ['qoder','qwenwork'].includes(id)?withModelNames(id,p):p;
 }
 for(const [id,p] of Object.entries(providers))providers[id]=decorate(id,p);
 function snapshot(id){
  const p=providers[id],defaults=builtins[id];if(!p)return undefined;
  const own=p.snapshot?.()||sourceSnapshot({id,...defaults,identityKey:p.identity??p.auth?.identity??p.cache?.identity??p.cache?.id??p.cache?.project,connected:!!p.cache&&!p.lastError,error:p.lastError,checkedAt:p.cache?.at,configured:id==='qoder'?!!provider||!!accounts.current:true,capabilities:{quota:!!(p.quota||p.credits),editableSource:false}});
  return {...own,authentication:{...defaults?.authentication,...own.authentication},capabilities:{...defaults?.capabilities,...own.capabilities},...(id==='qoder'&&provider?{configured:true}:{})};
 }
 async function sync(){
  const next=custom?await custom.providers():{},removed=[];
  for(const id of Object.keys(providers))if(id.startsWith('custom:')&&!next[id]){await providers[id].close?.();delete providers[id];removed.push(id);}
  for(const [id,p] of Object.entries(next)){await providers[id]?.close?.();providers[id]=decorate(id,p);}
  return{next,removed};
 }
 async function listModels(id,refresh=false){
  const p=providers[id];if(!p)throw Object.assign(new Error('来源不存在'),{status:404});
  return p.listModels(refresh);
 }
 const execute=(id,input,context)=>providers[id].execute(input,context);
 return{config,accounts,custom,providers,qoder,snapshot,sync,listModels,execute,async close(){await Promise.all(Object.values(providers).map(p=>p.close?.()));}};
}
