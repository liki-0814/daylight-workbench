import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createFolderPicker, folderPickerAvailable, makeRequestId, FOLDER_PICKED_EVENT, FOLDER_REQUEST_ID_PATTERN, FOLDER_PICK_TIMEOUT_MS, FOLDER_PICK_MESSAGES } from '../public/extensions/folder-picker.js';
import { validateSourcePath, importPhaseView, importFailure, importHasConflict, IMPORT_PHASES } from '../public/extensions/skill-import.js';
import { addMenuMarkup, addMenuItems, nextMenuIndex } from '../public/extensions/add-menu.js';
import { appliedMessage } from '../public/extensions/staging.js';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

// ---- 假窗口：messageHandlers.pickFolder + 可派发 daylight-folder-picked ----
function fakeWindow({ bridge = true, throws = false } = {}) {
  const target = new EventTarget(), posted = [];
  const win = { addEventListener: (...args) => target.addEventListener(...args), removeEventListener: (...args) => target.removeEventListener(...args) };
  if (bridge) win.webkit = { messageHandlers: { pickFolder: { postMessage(payload) { if (throws) throw new Error('boom'); posted.push(payload); } } } };
  const reply = detail => target.dispatchEvent(new CustomEvent(FOLDER_PICKED_EVENT, { detail }));
  return { win, posted, reply };
}
// 可手动触发的定时器
function fakeTimers() { const timers = new Map(); let id = 0; return { setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimer: key => timers.delete(key), fire: () => { for (const [key, { fn }] of [...timers]) { timers.delete(key); fn(); } }, count: () => timers.size, last: () => [...timers.values()].at(-1) }; }
const ID = 'pick-test-0001';

test('桥接检测：只有 messageHandlers.pickFolder.postMessage 存在才可用', () => {
  assert.equal(folderPickerAvailable(fakeWindow().win), true);
  assert.equal(folderPickerAvailable(fakeWindow({ bridge: false }).win), false);
  assert.equal(folderPickerAvailable({}), false);
  assert.equal(folderPickerAvailable({ webkit: {} }), false);
  assert.equal(folderPickerAvailable({ webkit: { messageHandlers: {} } }), false);
  assert.equal(folderPickerAvailable({ webkit: { messageHandlers: { pickFolder: {} } } }), false);
  assert.equal(folderPickerAvailable(undefined), false);
});

test('请求：只带 requestId，requestId 符合 ^[a-zA-Z0-9_-]{8,100}$', async () => {
  const { win, posted, reply } = fakeWindow(), timers = fakeTimers();
  const picker = createFolderPicker({ win, ...timers });
  const result = picker.pick();
  assert.equal(posted.length, 1); assert.deepEqual(Object.keys(posted[0]), ['requestId']); assert.match(posted[0].requestId, FOLDER_REQUEST_ID_PATTERN);
  reply({ requestId: posted[0].requestId, ok: true, path: '/Users/me/skill' });
  assert.deepEqual(await result, { status: 'picked', path: '/Users/me/skill' });
  for (let index = 0; index < 50; index++) assert.match(makeRequestId(), FOLDER_REQUEST_ID_PATTERN);
  assert.match(makeRequestId({}), FOLDER_REQUEST_ID_PATTERN);    // 没有 crypto.randomUUID 也合法
});

test('成功：返回 path；监听器与定时器都清掉', async () => {
  const { win, reply } = fakeWindow(), timers = fakeTimers(); let removed = 0;
  const wrapped = { ...win, removeEventListener: (...args) => { removed++; win.removeEventListener(...args); } };
  const picker = createFolderPicker({ win: wrapped, makeId: () => ID, ...timers });
  const result = picker.pick(); assert.equal(picker.pending, true); assert.equal(timers.count(), 1);
  reply({ requestId: ID, ok: true, path: '/a/b' });
  assert.equal((await result).status, 'picked'); assert.equal(picker.pending, false); assert.equal(timers.count(), 0); assert.equal(removed, 1);
});

test('取消：不是错误，没有 message', async () => {
  const { win, reply } = fakeWindow(), picker = createFolderPicker({ win, makeId: () => ID, ...fakeTimers() });
  const result = picker.pick(); reply({ requestId: ID, ok: false, cancelled: true });
  assert.deepEqual(await result, { status: 'cancelled' });
});

