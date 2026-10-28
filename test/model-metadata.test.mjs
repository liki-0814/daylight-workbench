import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {fillModelMetadata,stripModelMetadata,piModelCost,mergeModelPrices,modelPriceLabel,mergeDiscoveredModels} from '../core/model-metadata.js';
import {createModelMetadata} from '../proxy/shared/model-metadata.js';
import {modelConfig,createPiConfig} from '../cli/pi-config.js';
import {parseModels,validateModels,modelUnion} from '../proxy/custom/models.js';
import {applyCapacitySettings} from '../proxy/shared/model-settings.js';
import {parseModel as qoderModel} from '../proxy/qoder/models.js';
const reference={id:'reference',name:'Reference',limits:{context_length:1000000,max_output_tokens:128000},reasoning_effort:{levels:['low','high'],default:'high',can_disable:false,field_status:{levels:'verified'}},pricing:{input:2,output:10,cached_input:.1,cache_write:2.5},pricing_tiers:[{input_tokens_gt:272000,input_tokens_lte:null,input:4,output:15,cached_input:.2,cache_write:5}],price_basis:{type:'official'}};
const payload=(entry=reference,version='v1')=>({api_version:'v1',meta:{data_version:version,updated_at:'2026-10-11',currency:'USD',unit:'per_1M_tokens'},data:[entry]});
const fixture=async t=>{const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-pricing-test-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));return dataDir;};
test('Qoder matches complete display names to unique reference IDs or names while preserving explicit associations',async t=>{
 const dataDir=await fixture(t),rows=[
  ['qmodel_38max','Qwen3.8-Max','qwen3.8-max','Qwen3.8-Max'],
  ['qfmodel','Qwen3.8-Flash','qwen3.8-flash','Qwen3.8-Flash'],
  ['qmodel_latest','Qwen3.7-Max','qwen3.7-max','Qwen3.7-Max'],
  ['qmodel','Qwen3.7-Plus','qwen3.7-plus','Qwen3.7-Plus'],
  ['kmodel_latest','Kimi-K3','kimi-k3','Kimi K3'],
  ['kmodel','Kimi-K2.8-Preview','kimi-for-coding','Kimi K2.8 Preview'],
  ['gmodel','GLM-5.3','glm-5.3','GLM-5.3'],
  ['gfmodel','GLM-5.3-Flash','glm-5.3-flash','GLM-5.3-Flash'],
  ['dmodel','DeepSeek-V4-Pro','deepseek-v4-pro','DeepSeek-V4-Pro-0813'],
  ['dfmodel','DeepSeek-Flash','deepseek-flash','DeepSeek-V4.1-Flash'],
  ['mmodel','MiniMax-M3','minimax-m3','MiniMax-M3'],
 ];
 const metadata=createModelMetadata({dataDir,fetchImpl:async()=>Response.json({...payload(),data:rows.map(([, ,id,name])=>({...reference,id,name}))})});await metadata.refresh();
 for(const [id,displayName,matchedId] of rows){const model=metadata.enrich('qoder',[{id,displayName,contextWindow:64000}])[0];assert.equal(model.modelMetadata.matchedId,matchedId);assert.equal(model.id,id);assert.equal(model.contextWindow,64000);}
 const match=(model,source='qoder')=>metadata.enrich(source,[model])[0].modelMetadata.matchedId;
 assert.equal(match({id:'qfmodel',displayName:' QWEN3.8 Flash '}),'qwen3.8-flash');
 assert.equal(match({id:'qwen3.8-max',displayName:'GLM-5.3'}),'qwen3.8-max');
 await metadata.bind({source:'qoder',id:'qfmodel',referenceId:'glm-5.3'});
 assert.equal(match({id:'qfmodel',displayName:'Qwen3.8-Flash'}),'glm-5.3');
 assert.equal(match({id:'qfmodel',displayName:'Qwen3.8-Flash',referenceId:'minimax-m3'}),'minimax-m3');
 assert.equal(match({id:'qfmodel',displayName:'Qwen3.8-Flash',referenceId:'missing'}),'');
 await metadata.bind({source:'qoder',id:'qfmodel',referenceId:''});assert.equal(match({id:'qfmodel',displayName:'Qwen3.8-Flash'}),'qwen3.8-flash');
 assert.equal(match({id:'qfmodel',displayName:'Qwen3.8-Flash'},'custom:one'),'qwen3.8-flash');
});
test('all sources share complete identity matching and verified thinking mode matching without dropping variants',async t=>{
 const dataDir=await fixture(t),opus={...reference,id:'claude-opus-4.6',name:'Claude Opus 4.6',reasoning_effort:{supported:true,can_disable:true,levels:['low','medium','high','max'],field_status:{supported:'verified',can_disable:'verified',levels:'verified'}}};
 let current={...payload(),data:[opus,{...reference,id:'other',name:'Other'}]};const metadata=createModelMetadata({dataDir,fetchImpl:async()=>Response.json(current)});await metadata.refresh();
 const model={id:'claude-opus-4-6-thinking',displayName:'Claude Opus 4.6 (Thinking)',isReasoning:true,reasoningEfforts:['low','medium','high']};
 const match=(source,m=model)=>metadata.enrich(source,[m])[0].modelMetadata.matchedId;
 for(const source of ['qoder','agy','grok','codex','kimi','custom:one']){
  assert.equal(match(source),'claude-opus-4.6');assert.equal(match(source,{id:'claude-opus-4-6'}),'claude-opus-4.6');
  if(!source.startsWith('custom:'))assert.deepEqual(metadata.enrich(source,[model])[0].reasoningEfforts,['low','medium','high']);
 }
 for(const m of [{...model,isReasoning:false,reasoningEfforts:[]},{...model,isReasoning:undefined,reasoningEfforts:[]},{...model,id:'opaque',displayName:'Claude Opus 4.6 Preview (Thinking)'},{...model,id:'claude-opus-4-60-thinking',displayName:'Claude Opus 4.60 (Thinking)'},{id:'claude-opus-46'},{id:'opaque',displayName:'Claude Opus 4.6',upstreamId:'OTHER'}])assert.equal(match('agy',m),'');
 await metadata.bind({source:'agy',id:model.id,referenceId:'other'});assert.equal(match('agy'),'other');assert.equal(match('agy',{...model,referenceId:'missing'}),'');await metadata.bind({source:'agy',id:model.id,referenceId:''});
 const filled=metadata.enrich('agy',[model])[0];assert.equal(filled.modelMetadata.matchedId,opus.id);
 current={...current,data:[{...opus,reasoning_effort:{...opus.reasoning_effort,can_disable:false}},current.data[1]]};await metadata.refresh(true);assert.equal(match('agy',filled),'');
 current={...current,data:[opus,{...opus,id:'alternative'}]};await metadata.refresh(true);assert.equal(match('agy'),'');
 current={...current,data:[opus,{...opus,id:model.id,name:model.displayName}]};await metadata.refresh(true);assert.equal(match('agy'),model.id);
});
test('Qoder leaves incomplete, variant and ambiguous names unmatched and reevaluates names on refresh',async t=>{
 const dataDir=await fixture(t),model={id:'kmodel_latest',displayName:'Kimi-K3'};let current={...payload(),data:[{...reference,id:'kimi-k3',name:'Kimi K3'},{...reference,id:'qwen3.8-max',name:'Qwen3.8-Max'}]};
 const metadata=createModelMetadata({dataDir,fetchImpl:async()=>Response.json(current)});await metadata.refresh();
 for(const displayName of ['Auto','Ultimate','Performance','Efficient','Sonus','Qwen3.8','Qwen3.8-Max-DogFooding','Kimi-K3-Fast','Kimi-K3-Preview','Kimi-K30','Kimi-K3.0','',undefined])assert.equal(metadata.enrich('qoder',[{id:'opaque',displayName}])[0].modelMetadata.matchedId,'');
 const matched=metadata.enrich('qoder',[model])[0];assert.equal(matched.modelMetadata.matchedId,'kimi-k3');assert.equal(matched.cost.input,2);
 assert.equal(metadata.enrich('qoder',[{...matched,displayName:'Kimi-K4'}])[0].modelMetadata.matchedId,'');
 current={...current,data:[...current.data,{...reference,id:'another-kimi',name:'Kimi-K3'}]};await metadata.refresh(true);
 const ambiguous=metadata.enrich('qoder',[matched])[0];assert.equal(ambiguous.modelMetadata.matchedId,'');assert.equal(ambiguous.cost,undefined);assert.equal(ambiguous.contextWindow,undefined);
 assert.equal(metadata.enrich('qoder',[{id:'kimi-k3',displayName:'Kimi-K3'}])[0].modelMetadata.matchedId,'kimi-k3');
 await metadata.bind({source:'qoder',id:model.id,referenceId:'kimi-k3'});assert.equal(metadata.enrich('qoder',[model])[0].modelMetadata.matchedId,'kimi-k3');
});
test('missing metadata fills per field; upstream ceilings, declared efforts and explicit zero prices win',()=>{
 const model=fillModelMetadata({id:'alias',contextWindow:272000,maxOutputTokens:64000,reasoningEfforts:['medium'],cost:{input:0,output:3,cacheRead:null}},reference,{subscription:true});
 assert.equal(model.contextWindow,272000);assert.equal(model.maxOutputTokens,64000);assert.deepEqual(model.reasoningEfforts,['medium']);assert.equal(model.defaultEffort,undefined);
 assert.equal(model.cost.input,0);assert.equal(model.cost.output,3);assert.equal(model.cost.cacheRead,.1);assert.equal(model.priceInfo.referenceEstimate,true);
 const config=modelConfig(model);assert.equal(config.cost.tiers[0].inputTokensAbove,272000);
 assert.equal(modelConfig(model,{},undefined,{maxTokens:1000}).maxTokens,64000);
});
test('empty declarations use the reference; explicit refusal stops fallback and unknown stays absent in Pi',()=>{
 const parsed=parseModels({data:[{id:'reference',reasoning_efforts:[]}]})[0];assert.deepEqual(fillModelMetadata(parsed,reference).reasoningEfforts,['low','high']);
 assert.deepEqual(fillModelMetadata({id:'reference',isReasoning:false,reasoningEfforts:[]},reference).reasoningEfforts,[]);
 const unknown=fillModelMetadata({id:'missing'},undefined);const pi=modelConfig(unknown);
 for(const key of ['contextWindow','maxTokens','reasoning','cost'])assert.equal(Object.hasOwn(pi,key),false);
 const fixed=fillModelMetadata({id:'fixed'}, {...reference,reasoning_effort:{supported:false,levels:null}});assert.equal(fixed.isReasoning,undefined);
});
test('partial or unsupported tiers never become a zero-filled Pi price',()=>{
 const partial=fillModelMetadata({id:'reference'},{...reference,pricing:{...reference.pricing,cache_write:null}},{subscription:true});
 assert.equal(partial.cost.cacheWrite,null);assert.equal(piModelCost(partial.cost),undefined);assert.equal(modelConfig(partial).cost,undefined);assert.match(modelPriceLabel(partial),/参考估算.*不完整/);
 assert.equal(piModelCost({...partial.cost,cacheWrite:2,tiers:[null]}),undefined);
 assert.equal(piModelCost({...partial.cost,cacheWrite:2,tiers:[{inputTokensAbove:10,input:1,output:1,cacheRead:0,cacheWrite:null}]}),undefined);
 const bounded=fillModelMetadata({id:'reference'},{...reference,pricing_tiers:[{...reference.pricing_tiers[0],input_tokens_lte:900000}]});assert.equal(modelConfig(bounded).cost,undefined);
 assert.deepEqual(fillModelMetadata({id:'reference',cost:{input:1,output:1,cacheRead:0,cacheWrite:0,tiers:[]}},reference).cost.tiers,[]);
});
test('refresh restores original partial upstream prices and custom save does not freeze fills',()=>{
 const original={id:'alias',upstreamId:'raw',referenceId:'reference',cost:{input:1},enabled:true};
 const first=fillModelMetadata(original,reference);assert.deepEqual(stripModelMetadata(first),original);
 const second=fillModelMetadata(first,{...reference,limits:{context_length:2000000,max_output_tokens:200000},pricing:{...reference.pricing,output:20}});
 assert.equal(second.contextWindow,2000000);assert.equal(second.cost.input,1);assert.equal(second.cost.output,20);
 const saved=validateModels([first])[0];assert.equal(saved.contextWindow,undefined);assert.equal(saved.cost.output,null);assert.equal(saved.referenceId,'reference');
 const manual=validateModels([{...first,contextWindow:120000,contextLimit:120000}])[0];assert.equal(manual.contextWindow,120000);
});
test('manual capacity without an upstream ceiling survives and can use the reference ceiling',()=>{
 const saved=applyCapacitySettings([{id:'reference'}],{capacities:{reference:{contextWindow:120000}}})[0];assert.equal(saved.contextWindow,120000);
 const effective=fillModelMetadata(saved,reference);assert.equal(effective.contextWindow,1000000);assert.equal(effective.contextLimit,1000000);
 const restricted=fillModelMetadata(applyCapacitySettings([{id:'reference',contextWindow:64000}],{capacities:{reference:{contextWindow:120000}}})[0],reference);assert.equal(restricted.contextWindow,64000);
});
test('multi-source costs must agree; multi-key manual associations persist',()=>{
 assert.equal(mergeModelPrices([{cost:{input:1}},{cost:{input:2}}]).cost,undefined);
 const union=modelUnion([{models:[{id:'alias',upstreamId:'raw',referenceId:'reference',enabled:true}]},{models:[{id:'alias',upstreamId:'raw',referenceId:'reference',enabled:true}]}]);assert.equal(union[0].referenceId,'reference');
});
test('one alias binding survives restart, updates with the catalog, and retains the last good offline cache',async t=>{
 const dataDir=await fixture(t);let calls=0,clock=10000,current=payload(),offline=false;
 const options={dataDir,now:()=>clock,ttlMs:100,fetchImpl:async()=>{calls++;if(offline)throw Error('offline');return Response.json(current);}};
 const metadata=createModelMetadata(options);await Promise.all([metadata.refresh(),metadata.refresh()]);assert.equal(calls,1);
 assert.equal(metadata.enrich('custom:one',[{id:'alias',upstreamId:'raw'}])[0].contextWindow,undefined);
 await metadata.bind({source:'custom:one',id:'raw',referenceId:'reference'});
 assert.equal(metadata.enrich('custom:one',[{id:'alias',upstreamId:'raw'}])[0].contextWindow,1000000);
 current=payload({...reference,limits:{context_length:2000000}},'v2');clock+=200;await metadata.refresh();assert.equal(metadata.enrich('custom:one',[{id:'renamed',upstreamId:'raw'}])[0].contextWindow,2000000);
 offline=true;clock+=200;const restarted=createModelMetadata(options);await restarted.refresh();assert.match((await restarted.read()).error,/保留缓存/);assert.equal(restarted.enrich('custom:one',[{id:'renamed',upstreamId:'raw'}])[0].contextWindow,2000000);
 assert.equal(restarted.enrich('custom:other',[{id:'alias',upstreamId:'raw'}])[0].contextWindow,undefined);
 await assert.rejects(restarted.bind({source:'custom:one',id:'raw',referenceId:'missing'}),/不存在/);
});
test('Pi apply writes complete base and threshold rates, preserves personal settings, refreshes prices and restores exactly',async t=>{
 const dataDir=await fixture(t),piDir=path.join(dataDir,'pi');await mkdir(piDir);
 const before='{"providers":{"other":{"models":[]}}}';await writeFile(path.join(piDir,'models.json'),before);
 let model=fillModelMetadata({id:'reference',name:'Reference',source:'codex',enabled:true,contextWindow:272000},reference,{subscription:true});
 const pi=createPiConfig({dataDir,piDir,getInfo:async()=>({installed:true}),getGateway:async()=>({state:'running',baseUrl:'http://127.0.0.1:4319/v1',apiKey:'fixture-key'}),getCatalog:async()=>[model]});await pi.start();t.after(()=>pi.close());
 let state=await pi.state();await pi.apply({expectedVersion:state.version,requestId:'price-import',modelOverrides:{reference:{maxTokens:1000}}});
 let actual=JSON.parse(await readFile(path.join(piDir,'models.json'),'utf8')).providers.daylight.models[0];assert.equal(actual.cost.input,2);assert.equal(actual.cost.tiers[0].input,4);assert.equal(actual.maxTokens,128000);assert.equal(actual.contextWindow,272000);
 model=fillModelMetadata(model,{...reference,pricing:{...reference.pricing,output:11}});state=await pi.state();assert.equal(state.models[0].state,'update');await pi.apply({expectedVersion:state.version,requestId:'price-update'});
 actual=JSON.parse(await readFile(path.join(piDir,'models.json'),'utf8')).providers.daylight.models[0];assert.equal(actual.cost.output,11);assert.equal(actual.maxTokens,128000);
 await pi.restore();actual=JSON.parse(await readFile(path.join(piDir,'models.json'),'utf8')).providers.daylight.models[0];assert.equal(actual.cost.output,10);
});

