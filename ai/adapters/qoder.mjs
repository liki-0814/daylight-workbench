import { qoderEvents } from './qoder-events.mjs';
import { query, qodercliAuth } from '@qoder-ai/qoder-agent-sdk';
import { executable, childEnv } from './process.mjs';
import { instructions, definitions } from '../tools/definitions.mjs';
import { quickInstructions } from '../quick.mjs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
const base = (config, cwd) => ({ pathToQoderCLIExecutable: executable('qoder', config.path), auth: qodercliAuth(), cwd, env: childEnv(), tools: { type: 'preset', preset: 'qodercli' }, settingSources: ['user', 'project', 'local'], permissionMode: 'default', includePartialMessages: true, systemPrompt: { type: 'preset', preset: 'qodercli', append: instructions } });
export function permissions({ ask, approve, accessMode = 'standard' }) {
  return async (name, input, options = {}) => {
    if (name === 'AskUserQuestion') {
      const answers = {};
      for (const question of input.questions || []) answers[question.question] = await ask(question.question);
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }
    if (accessMode === 'full') return { behavior: 'allow', updatedInput: input, permissionScope: 'once' };
    const allowed = await approve({ question: options.title || options.decisionReason || `Qoder 请求使用 ${name}`, details: JSON.stringify({ tool: name, input, ...(options.blockedPath ? { path: options.blockedPath } : {}) }, null, 2) });
    return allowed ? { behavior: 'allow', updatedInput: input, permissionScope: 'once' } : { behavior: 'deny', message: '用户拒绝了本次操作' };
  };
}
export async function discover(settings, cwd) {
  let release;
  const wait = new Promise(r => { release = r; });
  async function* empty() { await wait; }
  const q = query({ prompt: empty(), options: { ...base(settings, cwd), persistSession: false } });
  try {
    const init = await q.initializationResult();
    const models = await q.getAvailableModels({ fetchStrategy: 'live' });
    // Qoder identifies skills by their native name, including plugin-qualified names.
    return { path: executable('qoder', settings.path), version: init.qodercli_version, skills: (init.skills || []).map(s => ({ name: s.name, path: `qoder:${s.name}`, description: s.description || '', enabled: true })), models: models.map(m => ({ id: m.modelId || m.id || m.value || m.model, name: m.displayName || m.modelName || m.name || m.label || m.id, efforts: m.efforts || [], contextWindows: m.availableContextWindows || [], maxInputTokens: m.maxInputTokens, maxOutputTokens: m.maxOutputTokens })).filter(m => m.id) };
  } finally { release(); q.close(); }
}
export async function run({ conversation: c, cwd, mcp, text, skills = [], emit, signal, setSession, ask, approve, ephemeral = false }) {
  let release, stopped = Promise.resolve();
  const wait = new Promise(r => { release = r; });
  const content = skills.length ? `用户明确选择了以下本机技能，请通过原生 Skill 工具使用：${JSON.stringify(skills.map(s => s.name))}\n\n${text}` : text;
  async function* input() { yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: c.sessionId || '' }; await wait; }
  const extraArgs = {};
  if (c.config.effort) extraArgs['reasoning-effort'] = c.config.effort;
  if (c.config.contextWindow) extraArgs['context-window'] = String(c.config.contextWindow);
  if (c.config.maxOutputTokens) extraArgs['max-output-tokens'] = String(c.config.maxOutputTokens);
  // CLI diagnostic logs can contain prompts even with session persistence off.
  // Keep runtime files temporary while reading the existing login in place.
  const env = childEnv();
  const transientOptions = ephemeral ? { persistSession: false, tools: [], settingSources: [], strictMcpConfig: true, systemPrompt: quickInstructions, env: { ...env, QODER_SDK_AUTH_CONFIG_DIR: env.QODER_CONFIG_DIR || path.join(env.QODER_CLI_HOME || homedir(), env.QODER_CONFIG_DIR_NAME || '.qoder'), QODER_CONFIG_DIR: path.join(cwd, 'qoder') }, spawnQoderCLIProcess({ command, args, cwd, env }) {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    stopped = new Promise(resolve => child.once('close', resolve));
    return child;
  } } : {};
  const q = query({ prompt: input(), options: { ...base(c.config, cwd), ...(c.config.accessMode === 'full' && !ephemeral ? { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true } : {}), model: c.config.model, resume: ephemeral ? undefined : c.sessionId || undefined, extraArgs, mcpServers: ephemeral ? {} : { daylight: mcp }, allowedTools: ephemeral ? [] : definitions.map(t => `mcp__daylight__${t.name}`), canUseTool: permissions({ ask, approve, accessMode: ephemeral ? 'standard' : c.config.accessMode }), ...transientOptions } });
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
  } finally { signal.removeEventListener('abort', abort); release(); if (ephemeral) { try { await q.close(); } finally { await stopped; } } else q.close(); }
}
