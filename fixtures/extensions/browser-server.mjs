// Disposable browser acceptance environment. Never uses the user's agents/config roots.
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../../server.mjs';
import { fixtureState } from '../../test/fixtures.mjs';
const directory = path.resolve(process.argv[2] || '');
if (!directory.startsWith(path.resolve(os.tmpdir()) + path.sep) && !directory.startsWith('/private/tmp/')) throw new Error('Fixture requires a temporary directory');
if (!path.basename(directory).startsWith('daylight-extensions-browser-')) throw new Error('Fixture requires an isolated acceptance directory');
await fs.mkdir(directory, { recursive: true });
const agentsRoot = path.join(directory, 'agents'), clientRoots = Object.fromEntries(['codex', 'qoder', 'pi'].map(id => [id, path.join(directory, id)]));
for (const [name, description] of [['review-code', '审查代码改动，检查架构边界、真实测试和回归影响。'], ['long-path-example', '用于验证较长的中文用途说明、软件接入状态与窄窗口显示。']]) {
  const skill = path.join(agentsRoot, 'skills', name); await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + description + '\n---\n\n检查来源，理解用途，再预览变更。\n');
  if (name === 'review-code') await fs.writeFile(path.join(skill, 'README.md'), '浏览器验收用说明文件。');
}
await fs.mkdir(path.join(agentsRoot, 'mcp'), { recursive: true });
const nestedSkill = path.join(agentsRoot, 'skills/review-code/modules/huichuan-code/vendor/ad-online-dev');
await fs.mkdir(nestedSkill, { recursive: true }); await fs.writeFile(path.join(nestedSkill, 'SKILL.md'), '---\nname: ad-online-dev\ndescription: 内部模块，不应单独识别\n---\n');
await fs.writeFile(path.join(agentsRoot, 'mcp', 'servers.json'), JSON.stringify({ schemaVersion: 1, servers: [{ id: 'fixture-mcp', name: '本地 MCP 测试服务', transport: 'stdio', command: process.execPath, args: [path.resolve('fixtures/extensions/mcp-server.mjs'), path.join(directory, 'mcp-requests'), 'delayed'], envRefs: {} }] }));
await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify({ version: 0, state: fixtureState() }));
await fs.mkdir(path.join(directory, 'ai'), { recursive: true });
await fs.writeFile(path.join(directory, 'ai', 'settings.json'), JSON.stringify({ backend: 'codex', codex: { model: 'acceptance', effort: '', accessMode: 'standard' }, qoder: { model: 'acceptance', effort: '', accessMode: 'standard' } }));
let lost = false;
const adapter = { discover: async () => ({ models: [{ id: 'acceptance', name: '隔离验收模型', efforts: [] }], skills: [] }), run: async ({ mcp, text, emit }) => {
  const tool = async (name, args = {}) => { const response = await fetch(mcp.env.DAYLIGHT_TOOL_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + mcp.env.DAYLIGHT_TOOL_TOKEN }, body: JSON.stringify({ name, arguments: args }) }); return response.json(); };
  if (text.includes('检测 MCP')) {
    await tool('daylight_propose_extension_changes', { summary: '显式检测本地 MCP，仅握手和读取工具清单', action: { type: 'mcp.probe', id: 'fixture-mcp' } });
    emit({ type: 'delta', text: '检测已确认，请返回扩展详情核对实际结果。' }); return;
  }
  const state = await tool('daylight_get_extensions'), skill = state.skills.find(skill => skill.name === 'review-code'), detail = await tool('daylight_get_extension', { id: skill.id });
  const suffix = text.includes('响应丢失') ? '响应丢失演练' : '已通过 AI 审阅';
  const result = await tool('daylight_propose_extension_changes', { summary: '修改 review-code 的说明内容', action: { type: 'skill.update', id: skill.id, content: detail.content + '\n' + suffix + '\n' } });
  emit({ type: 'delta', text: result.ok ? '已按回执保存主来源。客户端加载需要刷新后另行核对。' : '草稿已取消，来源保持原内容。' });
} };
const server = await createWorkbench({ dataDir: directory, aiAdapters: { codex: adapter, qoder: adapter }, extensionsOptions: { agentsRoot, clientRoots, fault(point, index, record) { if (point === 'afterReceipt' && record.action.content?.includes('响应丢失演练') && !lost) { lost = true; throw new Error('acceptance response loss'); } } } });
server.listen(0, '127.0.0.1', async () => { const url = 'http://127.0.0.1:' + server.address().port; await fs.writeFile(path.join(directory, 'url'), url); console.log(url); });
process.on('SIGTERM', async () => { await server.closeProxy(); server.close(); server.closeAllConnections(); });