test('custom manual selections and defaults survive save without freezing the reference ceiling',()=>{
 const effective=fillModelMetadata({id:'reference',upstreamId:'reference',enabled:true},reference);
 const saved=validateModels([{...effective,contextWindow:256000,effort:'high'}])[0];
 assert.equal(saved.contextLimit,undefined);assert.equal(saved.referenceId,'reference');assert.equal(saved.effort,'high');assert.equal(saved.reasoningEfforts,undefined);
 assert.doesNotThrow(()=>validateModels([saved]));
 const current=fillModelMetadata(applyCapacitySettings(modelUnion([{models:[saved]}]))[0],{...reference,limits:{context_length:2000000}});
 assert.equal(current.contextWindow,2000000);assert.equal(current.contextLimit,2000000);assert.equal(current.effort,'high');
});
test('rediscovery retains a manual association and lets missing capabilities update from the reference',()=>{
 const previous=fillModelMetadata({id:'alias',upstreamId:'vendor-id',referenceId:'reference',enabled:true},reference);
 const discovered=fillModelMetadata({id:'vendor-id',upstreamId:'vendor-id'},undefined);
 const merged=mergeDiscoveredModels([discovered],[previous])[0];assert.equal(merged.contextWindow,undefined);assert.equal(merged.contextLimit,undefined);assert.equal(merged.referenceId,'reference');assert.equal(merged.id,'alias');
 assert.equal(fillModelMetadata(merged,{...reference,limits:{context_length:2000000}}).contextWindow,2000000);
 const upstream=mergeDiscoveredModels([{id:'vendor-id',upstreamId:'vendor-id',contextWindow:128000}],[previous])[0];assert.equal(fillModelMetadata(upstream,reference).contextWindow,128000);
});

