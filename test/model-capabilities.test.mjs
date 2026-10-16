import test from 'node:test';
import assert from 'node:assert/strict';
import {parseModel as qoder} from '../proxy/qoder/models.js';
import {parseModels as kimi} from '../proxy/kimi/models.js';
import {parseModels as grok} from '../proxy/grok/models.js';
import {parseModels as codex} from '../proxy/codex/models.js';
import {parseModels as custom,modelUnion,validateModels} from '../proxy/custom/models.js';
import {parseModels as agy} from '../proxy/agy/models.js';
import {reasoningCapabilities,reasoningCapabilityLabel} from '../core/model-capabilities.js';
import {validateModelSetting} from '../proxy/shared/contracts.js';
import {updateModelSetting} from '../proxy/shared/model-settings.js';
import {ModelRouter} from '../proxy/shared/router.js';
import {createManagement} from '../proxy/management.js';
import {createProxyState} from '../public/proxy/state.js';
import {modelConfig} from '../cli/pi-config.js';
import {fillModelMetadata} from '../core/model-metadata.js';

test('missing upstream capability fields stay unknown across providers and Pi',()=>{
 const models=[qoder({key:'q'}),kimi({data:[{id:'k'}]})[0],grok({data:[{id:'g',api_backend:'responses'}]})[0],codex({models:[{slug:'c',visibility:'list'}],meta:{}})[0],custom({data:[{id:'u'}]})[0]];
 for(const m of models){assert.equal(m.isReasoning,undefined,m.id);assert.equal(m.isVL,undefined,m.id);const configured=modelConfig(m,{reasoning:true,input:['text','image']});assert.equal(configured.reasoning,true);assert.deepEqual(configured.input,['text','image']);}
});
test('declared reasoning levels and thinking-only metadata are positive evidence',()=>{
 const models=[qoder({key:'q',thinking_config:{enabled:{efforts:{high:{}}}}}),kimi({data:[{id:'k',reasoning:{type:'only',effort:{valid:['high']}}}]})[0],grok({data:[{id:'g',api_backend:'responses',reasoning_efforts:[{value:'high'}]}]})[0],codex({models:[{slug:'c',visibility:'list',supported_reasoning_efforts:[{reasoning_effort:'high'}]}],meta:{}})[0],custom({data:[{id:'u',reasoning_efforts:['high']}]})[0]];
 for(const m of models){assert.equal(m.isReasoning,true,m.id);assert.deepEqual(m.reasoningEfforts,['high']);}
 assert.equal(validateModels([{id:'unknown',reasoningEfforts:[]}])[0].isReasoning,undefined);
 assert.throws(()=>validateModels([{id:'bad',reasoningEfforts:['high'],isReasoning:false}]),/不能配置/);
 assert.equal(kimi({data:[{id:'k',supports_reasoning:false,supports_image_in:false}]})[0].isReasoning,false);
});
test('Qoder thinking configuration overrides the legacy false flag without inventing efforts',()=>{
 const kimi=qoder({key:'kmodel_latest',is_reasoning:false,thinking_config:{enabled:{efforts:{low:{},high:{},max:{is_default:true}}}}});
 assert.equal(kimi.isReasoning,true);assert.deepEqual(kimi.reasoningEfforts,['low','high','max']);assert.equal(kimi.defaultEffort,'max');assert.equal(kimi.upstreamIsReasoning,false);
 assert.equal(modelConfig(kimi).reasoning,true);assert.equal(modelConfig(kimi).thinkingLevelMap.max,'max');assert.equal(modelConfig(kimi).thinkingLevelMap.off,null);
 const toggle=qoder({key:'qmodel',is_reasoning:false,thinking_config:{enabled:{is_default:true},disabled:{}}});
 assert.equal(toggle.isReasoning,false);assert.deepEqual(toggle.reasoningEfforts,[]);assert.equal(toggle.defaultEffort,undefined);
 const noLevels=qoder({key:'on-only',is_reasoning:false,thinking_config:{enabled:{}}});
 assert.equal(noLevels.isReasoning,false);assert.deepEqual(noLevels.reasoningEfforts,[]);assert.equal(noLevels.reasoningEffortsProvided,true);
 assert.deepEqual(fillModelMetadata(noLevels,{id:'reference',reasoning_effort:{levels:['low','high'],field_status:{levels:'verified'}}}).reasoningEfforts,[]);
 assert.equal(qoder({key:'plain',is_reasoning:false}).isReasoning,false);
 const disabled=qoder({key:'disabled',is_reasoning:false,thinking_config:{disabled:{}}});assert.equal(disabled.isReasoning,false);assert.deepEqual(disabled.reasoningEfforts,[]);
});
test('all provider adapters apply the shared priority for concrete reasoning evidence',()=>{
 const levels=['low','medium','high'];
 const models=[
  qoder({key:'q',is_reasoning:false,thinking_config:{enabled:{efforts:Object.fromEntries(levels.map(level=>[level,{}]))}}}),
  kimi({data:[{id:'k',supports_reasoning:false,reasoning:{effort:{valid:levels}}}]})[0],
  grok({data:[{id:'g',api_backend:'responses',supports_reasoning:false,reasoning_efforts:levels.map(value=>({value}))}]})[0],
  codex({models:[{slug:'c',visibility:'list',supported_reasoning_efforts:levels.map(reasoning_effort=>({reasoning_effort}))}],meta:{}})[0],
  custom({data:[{id:'u',supports_reasoning:false,reasoning_efforts:levels}]})[0],
  agy([{id:'a-tiered',displayName:'A'}],{models:{'a-tiered':{supportsThinking:true}}})[0],
 ];
 for(const model of models){assert.equal(model.isReasoning,true,model.id);assert.deepEqual(model.reasoningEfforts,levels,model.id);assert.equal(reasoningCapabilityLabel(model),'low · medium · high');assert.equal(modelConfig(model).reasoning,true);assert.equal(modelConfig(model).thinkingLevelMap.high,'high');}
 assert.equal(reasoningCapabilities(false,[],'only').isReasoning,false);
 assert.equal(reasoningCapabilityLabel(reasoningCapabilities(undefined,[])),'未提供');
 assert.equal(reasoningCapabilityLabel(reasoningCapabilities(false,[])),'不支持思考');
 assert.equal(reasoningCapabilityLabel(reasoningCapabilities(undefined,['none'],'enabled')),'支持思考（强度未提供） · 可关闭思考');
 assert.deepEqual(reasoningCapabilities(false,['none','high'],'only').reasoningEfforts,['high']);
});
test('empty effort lists use matched reference levels across all provider adapters',()=>{
 const reference={id:'reference',reasoning_effort:{levels:['low','high'],field_status:{levels:'verified'}}};
 const models=[qoder({key:'q',thinking_config:{enabled:{efforts:{}}}}),kimi({data:[{id:'k',supports_reasoning:true,reasoning:{effort:{valid:[]}}}]})[0],grok({data:[{id:'g',api_backend:'responses',supports_reasoning:true,reasoning_efforts:[]}]})[0],codex({models:[{slug:'c',visibility:'list',supported_reasoning_efforts:[]}],meta:{}})[0],custom({data:[{id:'u',supports_reasoning:true,reasoning_efforts:[]}]})[0],agy([{id:'a',displayName:'A'}],{models:{a:{supportsThinking:true}}})[0]];
 for(const model of models){assert.equal(model.reasoningEffortsProvided,true,model.id);assert.deepEqual(fillModelMetadata(model,reference).reasoningEfforts,['low','high'],model.id);}
});
test('Key pooling and source routing apply identical conservative capability rules',async()=>{
 const known={id:'same',enabled:true,contextLimit:1000,contextWindow:1000,outputLimit:100,maxOutputTokens:100,defaultMaxTokens:80,isVL:true,isReasoning:true,reasoningEfforts:['high']};
 const missing={id:'same',enabled:true};
 const router=new ModelRouter({a:{},b:{}});router.setCatalog('a',[known]);router.setCatalog('b',[missing]);
 const routed=(await router.publishModels())[0],pooled=modelUnion([{models:[known]},{models:[missing]}])[0];
 for(const field of ['contextWindow','contextLimit','maxOutputTokens','outputLimit','defaultMaxTokens','isVL','isReasoning','reasoningEfforts']){assert.equal(routed[field],undefined,field);assert.equal(pooled[field],undefined,field);}
});
test('AI validation, HTTP management and persistence agree on clearing and invalid budgets',async()=>{
 const model={id:'m',maxOutputTokens:100,settingFields:['maxTokens']};
 const saved=[];const management=createManagement({registry:{providers:{p:{setModel:async input=>{const settings=updateModelSetting({},model,input,{fields:['maxTokens'],invalid:message=>new Error(message)});saved.push(settings);return[model];}}}},router:{refreshSource:async()=>[model],setCatalog(){}}});
 validateModelSetting(model,{field:'maxTokens',value:null});await management.call('/api/proxy/sources/p/models/setting',{id:'m',field:'maxTokens',value:null});assert.deepEqual(saved,[{maxTokens:{}}]);
 for(const value of [0,101,1.5]){assert.throws(()=>validateModelSetting(model,{field:'maxTokens',value}));await assert.rejects(management.call('/api/proxy/sources/p/models/setting',{id:'m',field:'maxTokens',value}));assert.throws(()=>updateModelSetting({},model,{field:'maxTokens',value},{fields:['maxTokens'],invalid:message=>new Error(message)}));}
});
test('saved custom sources are returned without waiting for any model discovery',async()=>{
 let discoveryCalls=0;
 const management=createManagement({registry:{providers:{},custom:{list:async()=>[{id:'saved'}]}},router:{listModels:()=>{discoveryCalls++;return new Promise(()=>{});},conflicts:[]}});
 const result=await management.call('/api/proxy/custom/sources');assert.deepEqual(result.sources,[{id:'saved'}]);assert.equal(discoveryCalls,0);
});
test('custom configuration reads reuse shared in-flight resources',async()=>{
 let calls=0,resolve;
 const store=createProxyState({custom:async()=>{calls++;return new Promise(r=>resolve=r);}});
 const a=store.resource('custom','sources',{refresh:true}),b=store.resource('custom','sources',{refresh:true});resolve({sources:[{id:'saved'}]});
 assert.deepEqual(await a,await b);assert.equal(calls,1);store.dispose();
});
test('Pi output-budget compatibility comes from capabilities, not source names',()=>{
 assert.equal(modelConfig({id:'x',source:'future',requestOutputBudget:false}).compat.supportsMaxOutputTokens,false);
 assert.equal(modelConfig({id:'x',source:'codex'}).compat.supportsMaxOutputTokens,undefined);
});
