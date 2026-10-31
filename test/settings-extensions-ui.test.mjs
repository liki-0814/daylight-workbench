// 0.7 设置页 B 版 + 扩展管理 A 版 + 已接入新配色：纯函数 / 标记 / 令牌的单测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connectionSummary, clientsSummary, settingsSections } from '../public/pages/settings.js';
import { groupMarkup, mcpGroups } from '../public/extensions/list.js';
import { chip } from '../public/components/chip.js';
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('connection summary: connected = selected; discovered = installed but not selected', () => {
  assert.deepEqual(connectionSummary([{ selected: true, installed: true }, { selected: true, installed: false }, { selected: false, installed: true }, { selected: false, installed: false }]), { total: 4, connected: 2, discovered: 1 });
  assert.deepEqual(connectionSummary(undefined), { total: 0, connected: 0, discovered: 0 });
});
test('clients summary: found = installed; missing lists the names without a command', () => {
  assert.deepEqual(clientsSummary([{ name: 'Codex', installed: false }, { name: 'Qoder', installed: false }, { id: 'pi', installed: false }, { name: 'Claude', installed: true }]), { total: 4, found: 1, missing: ['Codex', 'Qoder', 'pi'] });
  assert.deepEqual(clientsSummary(undefined), { total: 0, found: 0, missing: [] });
});
test('settings sections: seven nav items in design order', () => {
  assert.deepEqual(settingsSections.map(section => section.label), ['通用', '本地扩展', '反向代理', 'AI 对话', '专注', '快捷键', '应用更新']);
});
test('extension groups: 已启用 first, 未启用 second; the group head is aria-hidden but the group is labelled with its count', () => {
  assert.deepEqual(mcpGroups.map(group => group.key), ['enabled', 'disabled']);
  const html = groupMarkup({ key: 'disabled', label: '未启用', count: 2, rows: '<div class="extension-row"></div>' });
  assert.match(html, /role="rowgroup" aria-label="未启用 2 项" data-extension-group="disabled"/); assert.match(html, /extension-group-head" aria-hidden="true"/);
});
test('new chip tones: connected / idle / update / failure / off render a dot with text', () => {
  for (const tone of ['connected', 'idle', 'update', 'failure', 'off']) assert.match(chip({ label: '标签', tone, dot: true }), new RegExp(`ui-chip-${tone}[\\s\\S]*ui-chip-dot[\\s\\S]*标签`), tone);
});
test('colour tokens: 已接入 = #1F7A35 dot, #3A3A3C text, #F2F2F4 chip, #E5E5EA line, white rows; the old green row backgrounds are gone', () => {
  const tokens = read('public/design-system.css');
  for (const [name, value] of [['connected-dot', '#1f7a35'], ['connected-text', '#3a3a3c'], ['connected-chip', '#f2f2f4'], ['connected-line', '#e5e5ea'], ['row-bg', '#fff'], ['row-hover', '#f5f5f7'], ['idle-ring', '#8e8e93'], ['idle-text', '#636366'], ['update-dot', '#b25e00'], ['update-text', '#8a4b00']]) assert.match(tokens, new RegExp(`--${name}:\\s*${value}`, 'i'), name);
  for (const file of ['public/cli-config.css', 'public/components/chip.css', 'public/extensions/extensions.css']) assert.doesNotMatch(read(file), /#f0f4ed|#207a36/i, file);
});
