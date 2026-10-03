import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server.mjs';
import { CustomSources } from '../proxy/custom/sources.js';
import { createAIService, validateSettings } from '../ai/service.mjs';
const delay = ms => new Promise(r => setTimeout(r, ms));
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', r));
const close = s => new Promise(r => { s.close(r); s.closeAllConnections(); });
const settings = { backend: 'codex', codex: { path: '', model: 'test-model', effort: 'low' }, qoder: { path: '', model: 'test-qoder', effort: '' } };
async function contextEndpoint(t, dir) {
  await writeFile(path.join(dir, 'agent-token'), 'a'.repeat(64));
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:0,localDate:'2026-10-01',state:{schema:1,projects:[],tasks:[],plans:{}}}));});
  await listen(server); t.after(()=>close(server));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-ai-test-'));
  const emptyProvider={listModels:async()=>[]};
  const secrets=new Map(),customSources=new CustomSources({dataDir:dir,secrets:{get:async id=>secrets.get(id),set:async(id,value)=>secrets.set(id,value),delete:async id=>secrets.delete(id)}});
  const workbench = await createWorkbench({ dataDir: dir,proxyOptions:{provider:emptyProvider,agyProvider:emptyProvider,grokProvider:emptyProvider,codexProvider:emptyProvider,kimiProvider:emptyProvider,customSources,piOptions:{piDir:path.join(dir,'pi'),getInfo:async()=>({installed:true})}} }); await listen(workbench);
  const endpoint = `http://127.0.0.1:${workbench.address().port}`;
  const sessions = [], modes = [];
  const adapter = { discover: async () => ({ models: [{ id: 'test-model', efforts: ['low'] }, { id: 'test-qoder', efforts: [] }] }), run: async ({ mcp, text, ask, emit, conversation, setSession }) => {
    text = text.split('\n\n<daylight_context>')[0];
    modes.push(conversation.config.accessMode); sessions.push(conversation.sessionId); setSession(conversation.sessionId || 'cli-session');
    if (text === 'ask') emit({ type: 'delta', text: await ask('请补充任务标题') });
    else if (text === 'pi-config') {
      const response=await fetch(mcp.env.DAYLIGHT_TOOL_URL,{method:'POST',headers:{Authorization:`Bearer ${mcp.env.DAYLIGHT_TOOL_TOKEN}`},body:JSON.stringify({name:'daylight_propose_proxy_changes',arguments:{summary:'开启 Pi 自动同步',action:{type:'pi.automatic',options:{enabled:true}}}})});
      const result=await response.json();emit({type:'delta',text:result.ok?'Pi 已配置':'未保存'});
    }
    else if (text === 'ai-settings') {
      const response=await fetch(mcp.env.DAYLIGHT_TOOL_URL,{method:'POST',headers:{Authorization:`Bearer ${mcp.env.DAYLIGHT_TOOL_TOKEN}`},body:JSON.stringify({name:'daylight_propose_ai_changes',arguments:{summary:'更新 AI 默认模型',action:{type:'ai.settings',settings:{...settings,codex:{...settings.codex,model:'test-qoder',effort:''}}}}})});
      const result=await response.json();emit({type:'delta',text:result.ok?'AI 设置已保存':'未保存'});
    }
    else if (text === 'proxy' || text === 'proxy-keys') {
      const response=await fetch(mcp.env.DAYLIGHT_TOOL_URL,{method:'POST',headers:{Authorization:`Bearer ${mcp.env.DAYLIGHT_TOOL_TOKEN}`},body:JSON.stringify({name:'daylight_propose_proxy_changes',arguments:{summary:'创建测试代理',action:{type:'source.save',source:text==='proxy-keys'?{name:'AI Keys',baseUrl:'https://example.com/v1',protocol:'chat',keys:[{id:'one',models:[{id:'a'}]},{id:'two',models:[{id:'b'}]}]}:{name:'AI Test',baseUrl:'https://example.com/v1',protocol:'chat',auth:'none',models:[{id:'m'}]}}}})});
      const result=await response.json();emit({type:'delta',text:result.ok?'代理已保存':'未保存'});
    }
    else {
      const action = text === 'delete' ? { type: 'project.delete', id: 'p-test' } : { type: 'task.create', id: 't-test', title: '草稿标题', notes: '待确认', today: true };
      const response = await fetch(mcp.env.DAYLIGHT_TOOL_URL, { method: 'POST', headers: { Authorization: `Bearer ${mcp.env.DAYLIGHT_TOOL_TOKEN}` }, body: JSON.stringify({ name: 'daylight_propose_changes', arguments: { summary: '创建测试任务', action } }) });
      const result = await response.json(); emit({ type: 'delta', text: result.ok ? '已保存' : '未保存' });
    }
  } };
  const ai = await createAIService({ dataDir: dir, endpoint, adapters: { codex: adapter, qoder: adapter } });
  const server = http.createServer(ai.handle); await listen(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  const api = async (route, data) => { const r = await fetch(url + '/api/ai/' + route, { method: data ? 'POST' : 'GET', ...(data ? { body: JSON.stringify(data) } : {}) }); return { status: r.status, ...await r.json() }; };
  const state = async () => (await (await fetch(endpoint + '/api/state')).json()).state;
  const wait = async (id, predicate) => { for (let i = 0; i < 100; i++) { const r = await api('conversations/' + id); if (predicate(r.conversation)) return r.conversation; await delay(20); } throw new Error('wait timeout'); };
  t.after(async () => { await ai.close(); await close(server); await workbench.closeProxy(); await close(workbench); await delay(100); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  await api('settings', settings);
  const apply = async action => {
    const { readFile }=await import('node:fs/promises'); const token=(await readFile(path.join(dir,'agent-token'),'utf8')).trim();
    const snapshot=workbench.getSnapshot();
    const response=await fetch(endpoint+'/api/v1/actions',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({requestId:'test-'+crypto.randomUUID(),expectedVersion:snapshot.version,action})});
    const result=await response.json(); assert.equal(response.status,200,JSON.stringify(result)); return result;
  };
  return { ai, api, state, wait, sessions, modes, dir, secrets, customSources, apply };
}
test('AI question waits for a real answer; stale answers fail; next turn resumes the same CLI session', async t => {
  const f = await fixture(t), c = (await f.api('conversations', {})).conversation;
  await f.api(`conversations/${c.id}/message`, { text: 'ask' });
  const waiting = await f.wait(c.id, c => c.status === 'waiting');
  assert.equal((await f.state()).tasks.length, 0);
  assert.equal((await f.api(`conversations/${c.id}/answer`, { id: 'wrong', answer: 'no' })).status, 409);
  await f.api(`conversations/${c.id}/answer`, { id: waiting.pending.id, answer: '明确的回答' });
  const done = await f.wait(c.id, c => c.status === 'idle');
  assert.equal(done.messages.at(-1).text, '明确的回答');
  await f.api(`conversations/${c.id}/message`, { text: 'ask' });
  await f.wait(c.id, c => c.status === 'waiting');
  assert.deepEqual(f.sessions, [null, 'cli-session']);
  await f.api(`conversations/${c.id}/cancel`, {});
  await f.wait(c.id, c => c.status === 'interrupted');
  assert.equal((await f.api(`conversations/${c.id}/answer`, { id: waiting.pending.id, answer: 'late' })).status, 409);
});
test('AI draft is inert until approved, supports editing, and cannot be applied twice', async t => {
  const f = await fixture(t), c = (await f.api('conversations', {})).conversation;
  await f.api(`conversations/${c.id}/message`, { text: 'draft' });
  const waiting = await f.wait(c.id, c => c.pending?.type === 'changes');
  assert.equal((await f.state()).tasks.length, 0);
  const action = { ...waiting.pending.action, title: '用户修改后的标题' };
  const r = await f.api(`conversations/${c.id}/answer`, { id: waiting.pending.id, approve: true, action }); assert.equal(r.status, 200);
  await f.wait(c.id, c => c.status === 'idle');
  const state = await f.state(); assert.equal(state.tasks.length, 1); assert.equal(state.tasks[0].title, action.title);
  assert.equal((await f.api(`conversations/${c.id}/answer`, { id: waiting.pending.id, approve: true })).status, 409);
  assert.equal((await f.state()).tasks.length, 1);
});
test('AI settings are snapshotted per conversation; cancelling a draft never writes', async t => {
  const f = await fixture(t), c = (await f.api('conversations', {})).conversation;
  await f.api('settings', { ...settings, backend: 'qoder' });
  assert.equal((await f.api('conversations/' + c.id)).conversation.backend, 'codex');
  assert.equal((await f.api('conversations', {})).conversation.backend, 'qoder');
  await f.api(`conversations/${c.id}/message`, { text: 'draft' });
  const waiting = await f.wait(c.id, c => c.pending);
  await f.api(`conversations/${c.id}/answer`, { id: waiting.pending.id, approve: false });
  await f.wait(c.id, c => c.status === 'idle');
  assert.equal((await f.state()).tasks.length, 0);
});
test('settings reject executable injection and invalid token budgets', () => {
  assert.throws(() => validateSettings({ ...settings, codex: { ...settings.codex, path: 'codex; rm' } }));
  assert.throws(() => validateSettings({ ...settings, qoder: { ...settings.qoder, maxOutputTokens: -1 } }));
  assert.equal(validateSettings(settings).codex.contextWindow, null);
});

test('model changes preserve session identity and leave defaults unchanged', async t => {
  const f = await fixture(t), c = (await f.api('conversations', {})).conversation;
  await f.api(`conversations/${c.id}/message`, { text: 'ask' });
  const waiting = await f.wait(c.id, c => c.pending);
  assert.equal((await f.api(`conversations/${c.id}/model`, { model: 'test-qoder' })).status, 409);
  await f.api(`conversations/${c.id}/answer`, { id: waiting.pending.id, answer: '继续' });
  await f.wait(c.id, c => c.status === 'idle');
  const switched = (await f.api(`conversations/${c.id}/model`, { model: 'test-qoder' })).conversation;
  assert.equal(switched.sessionId, 'cli-session'); assert.equal(switched.config.model, 'test-qoder');
  assert.equal((await f.api('settings')).settings.codex.model, 'test-model');
  assert.equal((await f.api(`conversations/${c.id}/model`, { model: 'missing' })).status, 400);
});

test('cross-conversation references are explicit snapshots, can cross backends, and reject unknown/self references', async () => {
  const { referenceSnapshots } = await import('../ai/service.mjs');
  const conversations = new Map([['a', { id:'a',title:'项目分析',backend:'codex',messages:[{role:'user',text:'标记 A'}] }], ['b', {id:'b',title:'其他',backend:'qoder',messages:[] }]]);
  const refs = referenceSnapshots(['a'], 'b', conversations);
  conversations.get('a').messages[0].text = 'changed';
  assert.equal(refs[0].messages[0].text, '标记 A'); assert.equal(refs[0].backend, 'codex');
  assert.throws(() => referenceSnapshots(['missing'], 'b', conversations));
  assert.throws(() => referenceSnapshots(['b'], 'b', conversations));
  assert.deepEqual(referenceSnapshots(undefined, 'b', conversations), []);
});

test('model catalogs persist, refresh explicitly, isolate paths and pass validated skill references', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-ai-cache-')); let count = 0, used;
  const adapter = { discover: async config => { count++; return {path:config.path || '/cli/codex', models:[{id:'test-model',efforts:['low','high']}],skills:[{name:'example',path:'/skills/example/SKILL.md',enabled:true}]}; }, run: async ({skills}) => {used=skills;} };
  const endpoint=await contextEndpoint(t,dir);
  let ai, server;
  async function boot() {ai=await createAIService({dataDir:dir,endpoint,adapters:{codex:adapter,qoder:adapter}});server=http.createServer(ai.handle);await listen(server);}
  async function stop() {await ai.close();await close(server);}
  const api = async (route, data) => {const r=await fetch(`http://127.0.0.1:${server.address().port}/api/ai/${route}`,{method:'POST',body:JSON.stringify(data)});return {status:r.status,...await r.json()};};
  await boot(); t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
  await api('settings',settings);
  await api('discover',{backend:'codex'});await api('discover',{backend:'codex'});assert.equal(count,1);
  await stop();await boot();await api('discover',{backend:'codex'});assert.equal(count,1);
  await api('discover',{backend:'codex',path:'/cli/codex',force:true});assert.equal(count,2);
  await api('discover',{backend:'codex'});assert.equal(count,2);
  await api('discover',{backend:'codex',path:'/cli/other'});assert.equal(count,3);
  const c=(await api('conversations',{})).conversation;
  assert.equal((await api(`conversations/${c.id}/message`,{text:'hi',skills:['/unknown']})).status,400);
  assert.equal((await api(`conversations/${c.id}/message`,{text:'hi',skills:['/skills/example/SKILL.md']})).status,200);
  await delay(20);assert.deepEqual(used,[{name:'example',path:'/skills/example/SKILL.md'}]);
});

