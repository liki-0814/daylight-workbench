import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { initialState, validate, localDate } from './public/model.js';
import { taskQuery } from './public/task-view.js';
import { resolveRoute, capabilities } from './core/contracts.js';
import { prepareTaskWrite } from './core/task-write.js';
import { calendarQuery } from './core/calendar-query.js';
import { createFocusService } from './focus/service.mjs';
import { defaultDataDir, migrateLegacyData } from './storage.mjs';

import { createAIService } from './ai/service.mjs';
import { createProxyService } from './proxy/service.js';

const root = path.dirname(fileURLToPath(import.meta.url));

export async function createWorkbench({ dataDir = defaultDataDir, proxyOptions = {}, aiAdapters, focusOptions = {}, extensionsOptions = {} } = {}) {
  if (path.resolve(dataDir) === path.resolve(defaultDataDir)) await migrateLegacyData(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const dataFile = path.join(dataDir, 'state.json');
  let record;
  try {
    record = JSON.parse(await readFile(dataFile, 'utf8'));
    validate(record.state);
    if (!Number.isInteger(record.version) || record.version < 0) throw new Error('无效的数据版本');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`无法读取 ${dataFile}，原文件已保留：${error.message}`);
    record = { version: 0, state: initialState() };
    await writeFile(dataFile, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });
  }
  const token = randomBytes(32).toString('hex');
  const agentTokenFile = path.join(dataDir, 'agent-token');
  let agentToken;
  try { agentToken = (await readFile(agentTokenFile, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    agentToken = randomBytes(32).toString('hex');
    await writeFile(agentTokenFile, agentToken, { mode: 0o600, flag: 'wx' });
  }
  if (!/^[a-f0-9]{64}$/.test(agentToken)) throw new Error('agent-token 格式异常，原文件已保留');
  let proxy;
  let proxyError;
  try { proxy = await createProxyService({ dataDir, includeAgy: true, includeGrok: true, includeGateway: true, ...proxyOptions }); } catch (error) { proxyError = error.message; }
  let aiPromise;
  const getAI = () => aiPromise ||= createAIService({ dataDir, adapters: aiAdapters, endpoint: () => `http://127.0.0.1:${server.address().port}` });
  let extensionsPromise;
  const getExtensions = () => extensionsPromise ||= import('./extensions/service.mjs').then(({ createExtensionsService }) => createExtensionsService({ ...extensionsOptions, onChanged: event => server.emit('extensions-changed', event) }));
  let writing = false;
  const focus = await createFocusService({ dataDir, getTaskSnapshot: () => ({ version: record.version, state: record.state }), isTaskWriting: () => writing, ...focusOptions });
  const persist = async (state, receipt) => {
    const receipts = receipt ? [...(record.receipts || []), receipt].slice(-100) : record.receipts || [];
    const next = { version: record.version + 1, state, receipts };
    await copyFile(dataFile, path.join(dataDir, 'state.previous.json'));
    await writeFile(path.join(dataDir, 'state.tmp'), JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(path.join(dataDir, 'state.tmp'), dataFile);
    record = next;
    server.emit('state-changed');
    return focus.reconcileTasks({ version: record.version, state: record.state, committedAt: Date.now() });
  };
  const readBody = async req => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4_000_000) throw new Error('请求超过 4 MB');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const snapshot = () => ({ version: record.version, state: record.state });
  const server = http.createServer(async (req, res) => {
    const send = (code, value) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const expectedHost = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== expectedHost) return send(403, { error: '请使用本机 127.0.0.1 地址访问' });
    try {
      const route = new URL(req.url, `http://${expectedHost}`).pathname;
      const dispatch = resolveRoute(route, req.method);
      if (dispatch.auth === 'web' || dispatch.auth === 'webOrigin') {
        if (req.headers['x-workbench-token'] !== token || (dispatch.auth === 'webOrigin' ? req.headers.origin !== `http://${expectedHost}` : req.headers.origin && req.headers.origin !== `http://${expectedHost}`)) return send(403, { error: '本机会话验证失败，请刷新页面' });
      }
      if (dispatch.auth === 'agent') {
        const bearer = req.headers.authorization?.replace(/^Bearer /, '') || '';
        if (!/^[a-f0-9]{64}$/.test(bearer) || !timingSafeEqual(Buffer.from(bearer), Buffer.from(agentToken)) || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)) return send(401, { error: '本地 Agent API 认证失败' });
      }
      if (dispatch.handler === 'ai' || dispatch.handler === 'proxy') {
        req.url = req.url.replace(route, dispatch.target);
        if (dispatch.handler === 'ai') return await (await (dispatch.service === 'extensions' ? getExtensions() : getAI())).handle(req, res);
        if (!proxy) return send(503, { error: proxyError });
        return await proxy.handle(req, res);
      }
      if (dispatch.handler === 'tasks') {
        try { return send(200, taskQuery(record.state, record.version, Object.fromEntries(new URL(req.url, `http://${expectedHost}`).searchParams))); }
        catch (e) { return send(e.status || 400, { error: e.message }); }
      }
      if (dispatch.handler === 'calendar') {
        try { return send(200, { localDate: localDate(), ...calendarQuery(record.state, record.version, new URL(req.url, `http://${expectedHost}`).searchParams) }); }
        catch (error) { return send(error.status || 400, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
      }
      if (dispatch.handler === 'focus') return await focus.handle(req, res);
      if (dispatch.handler === 'state') return send(200, { ...snapshot(), localDate: localDate() });
      if (dispatch.handler === 'capabilities') return send(200, capabilities());
      if (dispatch.handler === 'missing') return send(404, { error: '接口不存在' });
      if (dispatch.handler === 'actions') {
        let body;
        try { body = await readBody(req); } catch (error) { return send(400, { error: error.message }); }
        const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        let decision = prepareTaskWrite(record, body, fingerprint, { busy: writing });
        if (decision.needsPrevious) {
          // Reserve the write while loading the previous record asynchronously.
          writing = true;
          try {
            let previous;
            try { previous = JSON.parse(await readFile(path.join(dataDir, 'state.previous.json'), 'utf8')); } catch { previous = null; }
            decision = prepareTaskWrite(record, body, fingerprint, { previous });
            if (decision.receipt) { const warnings = await persist(decision.state, decision.receipt); if (warnings.length) decision.value.warnings = warnings; }
            return send(decision.code, decision.value);
          } finally { writing = false; }
        }
        if (!decision.receipt) return send(decision.code, decision.value);
        writing = true;
        try { const warnings = await persist(decision.state, decision.receipt); if (warnings.length) decision.value.warnings = warnings; return send(decision.code, decision.value); }
        finally { writing = false; }
      }
      if (dispatch.handler === 'webState') return send(200, { ...snapshot(), token });
      if (dispatch.handler === 'webWrite') {
        let input;
        try { input = await readBody(req); } catch (error) { return send(400, { error: error.message }); }
        if (writing || req.headers['if-match'] !== String(record.version)) return send(409, { error: '其他窗口已更新数据，已为你加载最新内容，请重新操作' });
        let state;
        try { state = validate(input); }
        catch (error) { return send(400, { error: error.message }); }
        writing = true;
        try {
          const warnings = await persist(state);
          send(200, { ...snapshot(), ...(warnings.length ? { warnings } : {}) });
        } finally { writing = false; }
        return;
      }
      if (!dispatch.file) return send(404, { error: '页面不存在' });
      const file = dispatch.file;
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': `${types[path.extname(file)]}; charset=utf-8` });
      res.end(await readFile(path.join(root, 'public', file)));
    } catch (error) {
      console.error('Request failed:', error.message);
      if (!res.headersSent) send(500, { error: '保存或读取失败，原数据已保留，请重试' });
      else res.end();
    }
  });
  server.once('listening', () => { void proxy?.initialize(); });
  server.once('close', () => { void focus.close(); void proxy?.close(); void aiPromise?.then(ai => ai.close()); void extensionsPromise?.then(service => service.close()); });
  server.closeProxy = async () => { await focus.close(); await proxy?.close(); await aiPromise?.then(ai => ai.close()); await extensionsPromise?.then(service => service.close()); };
  server.getSnapshot = snapshot;
  server.getFocusService = () => focus;
  server.getExtensionsService = getExtensions;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = process.env.PORT || '4318', port = Number(value);
  let server, stopping;
  const stop = () => stopping ||= (async () => {
    try { await server?.closeProxy(); }
    finally { if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  })();
  try {
    if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 必须是 0–65535 的整数；通常使用 4318。');
    // Check before loading shared data: a running desktop/web instance must
    // not trigger recovery or configuration initialization in a second process.
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
    server = await createWorkbench({ dataDir: process.env.WORKBENCH_DATA_DIR, extensionsOptions: { agentsRoot: process.env.WORKBENCH_AGENTS_ROOT, ...(process.env.WORKBENCH_EXTENSION_CLIENT_ROOTS ? { clientRoots: JSON.parse(process.env.WORKBENCH_EXTENSION_CLIENT_ROOTS) } : {}) } });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().catch(error => { console.error('Daylight 停止失败：' + error.message); process.exitCode = 1; }); });
    await new Promise((resolve, reject) => {
      const failed = error => reject(error);
      server.once('error', failed);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', failed); resolve(); });
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    console.log(`Daylight Web 已启动：${url}`);
    console.log(`数据目录：${path.resolve(process.env.WORKBENCH_DATA_DIR || defaultDataDir)}`);
    console.log('可在设置中连接本机 Codex / Qoder；扩展管理与 CLI 配置直接使用本地服务。按 Ctrl+C 停止。');
    if (process.argv.includes('--open') && !process.argv.includes('--no-open')) {
      const command = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler'] : ['xdg-open'];
      execFile(command[0], [...command.slice(1), url], error => { if (error) console.error(`无法自动打开浏览器，请手动访问 ${url}`); });
    }
  } catch (error) {
    await stop();
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。请退出正在运行的 Daylight 后重试；同时运行测试实例时，请设置独立的 PORT 和 WORKBENCH_DATA_DIR。` : 'Daylight Web 启动失败：' + error.message);
    process.exitCode = 1;
  }
}