test('出错：显示固定的、看得懂的提示，不回显原生端的 error 原文', async () => {
  const { win, reply } = fakeWindow(), picker = createFolderPicker({ win, makeId: () => ID, ...fakeTimers() });
  const result = picker.pick(); reply({ requestId: ID, ok: false, error: 'NSError domain=… code=-1' });
  const value = await result; assert.equal(value.status, 'error'); assert.equal(value.message, FOLDER_PICK_MESSAGES.error); assert.doesNotMatch(value.message, /NSError/); assert.match(value.message, /输入.*路径/);
});

test('出错：postMessage 抛异常也按出错处理（不 reject，不残留）', async () => {
  const { win } = fakeWindow({ throws: true }), timers = fakeTimers(), picker = createFolderPicker({ win, makeId: () => ID, ...timers });
  const value = await picker.pick(); assert.equal(value.status, 'error'); assert.equal(picker.pending, false); assert.equal(timers.count(), 0);
});

test('出错：ok:true 但 path 缺失或为空 → 当作无法使用的结果', async () => {
  for (const detail of [{ requestId: ID, ok: true }, { requestId: ID, ok: true, path: '   ' }, { requestId: ID, ok: true, path: 5 }]) {
    const { win, reply } = fakeWindow(), picker = createFolderPicker({ win, makeId: () => ID, ...fakeTimers() });
    const result = picker.pick(); reply(detail); const value = await result;
    assert.equal(value.status, 'error'); assert.equal(value.message, FOLDER_PICK_MESSAGES.invalid);
  }
});

test('超时：至少 5 分钟；超时后恢复可再点，提示可重试或手输', async () => {
  assert.ok(FOLDER_PICK_TIMEOUT_MS >= 5 * 60 * 1000);
  const { win, posted, reply } = fakeWindow(), timers = fakeTimers(); let ids = 0;
  const picker = createFolderPicker({ win, makeId: () => `pick-timeout-${++ids}`, ...timers });
  const result = picker.pick(); assert.ok(timers.last().ms >= 5 * 60 * 1000);
  timers.fire(); const value = await result;
  assert.equal(value.status, 'timeout'); assert.match(value.message, /再试一次/); assert.match(value.message, /输入/); assert.equal(picker.pending, false);
  reply({ requestId: 'pick-timeout-1', ok: true, path: '/late' });            // 超时之后迟到的应答：监听器已清，不再有任何效果
  const again = picker.pick(); assert.equal(posted.length, 2); reply({ requestId: 'pick-timeout-2', ok: true, path: '/second' });
  assert.deepEqual(await again, { status: 'picked', path: '/second' });
});

test('requestId 不匹配的应答一律忽略，继续等自己的', async () => {
  const { win, reply } = fakeWindow(), timers = fakeTimers(), picker = createFolderPicker({ win, makeId: () => ID, ...timers });
  const result = picker.pick(); let settled = false; result.then(() => { settled = true; });
  reply({ requestId: 'someone-else-1', ok: true, path: '/wrong' }); reply({ ok: true, path: '/no-id' }); reply(null); reply('x'); reply({ requestId: ID.toUpperCase(), ok: true, path: '/case' });
  await Promise.resolve(); await Promise.resolve(); assert.equal(settled, false); assert.equal(picker.pending, true);
  reply({ requestId: ID, ok: true, path: '/right' }); assert.deepEqual(await result, { status: 'picked', path: '/right' });
});

test('重复点击：进行中不再发请求（busy），只发过一次', async () => {
  const { win, posted, reply } = fakeWindow(), picker = createFolderPicker({ win, makeId: () => ID, ...fakeTimers() });
  const first = picker.pick(), second = await picker.pick(), third = await picker.pick();
  assert.deepEqual(second, { status: 'busy' }); assert.deepEqual(third, { status: 'busy' }); assert.equal(posted.length, 1);
  reply({ requestId: ID, ok: true, path: '/x' }); await first;
  const next = picker.pick(); assert.equal(posted.length, 2); reply({ requestId: ID, ok: false, cancelled: true }); await next;   // 结束后又可以发
});

test('没有桥接：unavailable，不发任何东西', async () => {
  const { win } = fakeWindow({ bridge: false }), picker = createFolderPicker({ win, ...fakeTimers() });
  assert.deepEqual(await picker.pick(), { status: 'unavailable' });
});