test('capability priority is upstream then reference then saved manual fallback',()=>{
 const manual={id:'alias',contextWindow:64000,maxOutputTokens:1000,reasoningEfforts:['manual'],isReasoning:true};
 const mapped=fillModelMetadata(manual,reference,{manualFallback:true});
 assert.equal(mapped.contextWindow,1000000);assert.equal(mapped.maxOutputTokens,128000);assert.deepEqual(mapped.reasoningEfforts,['low','high']);
 assert.deepEqual(stripModelMetadata(mapped),manual);
 const declared=fillModelMetadata({...manual,upstreamCapabilities:{contextWindow:32000,reasoningEfforts:[],reasoningEffortsProvided:true}},reference,{manualFallback:true});
 assert.equal(declared.contextWindow,32000);assert.deepEqual(declared.reasoningEfforts,['low','high']);assert.equal(modelConfig(declared,{},'openai-responses',{thinkingLevelMap:{high:'manual'}}).thinkingLevelMap.high,'high');
 assert.deepEqual(fillModelMetadata({id:'reference',isReasoning:true},reference).reasoningEfforts,['low','high']);
 const unknown=fillModelMetadata(manual,undefined,{manualFallback:true});assert.equal(unknown.contextWindow,64000);assert.deepEqual(unknown.reasoningEfforts,['manual']);
 const pi=modelConfig(mapped,{},'openai-responses',{contextWindow:2,maxTokens:3,reasoning:false,thinkingLevelMap:{max:'manual'}});
 assert.equal(pi.contextWindow,1000000);assert.equal(pi.maxTokens,128000);assert.equal(pi.reasoning,true);assert.equal(pi.thinkingLevelMap.max,null);
 assert.equal(modelConfig({id:'missing'}, {},'openai-responses',{maxTokens:99}).maxTokens,99);
});
test('reasoning fallback uses upstream then reference then manual and stops at explicit refusal',()=>{
 const three={...reference,reasoning_effort:{supported:true,levels:['low','medium','high'],default:'medium',can_disable:true,field_status:{supported:'verified',levels:'verified'}}};
 const manual={id:'alias',isReasoning:true,reasoningEfforts:['manual'],defaultEffort:'manual',upstreamCapabilities:{reasoningEfforts:[],reasoningEffortsProvided:true}};
 const fromAPI=fillModelMetadata(manual,three,{manualFallback:true});assert.deepEqual(fromAPI.reasoningEfforts,['none','low','medium','high']);assert.equal(fromAPI.defaultEffort,'medium');assert.deepEqual(stripModelMetadata(fromAPI),manual);
 const fromUpstream=fillModelMetadata({...manual,upstreamCapabilities:{isReasoning:true,reasoningEfforts:['max'],defaultEffort:'max'}},three,{manualFallback:true});assert.deepEqual(fromUpstream.reasoningEfforts,['max']);assert.equal(fromUpstream.defaultEffort,'max');
 const fromManual=fillModelMetadata(manual,undefined,{manualFallback:true});assert.deepEqual(fromManual.reasoningEfforts,['manual']);assert.equal(fromManual.defaultEffort,'manual');
 const denied=fillModelMetadata({...manual,upstreamCapabilities:{isReasoning:false,reasoningEfforts:[]}},three,{manualFallback:true});assert.equal(denied.isReasoning,false);assert.deepEqual(denied.reasoningEfforts,[]);assert.equal(denied.defaultEffort,null);assert.equal(modelConfig(denied).reasoning,false);
 const deniedByAPI=fillModelMetadata(manual,{...three,reasoning_effort:{supported:false,levels:null,field_status:{supported:'verified'}}},{manualFallback:true});assert.equal(deniedByAPI.isReasoning,false);assert.deepEqual(deniedByAPI.reasoningEfforts,[]);
 const qwen=qoderModel({key:'qmodel_latest',is_reasoning:false,thinking_config:{enabled:{is_default:true},disabled:{}}});const effective=fillModelMetadata(qwen,three);assert.equal(effective.isReasoning,false);assert.deepEqual(effective.reasoningEfforts,[]);assert.equal(modelConfig(effective).reasoning,false);
 const kimi=qoderModel({key:'kmodel_latest',is_reasoning:false,thinking_config:{enabled:{efforts:{low:{},high:{},max:{is_default:true}}}}});assert.deepEqual(fillModelMetadata(kimi,three).reasoningEfforts,['low','high','max']);
 const unknown=qoderModel({key:'unknown',thinking_config:{enabled:{efforts:{}}}});assert.deepEqual(fillModelMetadata(unknown,three).reasoningEfforts,['low','medium','high']);
});