test('legacy Qoder catalogs refresh once and accept native skill references', async t => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-qoder-catalog-'));
  await mkdir(path.join(dir, 'ai'));
  await writeFile(path.join(dir, 'ai/catalogs.json'), JSON.stringify({ '["qoder",""]': { models: [{ id: 'test-qoder', efforts: [] }] } }));
  let discoveries = 0, selected;
  const skill = { name: 'example', path: 'qoder:example', enabled: true };
  const adapter = { discover: async () => { discoveries++; return { models: [{ id: 'test-qoder', efforts: [] }], skills: [skill] }; }, run: async ({ skills }) => { selected = skills; } };
  const endpoint=await contextEndpoint(t,dir);
  const ai = await createAIService({ dataDir: dir, endpoint, adapters: { qoder: adapter } });
  const server = http.createServer(ai.handle); await listen(server);
  t.after(async () => { await ai.close(); await close(server); await rm(dir, { recursive: true, force: true }); });
  const api = async (route, data) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api/ai/${route}`, { method: 'POST', body: JSON.stringify(data) }); return { status: r.status, ...await r.json() }; };
  await api('settings', { ...settings, backend: 'qoder' });
  assert.deepEqual((await api('discover', { backend: 'qoder' })).skills, [skill]);
  await api('discover', { backend: 'qoder' }); assert.equal(discoveries, 1);
  const c = (await api('conversations', {})).conversation;
  assert.equal((await api(`conversations/${c.id}/message`, { text: 'hi', skills: ['qoder:unknown'] })).status, 400);
  assert.equal((await api(`conversations/${c.id}/message`, { text: 'hi', skills: [skill.path] })).status, 200);
  await delay(20); assert.deepEqual(selected, [{ name: skill.name, path: skill.path }]);
});

 test('shared MCP proxy tool creates inert draft and applies only through user review',async t=>{
  const f=await fixture(t),c=(await f.api('conversations',{})).conversation;
  const {readJson}=await import('../proxy/shared/store.js');
  const file=path.join(f.dir,'custom-proxy/sources.json');
  await f.api(`conversations/${c.id}/message`,{text:'proxy'});
  const waiting=await f.wait(c.id,c=>c.pending?.type==='proxyChanges');
  assert.equal((await readJson(file,[])).length,0);
  assert.equal(waiting.pending.requiresKey,false);
  const applied=await f.api(`conversations/${c.id}/answer`,{id:waiting.pending.id,approve:true});assert.equal(applied.status,200,JSON.stringify(applied));
  const done=await f.wait(c.id,c=>c.status==='idle');
  assert.equal((await readJson(file,[]))[0].name,'AI Test');
  assert.equal(done.messages.at(-1).text,'代理已保存');
  assert.equal((await f.api(`conversations/${c.id}/answer`,{id:waiting.pending.id,approve:true})).status,409);
 });

test('saved access modes apply to existing conversations on next send and can return to standard', async t => {
  const f = await fixture(t), c = (await f.api('conversations', {})).conversation;
  await f.api('settings', { ...settings, codex: { ...settings.codex, accessMode: 'full' }, qoder: { ...settings.qoder, accessMode: 'standard' } });
  await f.api(`conversations/${c.id}/message`, { text: 'ask' });
  const waiting = await f.wait(c.id, c => c.status === 'waiting');
  await f.api('settings', settings);
  assert.equal((await f.api('conversations/' + c.id)).conversation.pending.id, waiting.pending.id);
  await f.api(`conversations/${c.id}/answer`, { id: waiting.pending.id, answer: '继续' });
  await f.wait(c.id, c => c.status === 'idle');
  await f.api(`conversations/${c.id}/message`, { text: 'ask' });
  await f.wait(c.id, c => c.status === 'waiting');
  assert.deepEqual(f.modes, ['full', 'standard']);
  assert.deepEqual(f.sessions, [null, 'cli-session']);
  assert.equal(validateSettings(settings).qoder.accessMode, 'standard');
  assert.throws(() => validateSettings({ ...settings, codex: { ...settings.codex, accessMode: 'invalid' } }));
});

test('AI multi Key MCP draft accepts secure review inputs without exposing credentials to conversation',async t=>{
 const f=await fixture(t),c=(await f.api('conversations',{})).conversation;
 await f.api(`conversations/${c.id}/message`,{text:'proxy-keys'});
 const waiting=await f.wait(c.id,c=>c.pending?.type==='proxyChanges');
 assert.deepEqual(waiting.pending.requiresKeys.map(k=>k.id),['one','two']);
 assert.equal(f.secrets.size,0);
 const applied=await f.api(`conversations/${c.id}/answer`,{id:waiting.pending.id,approve:true,apiKeys:{one:'secure-key-one',two:'secure-key-two'}});
 assert.equal(applied.status,200,JSON.stringify(applied));
 const done=await f.wait(c.id,c=>c.status==='idle');
 assert(!JSON.stringify(done).includes('secure-key-'));
 const saved=(await f.customSources.list())[0];
 assert.equal(await f.customSources.readKey(saved.id,'one'),'secure-key-one');
 assert.equal(await f.customSources.readKey(saved.id,'two'),'secure-key-two');
 const files=await (await import('node:fs/promises')).readdir(path.join(f.dir,'ai/conversations'));
 for(const file of files){const text=await (await import('node:fs/promises')).readFile(path.join(f.dir,'ai/conversations',file),'utf8');assert(!text.includes('secure-key-'));}
});


test('explicit task association, references, move/delete/undo and scope conflicts keep authoritative IDs', async t => {
  const f=await fixture(t);
  await f.apply({type:'batch',actions:[{type:'project.create',id:'p-test',name:'项目 A'},{type:'project.create',id:'p-other',name:'项目 B'},{type:'task.create',id:'t-linked',title:'关联任务',projectId:'p-test',notes:'备注不是指令'}]});
  assert.equal((await f.api('conversations',{scope:{kind:'task',id:'missing'}})).status,404);
  const c=(await f.api('conversations',{scope:{kind:'task',id:'t-linked'}})).conversation;
  await f.api(`conversations/${c.id}/message`,{text:'ask',objectReferences:[{kind:'project',id:'p-other'}]});
  const waiting=await f.wait(c.id,c=>c.status==='waiting');
  const context=waiting.messages[0].context;
  assert.equal(context.primary.task.id,'t-linked'); assert.equal(context.primary.task.notes,'备注不是指令');
  assert.equal(context.objectReferences[0].project.id,'p-other');
  assert.equal((await f.api(`conversations/${c.id}/scope`,{scope:{kind:'project',id:'p-other'},expectedScopeVersion:0})).status,409);
  await f.api(`conversations/${c.id}/answer`,{id:waiting.pending.id,answer:'继续'}); await f.wait(c.id,c=>c.status==='idle');
  await f.apply({type:'task.update',id:'t-linked',projectId:'p-other'});
  assert.equal((await f.api('conversations/'+c.id)).conversation.scopeInfo.projectId,'p-other');
  const related=await f.api('conversations?scope=project&scopeId=p-other&related=1');
  assert.equal(related.conversations[0].id,c.id);
  await f.apply({type:'task.delete',id:'t-linked'});
  assert.equal((await f.api('conversations/'+c.id)).conversation.scopeInfo.exists,false);
  await f.apply({type:'undo'});
  assert.equal((await f.api('conversations/'+c.id)).conversation.scopeInfo.exists,true);
  const rebound=await f.api(`conversations/${c.id}/scope`,{scope:{kind:'project',id:'p-other'},expectedScopeVersion:0});
  assert.equal(rebound.conversation.scopeVersion,1); assert.equal(rebound.conversation.sessionId,'cli-session');
  assert.equal((await f.api(`conversations/${c.id}/scope`,{scope:{kind:'workspace'},expectedScopeVersion:0})).status,409);
  assert.equal((await f.api(`conversations/${c.id}/scope`,{scope:{kind:'project',id:'p-other'},expectedScopeVersion:0})).status,200);
  assert.equal(context.primary.projectId,'p-test');
});

test('AI management drafts require approval, reject stale defaults and return configuration links', async t => {
  const f=await fixture(t),c=(await f.api('conversations',{})).conversation;
  const read=await f.ai.tool(f.ai.store.conversations.get(c.id),'daylight_get_ai',{});
  assert.equal(read.settings.codex.model,'test-model');
  await f.api(`conversations/${c.id}/message`,{text:'ai-settings'});
  const pending=await f.wait(c.id,c=>c.pending?.type==='aiChanges');
  assert.equal((await f.api('settings')).settings.codex.model,'test-model');
  assert.equal((await f.api(`conversations/${c.id}/answer`,{id:pending.pending.id,approve:true})).status,200);
  const done=await f.wait(c.id,c=>c.status==='idle');
  assert.equal((await f.api('settings')).settings.codex.model,'test-qoder');
  assert.equal(done.messages.find(m=>m.role==='operation').action.type,'ai.settings');
  await f.api(`conversations/${c.id}/message`,{text:'ai-settings'});
  const stale=await f.wait(c.id,c=>c.pending?.type==='aiChanges');
  await f.api('settings',settings);
  assert.equal((await f.api(`conversations/${c.id}/answer`,{id:stale.pending.id,approve:true})).status,409);
  assert.equal((await f.api('settings')).settings.codex.model,'test-model');
});

test('Pi operations execute through the AI tool bridge only after user approval', async t => {
  const f=await fixture(t),c=(await f.api('conversations',{})).conversation;
  const before=await f.ai.tool(f.ai.store.conversations.get(c.id),'daylight_get_configuration',{resource:'pi.state'});
  assert.equal(before.automatic.enabled,false);
  await f.api(`conversations/${c.id}/message`,{text:'pi-config'});
  const pending=await f.wait(c.id,c=>c.pending?.type==='proxyChanges');
  assert.equal((await f.ai.tool(f.ai.store.conversations.get(c.id),'daylight_get_configuration',{resource:'pi.state'})).automatic.enabled,false);
  const result=await f.api(`conversations/${c.id}/answer`,{id:pending.pending.id,approve:true});assert.equal(result.status,200,JSON.stringify(result));
  await f.wait(c.id,c=>c.status==='idle');
  assert.equal((await f.ai.tool(f.ai.store.conversations.get(c.id),'daylight_get_configuration',{resource:'pi.state'})).automatic.enabled,true);
});