// ---- 路径校验 ----
test('validateSourcePath：去首尾空格、末尾斜杠；通过的是绝对路径', () => {
  assert.deepEqual(validateSourcePath('  /Users/me/skills/review-code  '), { ok: true, path: '/Users/me/skills/review-code' });
  assert.deepEqual(validateSourcePath('/Users/me/skills/review-code///'), { ok: true, path: '/Users/me/skills/review-code' });
  assert.deepEqual(validateSourcePath('/Users/me/my ~skill/文件夹'), { ok: true, path: '/Users/me/my ~skill/文件夹' });   // ~ 只在开头才拒绝
  assert.deepEqual(validateSourcePath('/a/.hidden-ok/b'), { ok: true, path: '/a/.hidden-ok/b' });
});
test('validateSourcePath：空、~、相对路径、. / .. 段、换行、根目录、过长都拒绝，提示看得懂', () => {
  const bad = { empty: '', spaces: '   ', undef: undefined, tilde: '~/skills/x', tildeOnly: '~', tildeUser: '~me/x', relative: 'skills/x', dotRel: './x', dotdotRel: '../x', url: 'file:///Users/me/x', dotSeg: '/Users/me/./x', dotdotSeg: '/Users/me/../x', newline: '/Users/me/x\n/etc', nul: '/Users/\0me', root: '/', roots: '//', long: '/' + 'a'.repeat(4097) };
  for (const [name, value] of Object.entries(bad)) {
    const result = validateSourcePath(value);
    assert.equal(result.ok, false, name); assert.ok(result.message.length > 8, name); assert.doesNotMatch(result.message, /EXTENSIONS_|undefined|\[object/, name);
  }
  assert.match(validateSourcePath('').message, /完整路径/); assert.match(validateSourcePath('~/x').message, /~/); assert.match(validateSourcePath('x/y').message, /以 \//);
  assert.match(validateSourcePath('/a/../b').message, /\.\./);
});

// ---- 状态 ----
test('importPhaseView：导入中 / 预览中 / 选择中都忙；冲突不能导入；只有 ready 能导入；选择按钮需要桥接且不忙', () => {
  assert.deepEqual(IMPORT_PHASES, ['idle', 'picking', 'previewing', 'ready', 'conflict', 'importing', 'failed']);
  for (const phase of ['picking', 'previewing', 'importing']) { const view = importPhaseView(phase, { pickerAvailable: true }); assert.equal(view.busy, true, phase); assert.equal(view.canPick, false, phase); assert.equal(view.canPreview, false, phase); assert.equal(view.canApply, false, phase); assert.ok(view.status, phase); }
  assert.equal(importPhaseView('ready').canApply, true);
  for (const phase of ['idle', 'conflict', 'failed', 'picking', 'previewing', 'importing']) assert.equal(importPhaseView(phase).canApply, false, phase);
  assert.equal(importPhaseView('idle', { pickerAvailable: true }).canPick, true); assert.equal(importPhaseView('idle', { pickerAvailable: false }).canPick, false); assert.equal(importPhaseView('conflict', { pickerAvailable: true }).canPick, true);
  assert.equal(importPhaseView('importing').status, '正在导入…');
});
test('importFailure：路径问题挂到路径框，其余放对话框；版本变化提示重新预览', () => {
  assert.deepEqual(importFailure({ field: 'sourcePath', code: 'EXTENSIONS_IMPORT_NO_SKILL', message: '该文件夹顶层没有 SKILL.md' }), { field: 'sourcePath', message: '该文件夹顶层没有 SKILL.md' });
  assert.equal(importFailure({ message: '写入失败' }).field, null);
  assert.match(importFailure({ code: 'EXTENSIONS_VERSION_CONFLICT' }).message, /重新预览/);
  assert.match(importFailure(new Error('')).message, /没有改动/); assert.match(importFailure(null).message, /没有改动/);
});
test('importHasConflict：只看 plan.conflicts 是否为非空数组（不覆盖）', () => {
  assert.equal(importHasConflict({ conflicts: ['已存在同名 Skill'] }), true);
  for (const plan of [{ conflicts: [] }, {}, null, { conflicts: 'x' }, { conflicts: 1 }]) assert.equal(importHasConflict(plan), false);
});
test('回执文案：skill.import', () => { assert.equal(appliedMessage({ type: 'skill.import' }, 'review-code'), '已导入 Skill「review-code」'); assert.equal(appliedMessage({ type: 'skill.import' }), '已导入 Skill'); });

// ---- 菜单 ----
test('「添加 ▾」菜单：Skills = 新建 + 从文件夹导入；MCP = 新建 + 导入 JSON；接入软件没有菜单', () => {
  assert.deepEqual(addMenuItems('skills').map(item => item.label), ['新建 Skill…', '从文件夹导入…']);
  assert.deepEqual(addMenuItems('mcp').map(item => item.label), ['新建 MCP 服务…', '导入 JSON…']);
  assert.equal(addMenuItems('clients'), null); assert.equal(addMenuMarkup('clients'), '');
  const markup = addMenuMarkup('mcp');
  assert.match(markup, /aria-haspopup="menu"/); assert.match(markup, /aria-expanded="false"/); assert.match(markup, /role="menu"/); assert.equal((markup.match(/role="menuitem"/g) || []).length, 2); assert.match(markup, /data-import-json/); assert.match(markup, /data-create/);
  assert.match(markup, /<span aria-hidden="true">▾<\/span>/);       // 箭头不进可访问名称：名称是「添加」
  assert.match(markup, /data-add-menu-list hidden/);
  assert.match(addMenuMarkup('skills', { disabled: true, reason: '原因 <b>' }), /disabled title="原因 &lt;b&gt;"/);
  assert.doesNotMatch(addMenuMarkup('skills'), /disabled/);
});
test('菜单键盘：↑↓ 循环，Home/End 跳端点', () => {
  assert.equal(nextMenuIndex('ArrowDown', -1, 3), 0); assert.equal(nextMenuIndex('ArrowDown', 2, 3), 0); assert.equal(nextMenuIndex('ArrowUp', 0, 3), 2); assert.equal(nextMenuIndex('ArrowUp', -1, 3), 2);
  assert.equal(nextMenuIndex('Home', 2, 3), 0); assert.equal(nextMenuIndex('End', 0, 3), 2); assert.equal(nextMenuIndex('ArrowDown', 0, 0), -1); assert.equal(nextMenuIndex('x', 1, 3), 1);
});

// ---- 接线 / 登记 / 约束 ----
test('页面接线：菜单项接 openImportSkill；skill.import 只传 sourcePath；一次一个文件夹；预览与导入走 prepare / submit', () => {
  const page = read('public/extensions/page.js');
  assert.match(page, /button\.hasAttribute\('data-import-skill'\)\) openImportSkill\(\)/); assert.match(page, /folderPickerAvailable\(\)/); assert.match(page, /\{ type: 'skill\.import', scope: 'shared', sourcePath: checked\.path \}/);
  assert.match(page, /client\.prepare\(base\)/); assert.match(page, /controller\.submit\(plan\)/); assert.doesNotMatch(page, /webkit\.messageHandlers/);   // 页面不直接碰桥接
  assert.match(page, /data-pick-folder/); assert.match(page, /aria-describedby="skill-import-conflict"/);
  assert.match(page, /addMenu = mountAddMenu\(/); assert.match(page, /data-create-slot/);
  assert.doesNotMatch(page, /multiple|webkitdirectory|\.sourcePaths|sourcePath: \[/);   // 不做多选 / 父文件夹
});
test('新文件登记在 web-assets.json；新模块不引入第三方依赖；纯函数模块没有 DOM', () => {
  const assets = JSON.parse(read('core/web-assets.json'));
  for (const name of ['add-menu', 'folder-picker', 'skill-import']) {
    assert.equal(assets[`/extensions/${name}.js`], `extensions/${name}.js`, name);
    const source = read(`public/extensions/${name}.js`);
    assert.deepEqual([...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1]).filter(path => !path.startsWith('.')), [], name);
  }
  assert.doesNotMatch(read('public/extensions/skill-import.js'), /document\.|innerHTML/);
  assert.doesNotMatch(read('public/extensions/folder-picker.js'), /document\.|innerHTML/);
});
test('桥接协议常量与契约 §K 一致（消息名、事件名）', () => {
  const source = read('public/extensions/folder-picker.js');
  assert.match(source, /FOLDER_PICKER_HANDLER = 'pickFolder'/); assert.match(source, /FOLDER_PICKED_EVENT = 'daylight-folder-picked'/); assert.match(source, /postMessage\(\{ requestId \}\)/);
  assert.match(source, /TODO/); assert.match(source, /5 \* 60 \* 1000/);
});