test('local official references fill missing public models and yield to future llm-pricing entries',async t=>{
 const dataDir=await fixture(t);await mkdir(path.join(dataDir,'proxy'));
 const local={...reference,id:'grok-local',price_basis:{source:'local',urls:['https://docs.x.ai/developers/pricing']},billing:{cache_write_mode:'included_in_input'},checked_at:'2026-10-11'};
 await writeFile(path.join(dataDir,'proxy/model-reference-supplement.json'),JSON.stringify(payload(local,'local-v1')));
 let current=payload();const options={dataDir,fetchImpl:async()=>Response.json(current)};
 const metadata=createModelMetadata(options);await metadata.refresh();let info=await metadata.read();assert.equal(info.models.length,2);assert.equal(info.meta.local_reference_count,1);
 const model=metadata.enrich('grok',[{id:'grok-local',contextWindow:256000}])[0];assert.equal(model.contextWindow,256000);assert.equal(model.cost.input,2);assert.equal(model.priceInfo.basis,'official-reference');assert.equal(model.priceInfo.referenceEstimate,true);assert.match(modelPriceLabel(model),/缓存建立计入普通输入/);assert.deepEqual(model.priceInfo.sources,local.price_basis.urls);
 const version=info.meta.data_version;const restarted=createModelMetadata(options);await restarted.refresh();assert.equal(restarted.enrich('grok',[{id:'grok-local'}])[0].cost.input,2);
 current=payload({...local,pricing:{...local.pricing,input:8}},'public-v2');await metadata.refresh(true);assert.equal(metadata.enrich('grok',[{id:'grok-local'}])[0].cost.input,8);info=await metadata.read();assert.equal(info.models.length,1);assert.notEqual(info.meta.data_version,version);assert.equal(info.meta.local_reference_count,undefined);
});

