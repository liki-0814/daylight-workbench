// Only CLI-specific facts live here. Discovery, cataloguing and writes share services.
export const clientAdapters = [
  { id: 'codex', name: 'Codex', commands: ['codex'], directory: '.codex', rootEnv: 'CODEX_HOME', skillsDirectory: 'skills', mcp: { file: 'config.toml', format: 'toml', section: 'mcp_servers', toggle: 'enabled', env: 'env_vars', headers: 'env_http_headers' }, evidence: 'https://developers.openai.com/codex/config-reference/' },
  { id: 'qoder', name: 'Qoder', commands: ['qodercli', 'qoder'], directory: '.qoder', rootEnv: 'QODER_CONFIG_DIR', skillsDirectory: 'skills', mcp: { file: 'settings.json', format: 'json', section: 'mcpServers', toggle: 'excluded', env: 'env', headers: 'headers' }, evidence: 'https://docs.qoder.com/cli/mcp-reference' },
  { id: 'pi', name: 'Pi', commands: ['pi'], directory: '.pi', rootEnv: 'PI_CODING_AGENT_DIR', skillsDirectory: 'agent/skills', evidence: 'https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent' },
  { id: 'grok', name: 'Grok', commands: ['grok'], directory: '.grok', skillsDirectory: 'skills', mcp: { file: 'config.toml', format: 'toml', section: 'mcp_servers', toggle: 'enabled', disabledList: 'disabled_mcp_servers', env: 'env', headers: 'headers', interpolation: true }, evidence: 'https://docs.x.ai/build/features/mcp-servers' },
  { id: 'claude', name: 'Claude Code', commands: ['claude'], directory: '.claude', rootEnv: 'CLAUDE_CONFIG_DIR', skillsDirectory: 'skills', mcp: { file: '../.claude.json', format: 'json', section: 'mcpServers', env: 'env', headers: 'headers', interpolation: true }, evidence: 'https://code.claude.com/docs/en/mcp' },
];
export function adapterFor(command, explicit) {
  return clientAdapters.find(adapter => explicit ? adapter.id === explicit : adapter.commands.includes(command.split('/').at(-1)));
}
