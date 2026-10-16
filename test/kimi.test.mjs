import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {KimiProvider} from '../proxy/kimi/provider.js';
import {RequestTrace} from '../proxy/shared/request-records.js';
const jwt=user=>`header.${Buffer.from(JSON.stringify({user_id:user})).toString('base64url')}.signature`;
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'daylight-kimi-'));t.after(()=>rm(dir,{recursive:true,force:true}));let user='user-a';const calls=[];const auth={credential:async()=>({access_token:jwt(user)})};const p=new KimiProvider({dataDir:dir,auth,fetchImpl:async(url,init)=>{calls.push({url,init});return url.endsWith('/models')?Response.json({data:[{id:'kimi-for-coding',display_name:'K2.8 Preview',context_length:1048576,supports_reasoning:true},{id:'other'}]}):Response.json({choices:[{message:{content:'OK'},finish_reason:'stop'}]});}});return{p,calls,switchUser:()=>{user='user-b';}};}
test('Kimi discovers upstream display names, persists disabled models and retains original request',async t=>{const {p,calls}=await fixture(t);assert.equal((await p.listModels())[0].displayName,'K2.8 Preview');const raw={model:'kimi-for-coding',messages:[{role:'user',content:'hi'}],temperature:0.7,stream:false};const trace=new RequestTrace('/chat/completions');await p.forward(raw,'chat',{observe:x=>trace.observe(x)});assert.equal(raw.temperature,0.7);const body=JSON.parse(calls.at(-1).init.body);assert.ok(!('temperature' in body));assert.equal(body.stream,false);assert.equal(trace.entry.requestedTemperature,0.7);assert.equal(trace.entry.effectiveTemperature,'omitted');await p.setModel({id:'kimi-for-coding',field:'enabled',value:false});assert.equal((await p.listModels())[0].enabled,false);await assert.rejects(p.forward(raw,'chat'),/停用/);});
test('Kimi preserves omitted temperature and other model parameters; known model converts Responses',async t=>{const {p,calls}=await fixture(t);await p.forward({model:'kimi-for-coding',messages:[],stream:true},'chat');assert.ok(!('temperature' in JSON.parse(calls.at(-1).init.body)));await p.forward({model:'other',messages:[],temperature:0.7},'chat');assert.equal(JSON.parse(calls.at(-1).init.body).temperature,0.7);await p.forward({model:'kimi-for-coding',input:'Hi',temperature:0.7,max_output_tokens:32},'responses');assert.equal(JSON.parse(calls.at(-1).init.body).model,'kimi-for-coding');});
test('Kimi OAuth refresh retries once and never replays on a switched account',async t=>{const {p,switchUser}=await fixture(t);await p.listModels();let calls=0;p.fetchImpl=async()=>{calls++;return Response.json({}, {status:calls===1?401:200});};await p.forward({model:'kimi-for-coding',messages:[]},'chat');assert.equal(calls,2);calls=0;p.auth.credential=async(force)=>{if(force)switchUser();return{access_token:jwt(force?'user-b':'user-a')};};await assert.rejects(p.forward({model:'kimi-for-coding',messages:[]},'chat'),/账号已切换/);assert.equal(calls,1);});
test('all four confirmed Kimi model IDs omit any provided temperature; other providers and parameters stay intact',async()=>{
 const {omitKimiTemperature,isOfficialKimiUrl}=await import('../proxy/shared/request-parameters.js');
 for(const model of ['kimi-for-coding','kimi-for-coding-highspeed','k3','k3-256k'])for(const temperature of [0,0.7,1,2]){const input={temperature,top_p:0.8},events=[];omitKimiTemperature(input,model,e=>events.push(e));assert.deepEqual(input,{top_p:0.8});assert.equal(events[0].effectiveTemperature,'omitted');}
 const other={temperature:0.7};omitKimiTemperature(other,'other');assert.equal(other.temperature,0.7);assert.equal(isOfficialKimiUrl('https://relay.example/v1'),false);
});
test('Kimi reads both official effort metadata shapes, saves defaults and respects client effort',async t=>{
 const {p,calls}=await fixture(t);
 const fetchImpl=p.fetchImpl;p.fetchImpl=async(url,init)=>url.endsWith('/models')?Response.json({data:[
 {id:'kimi-for-coding',supports_reasoning:true,reasoning:{type:'only',effort:{valid:['low','high','max'],default:'max'}}},
 {id:'k3',supports_reasoning:true,supports_thinking_type:'only',think_efforts:{valid_efforts:['low','high','max'],default_effort:'high'}},
 {id:'kimi-for-coding-highspeed',supports_reasoning:true,reasoning:{type:'only'}}]}):fetchImpl(url,init);
 const models=await p.listModels();assert.deepEqual(models[0].reasoningEfforts,['low','high','max']);assert.equal(models[0].defaultEffort,'max');assert.equal(models[0].thinkingLevelMap.off,null);assert.equal(models[1].defaultEffort,'high');assert.deepEqual(models[2].reasoningEfforts,[]);
 await p.setModel({id:'k3',field:'effort',value:'low'});assert.equal((await p.listModels())[1].effort,'low');
 await p.forward({model:'k3',input:'Hi'},'responses');assert.equal(JSON.parse(calls.at(-1).init.body).reasoning_effort,'low');
 await p.forward({model:'k3',messages:[],reasoning_effort:'max'},'chat');assert.equal(JSON.parse(calls.at(-1).init.body).reasoning_effort,'max');
 await assert.rejects(p.forward({model:'k3',messages:[],reasoning_effort:'medium'},'chat'),/思考强度/);
 await assert.rejects(p.setModel({id:'kimi-for-coding-highspeed',field:'effort',value:'high'}),/思考强度/);
 await p.setModel({id:'k3',field:'effort',value:'auto'});await p.forward({model:'k3',messages:[]},'chat');assert.ok(!('reasoning_effort' in JSON.parse(calls.at(-1).init.body)));
});
