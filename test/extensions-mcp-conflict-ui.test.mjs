import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mcpCompareSupported, mcpCompareView, mcpItemView, conflictChoiceList, replaceConfirm, cleanChoices, allChosen, adoptedIds, mcpCompareErrorMessage, mcpShouldRefresh, resolutionLabel, refStatusText, fieldValueText, importedMessage, REPLACE_NOTE, settleDuplicateFieldError } from '../public/extensions/mcp-conflict.js';
import { REDACTED } from '../public/extensions/conflict.js';
import { appliedMessage, undoable } from '../public/extensions/staging.js';
import { createExtensionsClient } from '../public/extensions/client.js';

const SENTINEL = 'sk-SENTINEL1234567890abcdefXYZ';
const item = (extra = {}) => ({
  id: 'missing-env-mcp', editable: true, identical: false,
  existing: { id: 'missing-env-mcp', transport: 'stdio', refs: [{ kind: 'env', key: 'E2E_MISSING_TOKEN', ref: 'E2E_MISSING_TOKEN', set: false, internal: false }] },
  incoming: { id: 'missing-env-mcp', transport: 'stdio', refs: [{ kind: 'env', key: 'E2E_OTHER_TOKEN', ref: 'E2E_OTHER_TOKEN', set: true, internal: false }] },
  fields: [{ field: 'command', existing: 'node', incoming: 'npx' }, { field: 'args', existing: ['a.js'], incoming: ['-y', 'replacement'] }, { field: 'enabled', existing: true, incoming: false }],
  refs: [{ kind: 'env', key: 'E2E_MISSING_TOKEN', status: 'removed', existingRef: 'E2E_MISSING_TOKEN' }, { kind: 'env', key: 'E2E_OTHER_TOKEN', status: 'added', incomingRef: 'E2E_OTHER_TOKEN' }], ...extra,
});

test('能力门控：只认 capabilities.extensions.mcpConflictCompare 的字面 true', () => {
  assert.equal(mcpCompareSupported({ extensions: { mcpConflictCompare: true } }), true);
  for (const value of [undefined, false, 'true', 1, null, {}]) assert.equal(mcpCompareSupported({ extensions: { mcpConflictCompare: value } }), false, String(value));
  assert.equal(mcpCompareSupported({ mcpConflictCompare: true }), false, '顶层扁平键（旧形状）不算');
  assert.equal(mcpCompareSupported(undefined), false); assert.equal(mcpCompareSupported({ extensions: [] }), false);
});

test('字段值：空 / 开关 / 连接方式 / 参数；疑似凭据整段隐藏', () => {
  assert.equal(fieldValueText('cwd', undefined), '（无）'); assert.equal(fieldValueText('args', []), '（无）');
  assert.equal(fieldValueText('enabled', false), '禁用'); assert.equal(fieldValueText('transport', 'http'), 'HTTP 服务');
  assert.equal(fieldValueText('args', ['-y', 'pkg']), '-y pkg');
  assert.equal(fieldValueText('args', ['--token=' + SENTINEL, 'x']).includes(SENTINEL), false);
  assert.equal(fieldValueText('command', 'API_KEY=' + SENTINEL), REDACTED);
});

