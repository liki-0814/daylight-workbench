import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discover, run } from '../ai/adapters/pi.mjs';
import extension from '../ai/adapters/pi-extension.mjs';

async function fixture(t, events = []) {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-pi-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'pi'), log = path.join(dir, 'calls.jsonl');
  await writeFile(bin, `#!${process.execPath}
const fs=require('fs'),rl=require('readline').createInterface({input:process.stdin});
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2)})+'\\n');
rl.on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\\n');if(!r.id||r.type==='extension_ui_response')return;
const model={provider:'local',id:'example',name:'Example',reasoning:true,contextWindow:100000,maxTokens:8000};
const data=r.type==='get_available_thinking_levels'?{levels:['off','low']}:r.type==='get_available_models'?{models:[model]}:r.type==='get_state'?{model,sessionId:'pi-session'}:r.type==='get_commands'?{commands:[{name:'skill:review',source:'skill',sourceInfo:{path:'/skills/review/SKILL.md'}}]}:{};
console.log(JSON.stringify({type:'response',id:r.id,success:true,data}));
if(r.type==='prompt')for(const e of ${JSON.stringify(events)})console.log(JSON.stringify(e));
});`);
  await chmod(bin, 0o700);
  const c = { id: 'conversation-id', config: { path: bin, model: 'local/example', accessMode: 'standard', effort: 'low' } };
  return { dir, bin, log, c, calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse) };
}
const success = [{ type: 'message_start', message: { role: 'assistant' } }, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' } }, { type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }, { type: 'agent_settled', aborted: false }];
const args = f => ({ conversation: f.c, cwd: f.dir, mcp: { env: { DAYLIGHT_TOOL_URL: 'http://127.0.0.1:1/test', DAYLIGHT_TOOL_TOKEN: 'fixture' } }, text: 'question', signal: new AbortController().signal, setSession() {}, ask: async () => 'yes', approve: async () => false, emit() {} });

test('Pi discovers provider-qualified models, CLI default and native skills without persisting sessions', async t => {
  const f = await fixture(t);
  const result = await discover({ path: f.bin }, f.dir);
  assert.equal(result.models[0].id, 'local/example'); assert.equal(result.defaultModel, 'local/example');
  assert.equal(result.skills[0].name, 'review'); assert.equal(result.skills[0].path, '/skills/review/SKILL.md');
  const calls=await f.calls(); assert(calls[0].args.includes('--no-session')); assert(calls[0].args.includes('--no-mcp'));
});
test('Pi streams answers, preserves conversation identity and selects exact provider/model before prompting', async t => {
  const f=await fixture(t,success), events=[], sessions=[];
  await run({...args(f),emit:e=>events.push(e),setSession:id=>sessions.push(id)});
  const calls=await f.calls();
  assert.deepEqual(calls.find(c=>c.type==='set_model'),{id:'1',type:'set_model',provider:'local',modelId:'example'});
  assert(calls[0].args.includes('--extension')); assert(calls[0].args.includes('conversation-id'));
  assert.equal(calls.find(c=>c.type==='prompt').message,'question');
  assert.deepEqual(sessions,['pi-session']); assert.deepEqual(events,[{type:'delta',text:'answer'}]);
});
test('Pi quick answers disable tools, MCP, extensions, context files and session persistence', async t => {
  const f=await fixture(t,success); let sessions=0;
  const images=[{mimeType:'image/png',data:'aGVsbG8='}];
  await run({...args(f),images,ephemeral:true,setSession:()=>sessions++});
  const calls=await f.calls(), argv=calls[0].args;
  for(const option of ['--no-session','--no-tools','--no-skills','--no-extensions','--no-mcp','--no-context-files'])assert(argv.includes(option));
  assert(!argv.includes('--extension')); assert(!argv.includes('--session-id')); assert.equal(sessions,0);
  assert.deepEqual(calls.find(call=>call.type==='prompt').images,[{type:'image',...images[0]}]);
});
test('Pi errors and cancellation reject instead of reporting successful answers', async t => {
  const f=await fixture(t,[{type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'provider failed'}},{type:'agent_settled'}]);
  await assert.rejects(run(args(f)),/provider failed/);
  const idle=await fixture(t), controller=new AbortController();
  const pending=run({...args(idle),signal:controller.signal});
  setTimeout(()=>controller.abort(),30);
  await assert.rejects(pending,/已取消|CLI 进程已退出/);
});
test('Pi tool extension exposes Daylight tools and requires standard-mode approval for native tools', async t => {
  const tools=[], handlers={};
  extension({registerTool:tool=>tools.push(tool),on:(event,handler)=>handlers[event]=handler});
  assert(tools.some(tool=>tool.name==='daylight_propose_changes'));
  const previous=process.env.DAYLIGHT_PI_ACCESS_MODE;
  t.after(()=>{if(previous===undefined)delete process.env.DAYLIGHT_PI_ACCESS_MODE;else process.env.DAYLIGHT_PI_ACCESS_MODE=previous;});
  process.env.DAYLIGHT_PI_ACCESS_MODE='standard';
  const context={ui:{confirm:async()=>false}};
  assert.equal((await handlers.tool_call({toolName:'bash',input:{command:'pwd'}},context)).block,true);
  assert.equal(await handlers.tool_call({toolName:'daylight_get_context',input:{}},context),undefined);
  process.env.DAYLIGHT_PI_ACCESS_MODE='full';
  assert.equal(await handlers.tool_call({toolName:'bash',input:{}},context),undefined);
});
