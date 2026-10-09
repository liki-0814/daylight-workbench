import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { writeFile, appendFile } from 'node:fs/promises';

const [log, mode = 'normal'] = process.argv.slice(2);
await writeFile(log + '.pid', String(process.pid));
const server = new Server({ name: 'extension-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async request => {
  await appendFile(log, 'tools/list\n');
  if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 30000));
  if (mode === 'delayed') await new Promise(resolve => setTimeout(resolve, 1000));
  return request.params?.cursor ? { tools: [{ name: 'second', inputSchema: { type: 'object' } }] } : { tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: 'page-two' };
});
server.setRequestHandler(CallToolRequestSchema, async () => { await appendFile(log, 'FORBIDDEN tools/call\n'); return { content: [] }; });
process.on('SIGTERM', () => process.exit(0));
await server.connect(new StdioServerTransport());
