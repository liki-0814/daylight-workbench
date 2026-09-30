import http from 'node:http';
import { createQoderBridge, equalSecret, send } from './bridge.js';

const token = process.env.DAYLIGHT_QODER_TOKEN;
if (!token || !process.env.WORKBENCH_DATA_DIR) throw new Error('Missing sidecar configuration');
const bridge = await createQoderBridge({ dataDir: process.env.WORKBENCH_DATA_DIR, includeAgy: true, includeGrok: true, includeGateway: true });
const server = http.createServer((req, res) => {
  if (req.headers.host !== `127.0.0.1:${server.address().port}` || req.headers.origin || !equalSecret(req.headers['x-workbench-token'], token)) return send(res, 403, { error: '认证失败' });
  void bridge.handle(req, res);
});
server.listen(0, '127.0.0.1', () => { console.log(JSON.stringify({ port: server.address().port })); void bridge.initialize(); });
let closing = false;
async function close() {
  if (closing) return; closing = true;
  setTimeout(() => process.exit(0), 2000).unref();
  await bridge.close(); server.close(); server.closeAllConnections(); process.exit(0);
}
// The native parent owns stdin. EOF also cleans up after a crash or SIGKILL.
process.stdin.resume(); process.stdin.on('end', close);
process.on('SIGTERM', close); process.on('SIGINT', close);