test('published Grok prices replace the local supplement and update Pi rates without treating unknown cache writes as free',async t=>{
 const dataDir=await fixture(t);await mkdir(path.join(dataDir,'proxy'));
 const id='grok-4.7-build-fast',local={...reference,id,pricing:{input:4,output:12,cached_input:1,cache_write:4},pricing_tiers:[],billing:{cache_write_mode:'included_in_input'}};
 await writeFile(path.join(dataDir,'proxy/model-reference-supplement.json'),JSON.stringify(payload(local,'local')));
 let clock=1000,current=payload();
 const metadata=createModelMetadata({dataDir,now:()=>clock,ttlMs:100,fetchImpl:async()=>Response.json(current)});
 await metadata.refresh();const saved={id,contextWindow:256000,maxOutputTokens:1000,effort:'high'};
 let model=metadata.enrich('grok',[saved])[0];assert.equal(model.cost.output,12);
 const published={...local,pricing:{input:4,output:13,cached_input:1,cache_write:null},pricing_status:{input:'reference',output:'reference',cached_input:'reference',cache_write:'not_listed'},pricing_tiers:[{input_tokens_gt:200000,input_tokens_lte:null,input:6,output:18,cached_input:1.5,cache_write:null}],price_basis:{type:'reference',sources:['https://docs.x.ai/developers/pricing']},billing:{channel:'subscription',cached_input_type:'implicit'}};
 current=payload(published,'public-v2');clock+=101;await metadata.refresh();model=metadata.enrich('grok',[model])[0];
 assert.deepEqual(stripModelMetadata(model),saved);assert.equal(model.priceInfo.basis,'llm-pricing');assert.equal(model.priceInfo.version,'public-v2');assert.equal(model.priceInfo.referenceEstimate,true);assert.equal(model.priceInfo.cacheWriteIncluded,true);assert.deepEqual(model.priceInfo.sources,published.price_basis.sources);
 assert.deepEqual(modelConfig(model).cost,{input:4,output:13,cacheRead:1,cacheWrite:4,tiers:[{inputTokensAbove:200000,input:6,output:18,cacheRead:1.5,cacheWrite:6}]});
 const manual=metadata.enrich('grok',[{...saved,cost:{input:9,cacheWrite:7,tiers:[]}}])[0];assert.equal(manual.cost.input,9);assert.equal(manual.cost.cacheWrite,7);assert.deepEqual(manual.cost.tiers,[]);
 const other=metadata.enrich('custom:example',[saved])[0];assert.equal(other.cost.cacheWrite,null);assert.equal(modelConfig(other).cost,undefined);
 current=payload({...published,pricing:{...published.pricing,input:null}},'public-v3');clock+=101;await metadata.refresh();model=metadata.enrich('grok',[model])[0];assert.equal(model.cost.cacheWrite,null);assert.equal(modelConfig(model).cost,undefined);
});

