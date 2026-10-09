import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { error, hash } from './files.mjs';
import { privateEnvironmentNames } from './mcp-config.mjs';

export function createProbes({ environment = process.env, timeoutMs = 15000 } = {}) {
  const probes = new Map();
  const publicProbe = probe => { const { controller, task, transport, ...value } = probe; return structuredClone(value); };
  function remember(probe) {
    probes.set(probe.id, probe);
    if (probes.size > 100) for (const [id, value] of probes) if (value.finishedAt) { probes.delete(id); break; }
  }
  async function run(probe, server) {
    const client = new Client({ name: 'daylight-diagnostics', version: '1.0.0' }, { capabilities: {} });
    const timer = setTimeout(() => probe.controller.abort('timeout'), timeoutMs); timer.unref();
    const signal = probe.controller.signal;
    let closing;
    const closeTransport = () => closing ||= (async () => { await client.close().catch(() => {}); await probe.transport?.close().catch(() => {}); })();
    const onAbort = () => { void closeTransport(); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const values = {};
      for (const [key, ref] of Object.entries(server.envRefs || server.headerRefs || {})) {
        if (!environment[ref]) throw error('缺少环境变量：' + ref, 400, 'EXTENSIONS_ENV_MISSING');
        if (privateEnvironmentNames.includes(ref) || privateEnvironmentNames.includes(key) || privateEnvironmentNames.some(name => environment[name] && environment[name] === environment[ref])) throw error('公共 MCP 不会获得 Daylight 内部凭据', 400, 'EXTENSIONS_ENV_PRIVATE');
        values[key] = environment[ref];
      }
      if (server.transport === 'stdio') {
        const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG'].filter(key => environment[key] !== undefined).map(key => [key, environment[key]]));
        env.PATH = path.dirname(process.execPath) + path.delimiter + (environment.PATH || '');
        probe.transport = new StdioClientTransport({ command: server.command, args: server.args, cwd: server.cwd, env: { ...env, ...values }, stderr: 'ignore', maxBufferSize: 2_000_000 });
      } else probe.transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: values }, fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])]), redirect: 'error' }), reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
      await client.connect(probe.transport, { signal, timeout: timeoutMs });
      const tools = [], cursors = new Set(); let cursor;
      if (client.getServerCapabilities()?.tools) do {
        const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: timeoutMs });
        tools.push(...page.tools.map(tool => ({ name: tool.name.slice(0, 200) })));
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor) || tools.length > 2000 || cursors.size >= 100) throw error('工具分页超过检测上限');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (signal.aborted) throw error('检测已取消');
      probe.status = 'succeeded'; probe.tools = tools; probe.toolCount = tools.length;
      probe.serverVersion = client.getServerVersion()?.version?.slice(0, 100) || null;
      probe.protocolVersion = probe.transport.protocolVersion || 'SDK 已协商';
      probe.message = '握手和工具清单读取成功；其他软件的加载与业务权限仍需分别核对。';
    } catch (failure) {
      probe.status = signal.aborted ? signal.reason === 'timeout' ? 'timed_out' : 'cancelled' : 'failed';
      // Never retain raw server errors/stderr, which may contain credentials.
      probe.message = ['EXTENSIONS_ENV_MISSING', 'EXTENSIONS_ENV_PRIVATE'].includes(failure.code) ? failure.message : probe.status === 'timed_out' ? '检测超时，请检查服务是否能够启动或连通。' : probe.status === 'cancelled' ? signal.reason === 'configuration_changed' ? '主配置已变化，旧配置的检测已取消。' : '检测已取消。' : failure.code === 'ENOENT' ? '找不到可执行命令，请检查安装和 PATH。' : failure.code === 401 || failure.code === 403 || failure.name === 'UnauthorizedError' ? '服务要求授权；请检查环境变量引用。' : '握手或工具清单读取失败，请检查配置及服务状态。';
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', onAbort);
      await closeTransport();
      probe.finishedAt = new Date().toISOString();
    }
  }
  function start(server, id = randomUUID(), { confirmed = false } = {}) {
    if (probes.has(id)) return publicProbe(probes.get(id));
    if ([...probes.values()].filter(probe => !probe.finishedAt).length >= 2) {
      if (!confirmed) throw error('最多同时检测两个 MCP 服务，请等待或取消现有检测', 409, 'EXTENSIONS_PROBE_BUSY');
      // The approval receipt is already durable. Retain an explicit failure instead
      // of making that successful submission look like an unknown write result.
      const now = new Date().toISOString();
      const probe = { id, serverId: server.id, configRevision: hash(server), status: 'failed', startedAt: now, finishedAt: now, controller: new AbortController(), tools: [], toolCount: null, message: '当前检测已满，本次确认没有启动连接。请等待或取消现有检测后重新检测。' };
      remember(probe); return publicProbe(probe);
    }
    const probe = { id, serverId: server.id, configRevision: hash(server), status: 'running', startedAt: new Date().toISOString(), controller: new AbortController(), tools: [], toolCount: null, message: '正在握手并读取工具清单…' };
    remember(probe); probe.task = run(probe, server);
    return publicProbe(probe);
  }
  function get(id) { const probe = probes.get(id); if (!probe) throw error('检测记录不存在或进程已重启，请明确发起新的检测', 404, 'EXTENSIONS_PROBE_MISSING'); return publicProbe(probe); }
  async function cancel(id, reason = 'cancelled') { const probe = probes.get(id); get(id); if (probe.status === 'running') probe.controller.abort(reason); await probe.task; return get(id); }
  async function reconcile(servers) {
    const current = new Map(servers.map(server => [server.id, server.revision]));
    await Promise.all([...probes.values()].filter(probe => !probe.finishedAt && probe.configRevision !== current.get(probe.serverId)).map(probe => cancel(probe.id, 'configuration_changed')));
  }
  return { start, get, cancel, reconcile, latest(serverId) { const values = [...probes.values()].filter(probe => probe.serverId === serverId); return values.length ? publicProbe(values.at(-1)) : null; }, async close() { await Promise.all([...probes.values()].map(probe => cancel(probe.id))); } };
}
