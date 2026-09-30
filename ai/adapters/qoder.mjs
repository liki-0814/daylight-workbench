import { qoderEvents } from './qoder-events.mjs';
import { query, qodercliAuth } from '@qoder-ai/qoder-agent-sdk';
import { executable, childEnv } from './process.mjs';
import { instructions } from '../tools/definitions.mjs';
const base = (config, cwd) => ({ pathToQoderCLIExecutable: executable('qoder', config.path), auth: qodercliAuth(), cwd, env: childEnv(), tools: [], skills: [], settingSources: [], strictMcpConfig: true, mcpServers: {}, permissionMode: 'default', includePartialMessages: true, systemPrompt: instructions });
export async function discover(settings, cwd) {
  let release;
  const wait = new Promise(r => { release = r; });
  async function* empty() { await wait; }
  const q = query({ prompt: empty(), options: { ...base(settings, cwd), persistSession: false } });
  try {
    const init = await q.initializationResult();
    const models = await q.getAvailableModels({ fetchStrategy: 'live' });
    return { path: executable('qoder', settings.path), version: init.qodercli_version, models: models.map(m => ({ id: m.modelId || m.id || m.value || m.model, name: m.displayName || m.modelName || m.name || m.label || m.id, efforts: m.efforts || [], contextWindows: m.availableContextWindows || [], maxInputTokens: m.maxInputTokens, maxOutputTokens: m.maxOutputTokens })).filter(m => m.id) };
  } finally { release(); q.close(); }
}
export async function run({ conversation: c, cwd, mcp, text, emit, signal, setSession, ask }) {
  let release;
  const wait = new Promise(r => { release = r; });
  async function* input() { yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: c.sessionId || '' }; await wait; }
  const extraArgs = {};
  if (c.config.effort) extraArgs['reasoning-effort'] = c.config.effort;
  if (c.config.contextWindow) extraArgs['context-window'] = String(c.config.contextWindow);
  if (c.config.maxOutputTokens) extraArgs['max-output-tokens'] = String(c.config.maxOutputTokens);
  const q = query({ prompt: input(), options: { ...base(c.config, cwd), model: c.config.model, resume: c.sessionId || undefined, extraArgs, mcpServers: { daylight: mcp }, allowedTools: ['mcp__daylight__daylight_get_workspace', 'mcp__daylight__daylight_ask_user', 'mcp__daylight__daylight_propose_changes'], canUseTool: async (name, input) => {
    if (name === 'AskUserQuestion') {
      const answers = {};
      for (const question of input.questions || []) answers[question.question] = await ask(question.question);
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }
    return { behavior: 'deny', message: 'Daylight 仅开放工作台工具' };
  } } });
  const abort = () => { void q.interrupt().catch(() => {}); q.close(); release(); };
  signal.addEventListener('abort', abort, { once: true });
  const record = qoderEvents(emit);
  try {
    if (signal.aborted) throw new Error('已取消');
    for await (const m of q) {
      if (m.session_id) setSession(m.session_id);
      record(m);
      if (m.type === 'result') { if (m.is_error || m.subtype !== 'success') throw new Error(m.errors?.join('\n') || m.result || 'Qoder 请求失败'); break; }
    }
  } finally { signal.removeEventListener('abort', abort); release(); q.close(); }
}
