import { RPC, executable, childEnv } from './process.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { instructions, definitions } from '../tools/definitions.mjs';
import { quickInstructions } from '../quick.mjs';
import { setTimeout as delay } from 'node:timers/promises';

// Workspace routing is discovered during app-server startup. A transient
// failure can poison that process; retry a fresh process before any turn exists.
export async function startCodex(bin, args, cwd, env, signal) {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new Error('已取消');
    const rpc = new RPC(bin, args, cwd, env);
    const abort = () => { void rpc.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await rpc.initialize();
      await rpc.call('account/read', { refreshToken: false });
      if (signal?.aborted) throw new Error('已取消');
      return rpc;
    } catch (error) {
      await rpc.close();
      if (signal?.aborted) throw new Error('已取消');
      if (attempt >= 2 || !/workspace routing discovery (?:failed|timed out)/i.test(error.message)) throw error;
    } finally { signal?.removeEventListener('abort', abort); }
    await delay(200 * (attempt + 1), undefined, { signal });
  }
}
export function accessPolicy(mode, cwd) {
  const full = mode === 'full';
  return { approvalPolicy: full ? 'never' : 'on-request', sandbox: full ? 'danger-full-access' : 'workspace-write', sandboxPolicy: full ? { type: 'dangerFullAccess' } : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false } };
}
export async function discover(settings, cwd) {
  const bin = executable('codex', settings.path), rpc = await startCodex(bin, ['app-server', '--listen', 'stdio://'], cwd);
  try {
    const [r, listed] = await Promise.all([rpc.call('model/list', { limit: 100 }), rpc.call('skills/list', { cwds: [cwd], forceReload: true })]);
    return { path: bin, models: r.data.filter(m => !m.hidden).map(m => ({ id: m.model, name: m.displayName || m.model, efforts: m.supportedReasoningEfforts.map(e => e.reasoningEffort) })), skills: listed.data.flatMap(d => d.skills).filter(s => s.enabled).map(s => ({name:s.name,path:s.path,description:s.description,enabled:s.enabled})) };
  }
  finally { rpc.close(); }
}
export async function run({ conversation: c, cwd, mcp, text, images = [], skills = [], emit, signal, setSession, ask, approve, ephemeral = false }) {
  const env = childEnv();
  if (ephemeral) {
    const source = env.CODEX_HOME || path.join(homedir(), '.codex'), target = path.join(cwd, 'codex');
    fs.mkdirSync(target, { mode: 0o700 });
    for (const file of ['auth.json', 'config.toml']) {
      try { fs.copyFileSync(path.join(source, file), path.join(target, file)); fs.chmodSync(path.join(target, file), 0o600); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    env.CODEX_HOME = target;
  }
  const rpc = await startCodex(executable('codex', c.config.path), ['app-server', '--listen', 'stdio://', ...(ephemeral ? ['-c', 'mcp_servers={}'] : [])], cwd, env, signal);
  let turnId, threadId, settled, rejectDone;
  const done = new Promise((resolve, reject) => { settled = resolve; rejectDone = reject; });
  // Initialization can fail before this promise is awaited.
  done.catch(() => {});
  rpc.onExit = e => rejectDone(e);
  const abort = () => { if (turnId && threadId) rpc.call('turn/interrupt', { threadId, turnId }).catch(() => {}); rpc.close(); rejectDone(new Error('已取消')); };
  signal.addEventListener('abort', abort, { once: true });
  rpc.onMessage = async r => {
    const p = r.params || {};
    if (r.id !== undefined) {
      if (r.method === 'item/tool/requestUserInput') {
        const answers = {};
        for (const q of p.questions || []) answers[q.id] = { answers: [await ask(q.question || q.header)] };
        rpc.send({ id: r.id, result: { answers } });
      } else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(r.method)) {
        const allowed = await approve({ question: p.reason || 'Codex 请求执行以下操作', details: JSON.stringify(p, null, 2) });
        rpc.send({ id: r.id, result: { decision: allowed ? 'accept' : 'decline' } });
      } else rpc.send({ id: r.id, error: { code: -32601, message: 'Daylight 不支持该工具或操作' } });
      return;
    }
    if (r.method === 'item/agentMessage/delta') emit({ type: 'delta', text: p.delta, itemId: p.itemId });
    if (r.method === 'item/reasoning/summaryTextDelta') emit({type:'process',id:p.itemId,kind:'reasoning',name:'思考摘要',textDelta:p.delta});
    if (r.method === 'item/commandExecution/outputDelta') emit({type:'process',id:p.itemId,textDelta:p.delta});
    if (['item/started','item/completed'].includes(r.method)) {
      const i=p.item, done=r.method==='item/completed';
      if (i && ['reasoning','mcpToolCall','commandExecution','fileChange'].includes(i.type)) {
        const failed=['failed','declined'].includes(i.status) || (i.exitCode != null && i.exitCode !== 0) || i.error;
        emit({type:'process',id:i.id,kind:i.type==='reasoning'?'reasoning':'tool',name:i.type==='reasoning'?'思考摘要':i.tool || (i.type==='commandExecution'?'终端命令':'文件变更'),status:done?(failed?'failed':'completed'):'running',input:i.arguments ?? i.command ?? i.changes,output:done?(i.error ?? i.result ?? i.aggregatedOutput):undefined,...(i.type==='reasoning' && i.summary?.length ? {text:i.summary.join('\n')} : {})});
      }
    }
    if (r.method === 'error' && !p.willRetry) rejectDone(new Error(p.error?.message || 'Codex 请求失败'));
    if (r.method === 'turn/completed') p.turn?.status === 'failed' ? rejectDone(new Error(p.turn.error?.message || 'Codex 请求失败')) : settled();
  };
  try {
    if (signal.aborted) throw new Error('已取消');
    const config = ephemeral ? { 'features.shell_tool': false, 'features.multi_agent': false, 'features.apps': false, web_search: 'disabled', 'history.persistence': 'none' } : { 'mcp_servers.daylight': { ...mcp, required: true, tool_timeout_sec: 3600, tools: Object.fromEntries(definitions.map(t => [t.name, { approval_mode: 'approve' }])) } };
    if (c.config.contextWindow) config.model_context_window = c.config.contextWindow;
    if (c.config.effort) config.model_reasoning_effort = c.config.effort;
    const { approvalPolicy, sandbox, sandboxPolicy } = ephemeral ? { approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } } : accessPolicy(c.config.accessMode, cwd);
    const params = { cwd, model: c.config.model, approvalPolicy, approvalsReviewer: 'user', sandbox, developerInstructions: ephemeral ? quickInstructions : instructions, config };
    const response = c.sessionId && !ephemeral
      ? await rpc.call('thread/resume', { ...params, threadId: c.sessionId })
      : await rpc.call('thread/start', { ...params, allowProviderModelFallback: false, serviceName: 'daylight', ephemeral });
    threadId = response.thread.id; setSession(threadId);
    if (signal.aborted) throw new Error('已取消');
    const turn = await rpc.call('turn/start', { threadId, model: c.config.model, approvalPolicy, sandboxPolicy, ...(c.config.effort ? { effort: c.config.effort } : {}), input: [{ type: 'text', text, text_elements: [] }, ...images.map(image => ({ type: 'image', url: `data:${image.mimeType};base64,${image.data}` })), ...skills.map(s => ({type:'skill',name:s.name,path:s.path}))] });
    turnId = turn.turn.id;
    await done;
  } finally { signal.removeEventListener('abort', abort); rpc.onExit = null; if (ephemeral) await rpc.close(); else rpc.close(); }
}
