import http from 'node:http';
import { readFile, writeFile, mkdir, rename, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { initialState, validate, localDate } from './public/model.js';
import { applyAction, operations } from './agent-api.mjs';
import { defaultDataDir, migrateLegacyData } from './storage.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

export async function createWorkbench({ dataDir = defaultDataDir } = {}) {
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
  let writing = false;
  const persist = async (state, receipt) => {
    const receipts = receipt ? [...(record.receipts || []), receipt].slice(-100) : record.receipts || [];
    const next = { version: record.version + 1, state, receipts };
    await copyFile(dataFile, path.join(dataDir, 'state.previous.json'));
    await writeFile(path.join(dataDir, 'state.tmp'), JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(path.join(dataDir, 'state.tmp'), dataFile);
    record = next;
    server.emit('state-changed');
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
      if (route.startsWith('/api/v1/')) {
        const bearer = req.headers.authorization?.replace(/^Bearer /, '') || '';
        if (!/^[a-f0-9]{64}$/.test(bearer) || !timingSafeEqual(Buffer.from(bearer), Buffer.from(agentToken)) || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)) return send(401, { error: '本地 Agent API 认证失败' });
        if (route === '/api/v1/state' && req.method === 'GET') return send(200, { ...snapshot(), localDate: localDate() });
        if (route === '/api/v1/capabilities' && req.method === 'GET') return send(200, { apiVersion: 1, operations, retention: 'last 100 successful request IDs', writes: 'POST /api/v1/actions {requestId, expectedVersion, day?, action}', reads: 'GET /api/v1/state' });
        if (route !== '/api/v1/actions' || req.method !== 'POST') return send(404, { error: '接口不存在' });
        let body;
        try { body = await readBody(req); } catch (error) { return send(400, { error: error.message }); }
        if (!body || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId) || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) return send(400, { error: '需要合法的 requestId 和 expectedVersion' });
        const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const receipt = (record.receipts || []).find(r => r.requestId === body.requestId);
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) return send(409, { error: 'requestId 已用于不同的请求' });
          return send(200, { ...snapshot(), replayed: true, appliedVersion: receipt.appliedVersion });
        }
        if (writing || body.expectedVersion !== record.version) return send(409, { error: '数据版本已变化，请重新读取并核对操作', version: record.version });
        const day = body.day ?? localDate();
        if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) return send(400, { error: 'day 必须是有效的 YYYY-MM-DD 日期' });
        writing = true;
        try {
          let state;
          try {
            if (body.action?.type === 'undo') {
              const previous = JSON.parse(await readFile(path.join(dataDir, 'state.previous.json'), 'utf8'));
              if (previous.version !== record.version - 1) throw new Error('上一版数据不匹配');
              state = validate(previous.state);
            } else state = applyAction(record.state, body.action, day);
          } catch (error) { return send(400, { error: error.message }); }
          const appliedVersion = record.version + 1;
          await persist(state, { requestId: body.requestId, fingerprint, appliedVersion });
          return send(200, { ...snapshot(), replayed: false, appliedVersion });
        } finally { writing = false; }
      }
      if (route === '/api/state' && req.method === 'GET') return send(200, { ...snapshot(), token });
      if (route === '/api/state' && req.method === 'PUT') {
        if (req.headers.origin !== `http://${expectedHost}` || req.headers['x-workbench-token'] !== token) return send(403, { error: '本机会话验证失败，请刷新页面' });
        let input;
        try { input = await readBody(req); } catch (error) { return send(400, { error: error.message }); }
        if (writing || req.headers['if-match'] !== String(record.version)) return send(409, { error: '其他窗口已更新数据，已为你加载最新内容，请重新操作' });
        let state;
        try { state = validate(input); }
        catch (error) { return send(400, { error: error.message }); }
        writing = true;
        try {
          await persist(state);
          send(200, snapshot());
        } finally { writing = false; }
        return;
      }
      const files = { '/': 'index.html', '/app.js': 'app.js', '/model.js': 'model.js', '/style.css': 'style.css', '/favicon.svg': 'favicon.svg', '/components/select.js': 'components/select.js', '/components/select.css': 'components/select.css' };
      if (req.method !== 'GET' || !files[route]) return send(404, { error: '页面不存在' });
      const file = files[route];
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': `${types[path.extname(file)]}; charset=utf-8` });
      res.end(await readFile(path.join(root, 'public', file)));
    } catch (error) {
      console.error('Request failed:', error.message);
      if (!res.headersSent) send(500, { error: '保存或读取失败，原数据已保留，请重试' });
      else res.end();
    }
  });
  server.getSnapshot = snapshot;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createWorkbench({ dataDir: process.env.WORKBENCH_DATA_DIR });
  server.listen(Number(process.env.PORT || 4318), '127.0.0.1', () => {
    console.log(`Daylight 工作台已启动：http://127.0.0.1:${server.address().port}`);
  });
}
