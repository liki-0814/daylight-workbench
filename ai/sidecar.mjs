import http from 'node:http';
import { createAIService } from './service.mjs';
import { equalSecret, send } from '../proxy/service.js';
const token = process.env.DAYLIGHT_AI_TOKEN;
if (!token || !process.env.DAYLIGHT_WORKBENCH_URL || !process.env.WORKBENCH_DATA_DIR) throw new Error('Missing AI runtime configuration');
const ai = await createAIService({ dataDir: process.env.WORKBENCH_DATA_DIR, endpoint: process.env.DAYLIGHT_WORKBENCH_URL });
const server = http.createServer((req, res) => {
  if (req.headers.host !== `127.0.0.1:${server.address().port}` || req.headers.origin || !equalSecret(req.headers['x-workbench-token'], token)) return send(res, 403, { error: '认证失败' });
  void ai.handle(req, res);
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
let closing = false;
async function close() { if (closing) return; closing = true; await ai.close(); server.close(); server.closeAllConnections(); setTimeout(() => process.exit(0), 2500).unref(); }
process.stdin.resume(); process.stdin.on('end', close); process.on('SIGTERM', close); process.on('SIGINT', close);