test('对比视图：只读说明、汇总、差异表、引用状态；没有凭据值', () => {
  const html = mcpCompareView({ items: [item()], newIds: ['brand-new'] });
  assert.match(html, /data-compare-readonly/); assert.match(html, /1 个同 ID 的内容不同 · 1 个是新的，不冲突/);
  for (const field of ['command', 'args', 'enabled']) assert.match(html, new RegExp(`data-mcp-field="${field}"`));
  assert.match(html, /E2E_MISSING_TOKEN/); assert.match(html, /未设置/); assert.match(html, /已设置/);
  assert.match(html, /导入的多了/); assert.match(html, /导入的少了/);
  assert.match(html, /\bopen\b/, '第一个有差异的条目默认展开');
});
test('对比视图再脱敏：响应里漏出的疑似凭据也不进 DOM（命令 / 参数 / 目录 / 地址）', () => {
  const leaky = item({ fields: [{ field: 'command', existing: 'run', incoming: 'API_KEY=' + SENTINEL }, { field: 'args', existing: [], incoming: ['--token=' + SENTINEL] }, { field: 'url', existing: '', incoming: 'Authorization: Bearer ' + SENTINEL + 'AAAA' }] });
  const html = mcpCompareView({ items: [leaky], newIds: [] });
  assert.equal(html.includes(SENTINEL), false); assert.match(html, /已隐藏：疑似凭据/);
});
test('对比视图转义：ID / 键名 / 引用名里的标签不会成为 DOM', () => {
  const evil = item({ id: '<img src=x onerror=1>', existing: { refs: [{ kind: 'env', key: '<b>k</b>', ref: '<i>r</i>', set: true }] }, incoming: { refs: [] } });
  const html = mcpCompareView({ items: [evil], newIds: [] }) + conflictChoiceList([evil]);
  assert.doesNotMatch(html, /<img |<b>k|<i>r/); assert.match(html, /&lt;img/);
});
test('内容一致：写明提交不改任何文件；没有差异表', () => {
  const html = mcpItemView(item({ identical: true, fields: [], refs: [] }));
  assert.match(html, /data-mcp-identical/); assert.doesNotMatch(html, /<table/); assert.match(html, /内容一致/);
});
test('软件范围 editable:false：只能保留现有，并说明原因；secretKeys 只显示个数', () => {
  const locked = item({ editable: false, existing: { refs: [], secretKeys: ['env.API_KEY', 'env.OTHER'] } });
  assert.match(mcpItemView(locked), /data-mcp-not-editable/);
  assert.match(mcpItemView(locked), /2 个读不出的凭据/); assert.doesNotMatch(mcpItemView(locked), /env\.API_KEY/);
  const list = conflictChoiceList([locked]);
  assert.match(list, /value="adoptNew"[^>]*disabled/); assert.doesNotMatch(list, /value="keepExisting"[^>]*disabled/);
});
test('选择清单：每个冲突两个单选、默认都不选；对比按钮可按能力隐藏', () => {
  const list = conflictChoiceList([item(), item({ id: 'github-remote' })]);
  assert.equal((list.match(/data-mcp-resolution/g) || []).length, 4); assert.doesNotMatch(list, /checked/);
  assert.equal((list.match(/data-mcp-compare[ >]/g) || []).length, 2); assert.match(list, /用导入的替换/); assert.match(list, /保留现有/);
  assert.match(list, /role="radiogroup"/);
  assert.doesNotMatch(conflictChoiceList([item()], {}, { canCompare: false }), /data-mcp-compare[ >]/);
  assert.match(conflictChoiceList([item()], { 'missing-env-mcp': 'keepExisting' }), /value="keepExisting"[^>]*checked|checked[^>]*value="keepExisting"/);
  assert.match(conflictChoiceList([item()], {}, { source: 'form' }), /用新填写的替换/);
  assert.equal(resolutionLabel('adoptNew', 'import'), '用导入的替换');
});
test('选择规则：未选全不能提交；只认两个取值；adoptNew 才要二次确认', () => {
  const ids = ['a', 'b'];
  assert.equal(allChosen({}, ids), false); assert.equal(allChosen({ a: 'keepExisting' }, ids), false);
  assert.equal(allChosen({ a: 'keepExisting', b: 'adoptNew' }, ids), true);
  assert.equal(allChosen({ a: 'keepExisting', b: 'whatever' }, ids), false);
  assert.equal(allChosen({}, []), false, '没有冲突时这个判断不放行（调用方看 plan.conflicts）');
  assert.deepEqual(cleanChoices({ a: 'keepExisting', b: 'x', z: 'adoptNew' }, ids), { a: 'keepExisting' });
  assert.deepEqual(adoptedIds({ a: 'keepExisting', b: 'adoptNew' }, ids), ['b']); assert.deepEqual(adoptedIds({ a: 'keepExisting' }, ids), []);
});
test('替换确认：写明可撤销与已接入软件的配置不会自动更新', () => {
  const html = replaceConfirm(['a', '<x>']);
  assert.match(html, /在操作历史中点「撤销」恢复/); assert.doesNotMatch(html, /可经操作历史撤销|撤销这次操作/); assert.match(html, /不会自动更新/); assert.match(html, /&lt;x&gt;/); assert.equal(REPLACE_NOTE.includes('撤销'), true);
});
test('引用状态文字：已设置 / 未设置 / 内部凭据（文字，不只靠颜色）', () => {
  assert.deepEqual([{ set: true }, { set: false }, { internal: true, set: false }].map(refStatusText), ['已设置', '未设置', '内部凭据']);
});
test('错误文案与自动刷新：版本过期要刷新；未选择冲突；其余沿用后端 message', () => {
  assert.match(mcpCompareErrorMessage({ code: 'EXTENSIONS_VERSION_CONFLICT' }), /已刷新/); assert.equal(mcpShouldRefresh({ code: 'EXTENSIONS_VERSION_CONFLICT' }), true);
  assert.match(mcpCompareErrorMessage({ code: 'EXTENSIONS_CONFLICT' }), /每一个/); assert.equal(mcpShouldRefresh({ code: 'EXTENSIONS_CONFLICT' }), true);
  assert.equal(mcpCompareErrorMessage({ code: 'EXTENSIONS_DUPLICATE_ID', message: '已存在 x' }), '已存在 x'); assert.equal(mcpShouldRefresh({ code: 'EXTENSIONS_DUPLICATE_ID' }), false);
  assert.equal(mcpCompareErrorMessage({ message: '明文凭据被拒绝' }), '明文凭据被拒绝'); assert.match(mcpCompareErrorMessage({}), /没有改动/);
});
test('回执文案与撤销：导入 / 替换 / 保留；有 operationId 才可撤销', () => {
  assert.equal(importedMessage({ resolutions: { a: 'adoptNew', b: 'keepExisting' } }), '已导入 MCP 配置，替换 1 个，保留现有 1 个');
  assert.equal(appliedMessage({ type: 'mcp.importJson', resolutions: { a: 'adoptNew' } }, ''), '已导入 MCP 配置，替换 1 个');
  assert.equal(appliedMessage({ type: 'mcp.importJson' }, ''), '已导入 MCP 配置');
  assert.equal(appliedMessage({ type: 'mcp.save', onConflict: 'keepExisting', server: { id: 'dup', name: '新名字' } }, '新名字'), '已保留现有配置，没有改动「dup」');
  assert.equal(undoable({ type: 'mcp.save', onConflict: 'keepExisting' }, { operationId: 'op1' }), false, '保留现有没改文件，不给撤销');
  assert.equal(undoable({ type: 'mcp.save', onConflict: 'adoptNew' }, { operationId: 'op1' }), true);
  assert.match(appliedMessage({ type: 'mcp.save', onConflict: 'adoptNew' }, 'x'), /已替换/); assert.match(appliedMessage({ type: 'mcp.save' }, 'x'), /已保存/);
  assert.equal(undoable({ type: 'mcp.importJson' }, { operationId: 'op1' }), true); assert.equal(undoable({ type: 'mcp.importJson' }, {}), false);
});

