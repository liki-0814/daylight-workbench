import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RPC, executable, childEnv } from './process.mjs';
import { instructions } from '../tools/definitions.mjs';
import { quickInstructions } from '../quick.mjs';

// Pi uses JSONL commands/events rather than JSON-RPC. Keep process shutdown,
// framing and request deadlines shared with the other CLI adapter.
export class PiRPC extends RPC {
  constructor(bin, args, cwd, env) {
    super(bin, args, cwd, env);
    this.decode = record => record.type === 'response'
      ? { id: Number(record.id), ...(record.success ? { result: record.data } : { error: { message: record.error || 'Pi 命令失败' } }) }
      : { method: record.type, params: record };
  }
  send(record) {
    super.send(record.method ? { ...record.params, ...(record.id !== undefined ? { id: String(record.id) } : {}), type: record.method } : record);
  }
}
const isolated = ['--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files'];
const modelId = model => `${model.provider}/${model.id}`;

export async function discover(settings, cwd) {
  const bin = executable('pi', settings.path);
  const rpc = new PiRPC(bin, ['--mode', 'rpc', '--no-session', '--no-tools', ...isolated.filter(flag => flag !== '--no-skills')], cwd);
  try {
    const [available, state, commands] = await Promise.all([rpc.call('get_available_models'), rpc.call('get_state'), rpc.call('get_commands')]);
    return { path: bin, defaultModel: state.model ? modelId(state.model) : '', skills: commands.commands.filter(command => command.source === 'skill' && command.sourceInfo?.path).map(command => ({ name: command.name.replace(/^skill:/, ''), path: command.sourceInfo.path, description: command.description || '', enabled: true })), models: available.models.map(model => ({
      id: modelId(model), name: `${model.name || model.id} · ${model.provider}`,
      efforts: model.reasoning ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : ['off'],
      maxInputTokens: model.contextWindow, maxOutputTokens: model.maxTokens,
    })) };
  } finally { await rpc.close(); }
}

export async function run({ conversation: c, cwd, mcp, text, images = [], skills = [], emit, signal, setSession, ask, approve, ephemeral = false }) {
  const env = childEnv();
  const args = ['--mode', 'rpc', '--no-extensions', '--no-mcp', '--no-prompt-templates', '--no-context-files'];
  if (ephemeral) args.push('--no-session', '--no-tools', '--no-skills', '--system-prompt', quickInstructions);
  else {
    args.push('--session-dir', path.join(cwd, 'sessions'), '--session-id', c.id,
      '--extension', fileURLToPath(new URL('./pi-extension.mjs', import.meta.url)), '--append-system-prompt', instructions);
    Object.assign(env, mcp.env, { DAYLIGHT_PI_ACCESS_MODE: c.config.accessMode || 'standard' });
  }
  const rpc = new PiRPC(executable('pi', c.config.path), args, cwd, env);
  const done = Promise.withResolvers(); done.promise.catch(() => {});
  let failure, thinking = false, thinkingId = 0;
  rpc.onExit = error => done.reject(error);
  const abort = () => { rpc.send({ method: 'abort' }); void rpc.close(); done.reject(new Error('已取消')); };
  signal.addEventListener('abort', abort, { once: true });
  rpc.onMessage = async ({ method, params: event }) => {
    if (method === 'message_start' && event.message?.role === 'assistant') { failure = null; thinking = false; thinkingId++; }
    if (method === 'extension_ui_request') {
      if (event.method === 'confirm') rpc.send({ type: 'extension_ui_response', id: event.id, confirmed: !ephemeral && await approve({ question: event.title, details: event.message || '' }) });
      else if (['input', 'editor', 'select'].includes(event.method)) rpc.send({ type: 'extension_ui_response', id: event.id, ...(ephemeral ? { cancelled: true } : { value: await ask([event.title, event.message, event.options?.join('\n')].filter(Boolean).join('\n')) }) });
    }
    if (method === 'message_update') {
      const update = event.assistantMessageEvent;
      if (update?.type === 'text_delta') emit({ type: 'delta', text: update.delta });
      if (update?.type === 'thinking_delta') { thinking = true; emit({ type: 'process', id: `pi-thinking-${thinkingId}`, kind: 'reasoning', name: '思考摘要', textDelta: update.delta }); }
    }
    if (method === 'message_end' && event.message?.role === 'assistant') {
      if (['error', 'aborted'].includes(event.message.stopReason)) failure = new Error(event.message.errorMessage || 'Pi 请求失败');
      if (thinking) emit({ type: 'process', id: `pi-thinking-${thinkingId}`, kind: 'reasoning', name: '思考摘要', status: failure ? 'failed' : 'completed' });
    }
    if (['tool_execution_start', 'tool_execution_end'].includes(method)) emit({ type: 'process', id: event.toolCallId, kind: 'tool', name: event.toolName, status: method === 'tool_execution_start' ? 'running' : event.isError ? 'failed' : 'completed', input: event.args, output: event.result });
    if (method === 'agent_settled') failure || event.aborted ? done.reject(failure || new Error('Pi 请求已中断')) : done.resolve();
  };
  try {
    if (signal.aborted) throw new Error('已取消');
    // Use exact provider/id selection; CLI fuzzy matching must never reroute.
    const slash = c.config.model.indexOf('/');
    if (slash < 1) throw new Error('Pi 模型需要包含 provider/id，请重新检测模型');
    await rpc.call('set_model', { provider: c.config.model.slice(0, slash), modelId: c.config.model.slice(slash + 1) });
    if (c.config.effort) {
      const supported = await rpc.call('get_available_thinking_levels');
      if (!supported.levels.includes(c.config.effort)) throw new Error('Pi 当前模型不支持所选思考强度，请重新设置');
      await rpc.call('set_thinking_level', { level: c.config.effort });
    }
    if (!ephemeral) setSession((await rpc.call('get_state')).sessionId);
    if (signal.aborted) throw new Error('已取消');
    const message = skills.length ? `用户明确引用了以下技能，请读取后按需使用：${JSON.stringify(skills)}\n\n${text}` : text;
    const accepted = await rpc.call('prompt', { message, ...(images.length ? { images: images.map(image => ({ type: 'image', ...image })) } : {}) });
    if (accepted?.disposition === 'handled') throw new Error('Pi 扩展处理了输入，未启动对话');
    await done.promise;
  } finally { signal.removeEventListener('abort', abort); rpc.onExit = null; await rpc.close(); }
}