test('statistics reference pricing uses published reference rates rather than manual or upstream account prices',async t=>{
 const dataDir=await fixture(t),metadata=createModelMetadata({dataDir,fetchImpl:async()=>Response.json(payload({...reference,price_basis:{type:'official',sources:['https://example.invalid/api-prices']}}))});
 await metadata.refresh();const model=metadata.enrich('custom:one',[{id:'reference',cost:{input:999,output:999,cacheRead:999,cacheWrite:999}}])[0];
 assert.equal(model.cost.input,999);const priced=metadata.referencePricing('custom:one',model);assert.equal(priced.cost.input,2);assert.equal(priced.cost.output,10);assert.deepEqual(priced.info.sources,['https://example.invalid/api-prices']);
});

test('statistics reference pricing carries the catalog tier schedule with both bounds, even where Pi cost tiers cannot represent it',async t=>{
 const dataDir=await fixture(t),bounded={...reference,pricing_tiers:[{input_tokens_gt:32000,input_tokens_lte:256000,input:3,output:12,cached_input:.3,cache_write:3},{input_tokens_gt:256000,input_tokens_lte:1000000,input:6,output:20,cached_input:.6,cache_write:6}]};
 const metadata=createModelMetadata({dataDir,fetchImpl:async()=>Response.json(payload(bounded))});await metadata.refresh();
 const model=metadata.enrich('custom:one',[{id:'reference'}])[0],priced=metadata.referencePricing('custom:one',model);
 assert.deepEqual(priced.tiers.map(tier=>[tier.above,tier.atMost,tier.input,tier.cacheRead]),[[32000,256000,3,.3],[256000,1000000,6,.6]]);
 const open=createModelMetadata({dataDir:await fixture(t),fetchImpl:async()=>Response.json(payload())});await open.refresh();
 assert.deepEqual(open.referencePricing('custom:one',open.enrich('custom:one',[{id:'reference'}])[0]).tiers.map(tier=>[tier.above,tier.atMost,tier.input,tier.output,tier.cacheRead,tier.cacheWrite]),[[272000,null,4,15,.2,5]]);
});
