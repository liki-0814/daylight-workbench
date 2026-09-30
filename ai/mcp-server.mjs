// Private stdio MCP endpoint, scoped to one Daylight run. No standalone credentials.
import { definitions } from './tools/definitions.mjs';
let buffer = '';
const reply = value => process.stdout.write(JSON.stringify(value) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); void handle(line); }
});
async function handle(line) {
  let r;
  try {
    r = JSON.parse(line); if (r.id === undefined) return;
    let result;
    if (r.method === 'initialize') result = { protocolVersion: r.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'daylight', version: '1.0' } };
    else if (r.method === 'ping') result = {};
    else if (r.method === 'tools/list') result = { tools: definitions };
    else if (r.method === 'tools/call') {
      const res = await fetch(process.env.DAYLIGHT_TOOL_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DAYLIGHT_TOOL_TOKEN}` }, body: JSON.stringify(r.params) });
      const data = await res.json(); result = { content: [{ type: 'text', text: JSON.stringify(data) }], isError: !res.ok || data.ok === false };
    } else { reply({ jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'Unsupported method' } }); return; }
    reply({ jsonrpc: '2.0', id: r.id, result });
  } catch (e) { if (r?.id !== undefined) reply({ jsonrpc: '2.0', id: r.id, error: { code: -32603, message: e.message } }); }
}
