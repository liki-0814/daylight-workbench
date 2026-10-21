import { definitions } from '../tools/definitions.mjs';

// Loaded explicitly by Pi. No user configuration or global MCP files are edited.
export default function daylight(pi) {
  for (const definition of definitions) pi.registerTool({
    name: definition.name, label: definition.name, description: definition.description, parameters: definition.inputSchema,
    async execute(_id, input, signal) {
      const response = await fetch(process.env.DAYLIGHT_TOOL_URL, { method: 'POST', headers: { Authorization: `Bearer ${process.env.DAYLIGHT_TOOL_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: definition.name, arguments: input }), signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Daylight 工具调用失败');
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
    },
  });
  pi.on('tool_call', async (event, context) => {
    if (definitions.some(item => item.name === event.toolName) || process.env.DAYLIGHT_PI_ACCESS_MODE === 'full') return;
    const allowed = await context.ui.confirm(`Pi 请求使用 ${event.toolName}`, JSON.stringify(event.input, null, 2));
    if (!allowed) return { block: true, reason: '用户拒绝了本次操作' };
  });
}
