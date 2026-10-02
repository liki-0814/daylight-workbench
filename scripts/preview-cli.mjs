// Real API interaction smoke, isolated from installed App and user Pi files.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server.mjs';
import { writeJson } from '../proxy/shared/store.js';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-cli-preview-'));
const piDir = path.join(dataDir, 'pi');
await writeJson(path.join(piDir, 'models.json'), { providers: { daylight: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:4319/v1', apiKey: 'preview-old', models: [{ id: 'kimi-k2.5', name: 'Kimi K2.5' }] } } });
await writeJson(path.join(piDir, 'settings.json'), { defaultProvider: 'daylight', defaultModel: 'kimi-k2.5', defaultThinkingLevel: 'high' });
const provider = (id, models) => ({ cache: {}, listModels: async () => models.map(m => ({ enabled: true, provider: id, ...m })) });
const server = await createWorkbench({ dataDir, proxyOptions: {
  provider: provider('qoder', []), includeGateway: false, includeAgy: false, includeGrok: false,
  codexProvider: provider('codex', [{ id: 'gpt-5.4', displayName: 'GPT-5.4', contextWindow: 1050000, isReasoning: true }]),
  kimiProvider: provider('kimi', [{ id: 'kimi-k2.5', displayName: 'Kimi K2.5', contextWindow: 256000, isReasoning: true }, { id: 'kimi-for-coding', displayName: 'Kimi for Coding', contextWindow: 256000 }]),
  grokProvider: provider('grok', [{ id: 'grok-4.7-build-fast', displayName: 'Grok 4.7 Fast', contextWindow: 200000, isReasoning: true }]),
  piOptions: { piDir, getInfo: async () => ({ installed: true, version: '隔离测试' }) },
} });
server.listen(Number(process.env.PORT || 4321), '127.0.0.1', () => console.log(`Isolated CLI preview: http://127.0.0.1:${server.address().port}/#cli\nTemporary Pi: ${piDir}`));
async function close() { await server.closeProxy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); process.exit(0); }
process.on('SIGTERM', close); process.on('SIGINT', close);
