// 0.7 设置页 B 版 + 扩展管理 A 版 + 已接入新配色：纯函数 / 标记 / 令牌的单测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connectionSummary, clientRowMarkup, settingsSections } from '../public/components/settings-page.js';
import { groupMarkup, mcpGroups } from '../public/extensions/list.js';
import { chip } from '../public/components/chip.js';
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('connection summary: connected = selected; discovered = installed but not selected', () => {
  assert.deepEqual(connectionSummary([{ selected: true, installed: true }, { selected: true, installed: false }, { selected: false, installed: true }, { selected: false, installed: false }]), { total: 4, connected: 2, discovered: 1 });
  assert.deepEqual(connectionSummary(undefined), { total: 0, connected: 0, discovered: 0 });
});
test('rail rows: 已接入 / 未找到命令 / 未接入 each carry text and a data-connection hook; names are escaped', () => {
  assert.match(clientRowMarkup({ id: 'a', name: 'A<b>', selected: true, installed: true }), /data-connection="connected"[\s\S]*ui-chip-connected[\s\S]*已接入/);
  assert.match(clientRowMarkup({ id: 'a', name: 'A', selected: true, installed: false }), /ui-chip-update[\s\S]*未找到命令/);
  const idle = clientRowMarkup({ id: 'a', name: 'A<b>', selected: false, installed: true });
  assert.match(idle, /data-connection="idle"[\s\S]*ui-chip-idle[\s\S]*未接入/); assert.doesNotMatch(idle, /<b>/);
});
test('settings sections: six groups in design order (the 全部 pill is extra)', () => {
  assert.deepEqual(settingsSections.map(section => section.id), ['extensions', 'proxy', 'ai', 'focus', 'shortcuts', 'update']);
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
  for (const file of ['public/cli-config.css', 'public/components/chip.css', 'public/extensions/extensions.css', 'public/settings.css']) assert.doesNotMatch(read(file), /#f0f4ed|#207a36/i, file);
});