test('client.mcpCompare：POST /api/extensions/mcp-compare，带令牌，原样传 json 或 server；错误带 code/status', async () => {
  const calls = [];
  const make = response => createExtensionsClient({ getToken: () => 'tok', fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: response.ok !== false, status: response.status || 200, json: async () => response.body }; } });
  const body = { readOnly: true, items: [] };
  assert.deepEqual(await make({ body }).mcpCompare({ scope: 'shared', json: '{}', expectedVersion: 'v1' }), body);
  assert.equal(calls[0].url, '/api/extensions/mcp-compare'); assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.headers['X-Workbench-Token'], 'tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { scope: 'shared', json: '{}', expectedVersion: 'v1' });
  await make({ body }).mcpCompare({ scope: 'client', clientId: 'c', server: { id: 'x' } });
  assert.deepEqual(JSON.parse(calls[1].init.body), { scope: 'client', clientId: 'c', server: { id: 'x' } });
  await assert.rejects(() => make({ ok: false, status: 409, body: { error: '配置已变化', code: 'EXTENSIONS_VERSION_CONFLICT' } }).mcpCompare({ scope: 'shared', json: '{}' }), error => error.status === 409 && error.code === 'EXTENSIONS_VERSION_CONFLICT');
});

test('页面接线：导入按钮只在 MCP 标签；对比与选择受能力门控；新建表单走 onConflict（撤销沿用 receipt 的 operation.restore）', () => {
  const page = readFileSync(new URL('../public/extensions/page.js', import.meta.url), 'utf8');
  assert.match(page, /data-import-json/); assert.match(page, /route\.tab === 'mcp' \? importButtonMarkup\(banner\)/); assert.doesNotMatch(page, /extension-category-action[^`]*data-import-json/);
  assert.match(page, /const compareOn = mcpCompareSupported\(state\.capabilities\)/); assert.match(page, /if \(compareOn && plan\.conflicts\.length\)/);
  assert.match(page, /type: 'mcp\.importJson'/); assert.match(page, /resolutions/); assert.match(page, /onConflict: choice/);
  // 选择只管一次提交：提交时取出并清空；非同 ID 冲突的失败收起面板（不沿用上次选择）
  assert.match(page, /const choice = conflictChoice; conflictChoice = null;/); assert.match(page, /if \(error\.code !== 'EXTENSIONS_DUPLICATE_ID'\) hideDuplicatePanel\(\);/); assert.match(page, /if \(problems\.length\) \{ hideDuplicatePanel\(\);/);
  assert.match(page, /client\.mcpCompare\(/); assert.match(page, /ui-button-danger" data-import-replace/); assert.match(page, /ui-button-danger" data-duplicate-replace/);
  assert.match(page, /duplicateAware && problem\.duplicate/);
});
test('mcp-conflict.js 登记在 web-assets.json；不引入新依赖', () => {
  const assets = JSON.parse(readFileSync(new URL('../core/web-assets.json', import.meta.url), 'utf8'));
  assert.equal(assets['/extensions/mcp-conflict.js'], 'extensions/mcp-conflict.js');
  const source = readFileSync(new URL('../public/extensions/mcp-conflict.js', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1]).filter(path => !path.startsWith('.')), []);
  assert.doesNotMatch(source, /innerHTML|document\./);
});
test('「导入 JSON…」在列表标题行（不进工具栏，避免挪动共享布局锚点），样式只用 token', () => {
  const css = readFileSync(new URL('../public/extensions/extensions.css', import.meta.url), 'utf8');
  assert.match(css, /\.extension-list-heading > \.extension-import-action \{ margin-left: auto;/);
  assert.doesNotMatch(css, /extension-category-action\[hidden\]/);
});

// ---- 同 ID 冲突：处理方式一选，稳定 ID 下的字段错误就清掉（不依赖后端文案的具体字句）----
const fakeMessages = (has = true) => { const calls = []; return { calls, has: name => (calls.push(['has', name]), has), clear: name => calls.push(['clear', name]) }; };

test('settleDuplicateFieldError：有字段错误 → 清掉稳定 ID 的错误并清掉「有字段需要修改」那行；没有 → 什么都不动', () => {
  const messages = fakeMessages(true), dialog = [];
  assert.equal(settleDuplicateFieldError({ messages, setDialogError: text => dialog.push(text) }), true);
  assert.deepEqual(messages.calls, [['has', 'id'], ['clear', 'id']]);
  assert.deepEqual(dialog, ['']);
  const none = fakeMessages(false), dialogNone = [];
  assert.equal(settleDuplicateFieldError({ messages: none, setDialogError: text => dialogNone.push(text) }), false);
  assert.deepEqual(none.calls, [['has', 'id']], '没有错误就不 clear');
  assert.deepEqual(dialogNone, [], '没有错误就不动对话框级提示（可能是别的失败）');
  assert.equal(settleDuplicateFieldError(), false); assert.equal(settleDuplicateFieldError({ messages: {} }), false);
});

test('settleDuplicateFieldError：只清指定字段，默认是稳定 ID；对话框提示回调可省略', () => {
  const messages = fakeMessages(true);
  assert.equal(settleDuplicateFieldError({ messages, field: 'name' }), true);
  assert.deepEqual(messages.calls, [['has', 'name'], ['clear', 'name']]);
  assert.equal(settleDuplicateFieldError({ messages: fakeMessages(true) }), true);
});

test('page.js：选处理方式（change）和打开替换确认时都会清稳定 ID 的字段错误；不在其他地方偷偷清', () => {
  const page = readFileSync(new URL('../public/extensions/page.js', import.meta.url), 'utf8');
  assert.match(page, /import \{[^}]*settleDuplicateFieldError[^}]*\} from '\.\/mcp-conflict\.js'/);
  const onchange = page.match(/panel\.onchange = event => \{[^\n]*\}/)?.[0] || '';
  assert.match(onchange, /\[data-mcp-resolution\]/); assert.match(onchange, /settleDuplicateFieldError\(\{ messages, setDialogError \}\)/, '选处理方式时清');
  const adopt = page.match(/if \(chosen === 'adoptNew'\) \{\s*settleDuplicateFieldError\(\{ messages, setDialogError \}\);\s*const box/);
  assert.ok(adopt, '打开替换确认前清');
  assert.equal((page.match(/settleDuplicateFieldError\(/g) || []).length, 2, '只有这两处调用');
});

// 替换确认（adoptNew）只是把已经拿到的计划交出去：不再 prepare。导入对话框 = 预览 1 次 + 每次改选择 1 次；确认 / 返回 / 提交都是 0 次。
// 同 ID 表单 = 第一次（409，发现冲突）+ 选了处理方式后带 onConflict 的那一次；打开确认、点「确认替换」本身只置 conflictChoice 并 requestSubmit。
const block = (source, name) => {
  const lines = source.split('\n'), start = lines.findIndex(line => new RegExp('^\\s*(async )?function ' + name + '\\(').test(line)); assert.notEqual(start, -1, name + ' 存在');
  const indent = lines[start].match(/^\s*/)[0], end = lines.findIndex((line, index) => index > start && line === indent + '}'); assert.notEqual(end, -1, name + ' 有结尾');
  return lines.slice(start, end + 1).join('\n');
};
test('page.js：导入对话框的替换确认 / 提交不再 prepare（只有 runPreview 与 refreshPlan 两处）', () => {
  const page = readFileSync(new URL('../public/extensions/page.js', import.meta.url), 'utf8'), whole = block(page, 'openImportJson');
  assert.equal((whole.match(/client\.prepare\(/g) || []).length, 2, 'openImportJson 里只有两处 prepare');
  assert.match(block(whole, 'runPreview'), /client\.prepare\(base\)/); assert.match(block(whole, 'refreshPlan'), /client\.prepare\(withChoices\(\)\)/);
  for (const name of ['confirmReplace', 'commit']) assert.doesNotMatch(block(whole, name), /\.prepare\(/, name + ' 不得再 prepare');
  assert.match(block(whole, 'commit'), /const plan = session\.plan, result = await controller\.submit\(plan\)/, '提交的就是已经确认过的那份计划');
  assert.match(whole, /\[data-import-replace\]'\)\) void commit\(\);/, '「确认替换」直接提交');
});
test('page.js：同 ID 表单的「确认替换」只置 onConflict 并重新提交，自身不 prepare', () => {
  const page = readFileSync(new URL('../public/extensions/page.js', import.meta.url), 'utf8');
  const replaceBranch = page.match(/else if \(button\.matches\('\[data-duplicate-replace\]'\)\) \{[^\n]*\}/)?.[0] || '';
  assert.ok(replaceBranch, '找到 data-duplicate-replace 分支'); assert.doesNotMatch(replaceBranch, /prepare/);
  assert.match(replaceBranch, /conflictChoice = 'adoptNew'; editor\.requestSubmit\(\);/);
  assert.doesNotMatch(block(page, 'showDuplicatePanel'), /\.prepare\(/, '读取现有服务只用 mcp-compare');
});
