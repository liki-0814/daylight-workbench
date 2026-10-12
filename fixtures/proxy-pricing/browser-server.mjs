// Isolated UI/Pi acceptance. No installed App or user CLI files are modified.
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createWorkbench} from '../../server.mjs';
import {CustomSources} from '../../proxy/custom/sources.js';
import {applyModelSettings,updateModelSetting} from '../../proxy/shared/model-settings.js';
import {modelCapabilities} from '../../proxy/shared/contracts.js';
import {writeJson} from '../../proxy/shared/store.js';
const dataDir=process.env.DAYLIGHT_PRICING_FIXTURE_DIR||await mkdtemp(path.join(os.tmpdir(),'daylight-pricing-browser-'));
const piDir=path.join(dataDir,'pi');
const reference={id:'gpt-6.1-sol',name:'GPT-6.1 Sol',limits:{context_length:1050000,max_output_tokens:128000},reasoning_effort:{levels:['low','medium','high','xhigh','max'],default:'medium',can_disable:false,field_status:{levels:'verified'}},pricing:{input:2,output:10,cached_input:.1,cache_write:2.5},pricing_tiers:[{input_tokens_gt:272000,input_tokens_lte:null,input:4,output:15,cached_input:.2,cache_write:5}],price_basis:{type:'official'}};
const snapshot={api_version:'v1',meta:{data_version:'isolated-v1',updated_at:'2026-10-11',currency:'USD',unit:'per_1M_tokens'},data:[reference,{...reference,id:'kimi-for-coding',name:'Kimi for Coding',reasoning_effort:{levels:['low','high','max'],default:'max',can_disable:true,field_status:{levels:'verified'}},limits:{context_length:1048576,max_output_tokens:null},pricing:{input:.95,output:4,cached_input:.19,cache_write:null},pricing_tiers:[],price_basis:{type:'reference'},billing:{channel:'subscription'}}]};
const provider=(id,rows)=>{let settings={};return{cache:{},listModels:async()=>modelCapabilities(applyModelSettings(rows.map(m=>({...m,provider:id,contextWindows:[],reasoningEfforts:m.reasoningEfforts||[]})),settings),['enabled','effort']),async setModel(input){const m=(await this.listModels()).find(m=>m.id===input.id);settings=updateModelSetting(settings,m,input,{fields:m.settingFields,invalid:message=>new Error(message)});return this.listModels();}};};
const customSources=new CustomSources({dataDir,secrets:{get:async()=>'',set:async()=>{},delete:async()=>{}}});
if(!(await customSources.list()).length)await customSources.save({name:'隔离上游',baseUrl:'http://127.0.0.1:49999/v1',auth:'none',protocol:'responses',models:[{id:'api-alias',upstreamId:'vendor-model',enabled:true}],enabled:true});
try{await readFile(path.join(piDir,'models.json'));}catch{await writeJson(path.join(piDir,'models.json'),{providers:{other:{baseUrl:'https://fixture.example/v1',models:[]}}});}
try{await readFile(path.join(piDir,'settings.json'));}catch{await writeJson(path.join(piDir,'settings.json'),{defaultThinkingLevel:'high'});}
const server=await createWorkbench({dataDir,proxyOptions:{
 provider:provider('qoder',[{id:'ultimate',displayName:'别名模型'}]),codexProvider:provider('codex',[{id:'gpt-6.1-sol',displayName:'GPT-6.1 Sol',contextWindow:272000,reasoningEfforts:['low','medium','high','xhigh','max']}]),kimiProvider:provider('kimi',[{id:'kimi-for-coding',displayName:'Kimi for Coding',contextWindow:1048576}]),grokProvider:provider('grok',[{id:'grok-unknown',displayName:'目录未收录的模型'}]),includeAgy:false,includeGateway:false,customSources,
 pricingOptions:{enabled:true,fetchImpl:async()=>Response.json(snapshot)},piOptions:{piDir,getInfo:async()=>({installed:true,version:'隔离验收（本机 Pi 1.1.0）'})},
}});
server.listen(0,'127.0.0.1',async()=>{const url=`http://127.0.0.1:${server.address().port}`;await writeFile(path.join(dataDir,'url'),url);console.log(JSON.stringify({url,dataDir,piDir}));});
async function close(){await server.closeProxy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));process.exit(0);}process.on('SIGINT',close);process.on('SIGTERM',close);
