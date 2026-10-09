import path from 'node:path';
import os from 'node:os';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { executableCandidates } from '../core/local-executables.mjs';

// This registry is the only place defining external integration paths/capabilities.
export function clientRegistry({ clientRoots = {}, environment = process.env, home = os.homedir() } = {}) {
  const codexRoot = clientRoots.codex || (environment.CODEX_HOME?.trim() ? path.resolve(environment.CODEX_HOME) : path.join(home, '.codex'));
  return [
    { id: 'codex', name: 'Codex', command: 'codex', root: codexRoot, skillMode: 'nativeRoot', mcpMode: 'manual', format: 'toml', note: `主目录 ${codexRoot === path.join(home, '.codex') ? '~/.codex' : codexRoot}；同时支持共享 Skills 来源，无需新增链接。MCP 在主目录 config.toml 中配置。`, refresh: '新建或刷新客户端会话后核对发现结果。' },
    { id: 'qoder', name: 'Qoder', command: 'qodercli', root: clientRoots.qoder || path.join(home, '.qoder'), skillMode: 'symlink', mcpMode: 'manual', format: 'json', note: '按 Skill 建立链接；MCP 需在客户端 settings.json 中接入生成配置。', refresh: '刷新 Skills 或新建会话后核对发现结果。' },
    { id: 'pi', name: 'Pi', command: 'pi', root: clientRoots.pi || path.join(home, '.pi', 'agent'), skillMode: 'nativeRoot', mcpMode: 'unsupported', note: '支持共享 Skills 目录的 Pi 版本无需链接；当前未提供已验证的原生 MCP 接入。', refresh: '支持共享目录的版本通过 /reload 或新会话核对。' },
  ].map(client => ({ ...client, skillsRoot: path.join(client.root, 'skills'), async detect() {
    for (const executable of executableCandidates(client.command, { environment, home })) {
      try { await access(executable, constants.X_OK); return { installed: true, executable, version: '未执行版本检测', runtimeVerified: false }; } catch {}
    }
    return { installed: false, executable: null, version: null, runtimeVerified: false };
  } }));
}
