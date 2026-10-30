import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { conflictOf, isOpenConflict, conflictSupported, conflictNote, conflictHint, shownText, REDACTED, summaryText, compareView, conflictPanel, conflictErrorMessage, conflictShouldRefresh, conflictBlock, resolveIntro } from '../public/extensions/conflict.js';
import { appliedMessage, undoable } from '../public/extensions/staging.js';
import { createExtensionsClient } from '../public/extensions/client.js';

const SENTINEL = 'sk-SENTINEL1234567890abcdefXYZ';
const skill = { id: 'api-design', name: 'api-design' }, client = { id: 'qoder', name: 'Qoder' };
const conflict = (extra = {}) => ({ clientId: 'qoder', state: 'conflict', target: '/Users/x/.qoder/skills/api-design', resolution: null, ...extra });

test('三态：未处理 / 已保留 / 已变化；非冲突没有状态', () => {
  assert.equal(conflictOf(conflict()), 'open');
  assert.equal(conflictOf(conflict({ resolution: 'keepLocal' })), 'kept');
  assert.equal(conflictOf(conflict({ resolutionStale: true })), 'stale');
  assert.equal(conflictOf({ state: 'managed' }), null);
  assert.equal(conflictOf(null), null);
  assert.deepEqual([conflictNote(conflict()), conflictHint(conflict({ resolution: 'keepLocal' })), conflictHint(conflict({ resolutionStale: true }))], ['同名位置冲突，未改动', '已保留', '已变化']);
});
test('「仅看问题」只算未处理与已变化的冲突', () => {
  assert.equal(isOpenConflict(conflict()), true);
  assert.equal(isOpenConflict(conflict({ resolutionStale: true })), true);
  assert.equal(isOpenConflict(conflict({ resolution: 'keepLocal' })), false);
  assert.equal(isOpenConflict({ state: 'managed' }), false);
});
test('能力：只认 capabilities.extensions.skillConflict 的字面 true，其余一律隐藏', () => {
  assert.equal(conflictSupported({ extensions: { skillConflict: true } }), true);
  for (const value of [undefined, null, {}, { extensions: {} }, { extensions: null }, { extensions: { skillConflict: false } }, { extensions: { skillConflict: 'true' } }, { extensions: { skillConflict: 1 } }, { extensions: { skillConflict: {} } }, { skillConflict: true }, { extensions: { mcpConflictCompare: true } }]) assert.equal(conflictSupported(value), false, JSON.stringify(value));
});
test('shownText：疑似凭据的行一律替换；路径缩写成 ~', () => {
  for (const line of [`API_KEY=${SENTINEL}`, `token: ${SENTINEL}`, `Authorization: Bearer ${SENTINEL}ABCDEF`, SENTINEL, '-----BEGIN RSA PRIVATE KEY-----', 'password = hunter2']) assert.equal(shownText(line), REDACTED, line);
  assert.equal(shownText('# 普通说明'), '# 普通说明');
  assert.equal(shownText('/Users/x/.qoder/skills/a', { root: '/Users/x' }), '~/.qoder/skills/a');
  assert.equal(shownText(undefined), '');
});
const base = { shared: { path: '/Users/x/.daylight/skills/api-design' }, local: { path: '/Users/x/.qoder/skills/api-design', kind: 'directory' }, compared: true, summary: { same: 1, different: 1, onlyShared: 0, onlyLocal: 1, typeDiffers: 0, unknown: 0, withheld: 1, redactedLines: 1 }, truncated: false, ignored: 0, identical: false };
const hunk = lines => [{ sharedStart: 3, localStart: 3, lines }];
test('compareView：差异行带符号与读屏文字，转义，并再次脱敏', () => {
  const html = compareView({ ...base, files: [
    { path: 'SKILL.md', status: 'different', diff: hunk([{ op: 'same', text: '# a' }, { op: 'shared', text: '<img src=x onerror=alert(1)>' }, { op: 'local', text: `key = ${SENTINEL}` }, { op: 'local', text: REDACTED }]) },
    { path: 'a.md', status: 'same' }, { path: 'b.md', status: 'onlyLocal', size: 12, kind: 'file' },
  ] }, { clientName: 'Qoder', root: '/Users/x' });
  assert.ok(!html.includes(SENTINEL), 'sentinel must not reach the DOM string');
  assert.ok(!html.includes('<img'), 'html must be escaped');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /data-op="shared"[^>]*><span class="extension-compare-sign" aria-hidden="true">−<\/span><span class="extension-visually-hidden">只在共享版本：/);
  assert.match(html, /data-op="local"[^>]*><span class="extension-compare-sign" aria-hidden="true">\+/);
  assert.match(html, /~\/\.qoder\/skills\/api-design/);
  assert.match(html, /data-compare-readonly/);
  assert.equal((html.match(/<details[^>]* open/g) || []).length, 1, 'only the first differing file is open');
  assert.match(html, /1 个文件不同 · 1 个相同 · 1 个仅软件内有 · 1 个文件内容未显示 · 1 行疑似凭据已隐藏/);
});
test('compareView：被隐藏的文件不渲染正文，即使响应里带了 diff', () => {
  for (const withheld of ['sensitive', 'binary', 'tooLarge']) {
    const html = compareView({ ...base, files: [{ path: '.env', status: 'different', withheld, sharedSize: 10, localSize: 12, diff: hunk([{ op: 'local', text: `NOTE ${SENTINEL}` }, { op: 'local', text: 'plain bogus line' }]) }] });
    assert.ok(!html.includes('plain bogus line') && !html.includes(SENTINEL), withheld);
    assert.match(html, /data-compare-withheld/);
    assert.ok(!html.includes('data-compare-hunk'));
  }
});
test('compareView：没有比较的三种原因、链接目标与完全一致', () => {
  assert.match(compareView({ ...base, compared: false, reason: 'missing', files: [] }), /已经不存在/);
  assert.match(compareView({ ...base, compared: false, reason: 'special', files: [] }), /不是普通文件或目录/);
  const link = compareView({ ...base, compared: false, reason: 'link', localLink: `/tmp/x?token=${SENTINEL}`, files: [] });
  assert.match(link, /不会跟随链接/); assert.ok(!link.includes(SENTINEL));
  assert.match(compareView({ ...base, identical: true, summary: { same: 2, different: 0 }, files: [{ path: 'SKILL.md', status: 'same' }] }), /data-compare-identical/);
  assert.match(compareView({ ...base, truncated: true, files: [] }), /data-compare-truncated-all/);
  assert.match(compareView({ ...base, files: [{ path: 'x', status: 'different', diffTruncated: true, diff: hunk([{ op: 'local', text: 'a' }]) }] }), /data-compare-truncated/);
  assert.match(compareView(null), /不能对比/);
});
test('summaryText：只显示不为 0 的项，「不同」始终显示', () => {
  assert.equal(summaryText({ same: 0, different: 0 }), '0 个文件不同');
  assert.equal(summaryText({ different: 2, typeDiffers: 1, unknown: 1 }), '2 个文件不同 · 1 个类型不同 · 1 个无法比较');
});
test('conflictPanel：三态按钮；总开关有暂存时采用 / 保留置灰；停用只挡采用；路径经 shownText', () => {
  const open = conflictPanel({ skill, binding: conflict(), client, root: '/Users/x' });
  for (const attr of ['data-conflict-compare', 'data-conflict-adopt', 'data-conflict-keep']) assert.match(open, new RegExp(attr));
  assert.ok(!open.includes('data-conflict-reopen') && !/disabled/.test(open));
  assert.match(open, /~\/\.qoder/);
  const kept = conflictPanel({ skill, binding: conflict({ resolution: 'keepLocal' }), client });
  assert.match(kept, /data-conflict-reopen/); assert.ok(!kept.includes('data-conflict-adopt') && !kept.includes('data-conflict-keep'));
  const stale = conflictPanel({ skill, binding: conflict({ resolutionStale: true }), client });
  assert.match(stale, /data-conflict-state="stale"/); assert.match(stale, /data-conflict-adopt/);
  const staged = conflictPanel({ skill, binding: conflict(), client, masterStaged: true });
  assert.match(staged, /data-conflict-adopt[^>]*disabled/); assert.match(staged, /data-conflict-keep[^>]*disabled/); assert.doesNotMatch(staged, /data-conflict-compare[^>]*disabled/); assert.match(staged, /已暂存总开关变更/);
  const off = conflictPanel({ skill, binding: conflict(), client, skillOff: true });
  assert.match(off, /data-conflict-adopt[^>]*disabled/); assert.doesNotMatch(off, /data-conflict-keep[^>]*disabled/); assert.match(off, /已停用，启用后才能采用共享版本/);
  assert.equal(conflictPanel({ skill, binding: { state: 'managed' }, client }), '');
  assert.match(conflictPanel({ skill, binding: conflict(), client, busy: true }), /data-conflict-compare[^>]*disabled/);
  assert.ok(!conflictPanel({ skill, binding: conflict({ target: `/x/token=${SENTINEL}` }), client }).includes(SENTINEL));
});
test('错误码都有人话文案；过时类错误触发刷新', () => {
  for (const code of ['EXTENSIONS_VERSION_CONFLICT', 'EXTENSIONS_NOT_CONFLICT', 'EXTENSIONS_SKILL_DISABLED', 'EXTENSIONS_ALREADY_RESOLVED', 'EXTENSIONS_NOT_RESOLVED', 'EXTENSIONS_OBJECT_MISSING']) assert.match(conflictErrorMessage({ code }, { name: 'a', clientName: 'Qoder' }), /[\u4e00-\u9fff]/, code);
  assert.equal(conflictErrorMessage({ code: 'X', message: '后端说' }), '后端说');
  assert.equal(conflictShouldRefresh({ code: 'EXTENSIONS_VERSION_CONFLICT' }), true);
  assert.equal(conflictShouldRefresh({ code: 'EXTENSIONS_SKILL_DISABLED' }), false);
});
test('conflictBlock 与 resolveIntro：采用的说明里有「撤销」和「对比」', () => {
  assert.equal(conflictBlock({}), ''); assert.match(conflictBlock({ masterStaged: true }), /暂存/);
  assert.equal(conflictBlock({ skillOff: true, resolution: 'keepLocal' }), '');
  const adopt = resolveIntro({ resolution: 'adoptShared', skillName: '<b>', clientName: 'Qoder' });
  assert.match(adopt, /撤销/); assert.match(adopt, /对比差异/); assert.ok(!adopt.includes('<b>'));
  assert.match(resolveIntro({ resolution: 'keepLocal', skillName: 'a', clientName: 'Qoder' }), /不会改动任何文件/);
  assert.match(resolveIntro({ resolution: 'reopen', skillName: 'a', clientName: 'Qoder' }), /重新作为冲突提示/);
});
test('回执文案；三个选择都可撤销（operation.restore），撤销本身不可再撤销', () => {
  assert.equal(appliedMessage({ type: 'skill.resolveConflict', resolution: 'adoptShared' }, 'api-design'), '已采用共享版本「api-design」');
  assert.equal(appliedMessage({ type: 'skill.resolveConflict', resolution: 'keepLocal' }, 'a'), '已保留软件内版本「a」');
  assert.equal(appliedMessage({ type: 'skill.resolveConflict', resolution: 'reopen' }, 'a'), '已重新标记为待处理「a」');
  assert.equal(undoable({ type: 'skill.resolveConflict' }, { operationId: 'op1' }), true);
});
test('client.compare 是 GET，带 id / clientId / expectedVersion，值被编码', async () => {
  const calls = [];
  const api = createExtensionsClient({ getToken: () => 't', fetchImpl: async (url, init) => { calls.push([String(url), init]); return { ok: true, status: 200, json: async () => ({}) }; } });
  await api.compare({ id: 'a b', clientId: 'qoder', expectedVersion: 'v&1' });
  assert.match(calls[0][0], /\/api\/extensions\/compare\?id=a\+b&clientId=qoder&expectedVersion=v%261$/);
  assert.equal(calls[0][1].method, 'GET'); assert.ok(!calls[0][1].body);
});
test('conflict.js 登记在 web-assets.json（否则打包后页面白屏）', () => {
  const assets = JSON.parse(readFileSync(new URL('../core/web-assets.json', import.meta.url), 'utf8'));
  assert.equal(assets['/extensions/conflict.js'], 'extensions/conflict.js');
  assert.match(readFileSync(new URL('../public/extensions/page.js', import.meta.url), 'utf8'), /from '\.\/conflict\.js'/);
});
