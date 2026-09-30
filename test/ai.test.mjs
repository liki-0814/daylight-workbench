import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server.mjs';
import { createAIService, validateSettings } from '../ai/service.mjs';
const delay = ms => new Promise(r => setTimeout(r, ms));
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', r));
const close = s => new Promise(r => { s.close(r); s.closeAllConnections(); });
const settings = { backend: 'codex', codex: { path: '', model: 'test-model', effort: 'low' }, qoder: { path: '', model: 'test-qoder', effort: '' } };
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-ai-test-'));
  const emptyProvider={listModels:async()=>[]};
  const workbench = await createWorkbench({ dataDir: dir,proxyOptions:{provider:emptyProvider,agyProvider:emptyProvider,grokProvider:emptyProvider,codexProvider:emptyProvider} }); await listen(workbench);
  const endpoint = `http://127.0.0.1:${workbench.address().port}`;
  const sessions = [];
  const adapter = { discover: async () => ({ models: [{ id: 'test-model', efforts: ['low'] }, { id: 'test-qoder', efforts: [] }] }), run: async ({ mcp, text, ask, emit, conversation, setSession }) => {
    sessions.push(conversation.sessionId); setSession(conversation.sessionId || 'cli-session');
    if (text === 'ask') emit({ type: 'delta', text: await ask('请补充任务标题') });
    else if (text === 'proxy') {
      const response=await fetch(mcp.env.DAYLIGHT_TOOL_URL,{method:'POST',headers:{Authorization:`Bearer ${mcp.env.DAYLIGHT_TOOL_TOKEN}`},body:JSON.stringify({name:'daylight_propose_proxy_changes',arguments:{summary:'创建测试代理',action:{type:'source.save',source:{name:'AI Test',baseUrl:'https://example.com/v1',protocol:'chat',auth:'none',models:[{id:'m'}]}}}})});
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
  return { ai, api, state, wait, sessions, dir };
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
  let ai, server;
  async function boot() {ai=await createAIService({dataDir:dir,adapters:{codex:adapter,qoder:adapter}});server=http.createServer(ai.handle);await listen(server);}
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

 test('shared MCP proxy tool creates inert draft and applies only through user review',async t=>{
  const f=await fixture(t),c=(await f.api('conversations',{})).conversation;
  const {readJson}=await import('../qoder/store.js');
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
