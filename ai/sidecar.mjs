import http from 'node:http';
import { equalSecret, send } from '../proxy/service.js';
const token = process.env.DAYLIGHT_AI_TOKEN;
if (!token || !process.env.DAYLIGHT_WORKBENCH_URL || !process.env.WORKBENCH_DATA_DIR) throw new Error('Missing AI runtime configuration');
let aiPromise, extensionsPromise;
const getAI = () => aiPromise ||= import('./service.mjs').then(({ createAIService }) => createAIService({ dataDir: process.env.WORKBENCH_DATA_DIR, endpoint: process.env.DAYLIGHT_WORKBENCH_URL }));
const getExtensions = () => extensionsPromise ||= import('../extensions/service.mjs').then(({ createExtensionsService }) => createExtensionsService({ agentsRoot: process.env.WORKBENCH_AGENTS_ROOT, ...(process.env.WORKBENCH_EXTENSION_CLIENT_ROOTS ? { clientRoots: JSON.parse(process.env.WORKBENCH_EXTENSION_CLIENT_ROOTS) } : {}) }));
const server = http.createServer(async (req, res) => {
  if (req.headers.host !== `127.0.0.1:${server.address().port}` || req.headers.origin || !equalSecret(req.headers['x-workbench-token'], token)) return send(res, 403, { error: '认证失败' });
  try { await (await (req.url.startsWith('/api/extensions/') ? getExtensions() : getAI())).handle(req, res); }
  catch { send(res, 503, { error: req.url.startsWith('/api/extensions/') ? '扩展服务暂不可用，请重试' : 'AI 服务暂不可用，请检查运行环境' }); }
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
let closing = false;
async function close() { if (closing) return; closing = true; await aiPromise?.then(ai => ai.close()).catch(() => {}); await extensionsPromise?.then(service => service.close()).catch(() => {}); server.close(); server.closeAllConnections(); setTimeout(() => process.exit(0), 2500).unref(); }
process.stdin.resume(); process.stdin.on('end', close); process.on('SIGTERM', close); process.on('SIGINT', close);
