import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backupList, backupTime, backupMeta, restoreNoticeText, revealBody, revealErrorMessage, revealFallbackPath, revealSupported, restoreBackupSupported } from '../public/extensions/restore-reveal.js';
import { appliedMessage, undoable } from '../public/extensions/staging.js';

const page = readFileSync(new URL('../public/extensions/page.js', import.meta.url), 'utf8');
const assets = JSON.parse(readFileSync(new URL('../core/web-assets.json', import.meta.url), 'utf8'));

test('门控只认 capabilities.extensions.* 的字面 true', () => {
  for (const value of ['true', 1, 'yes', {}, null, undefined, false]) { assert.equal(revealSupported({ extensions: { reveal: value } }), false, String(value)); assert.equal(restoreBackupSupported({ extensions: { restoreBackup: value } }), false); }
  assert.equal(revealSupported({ extensions: { reveal: true } }), true); assert.equal(restoreBackupSupported({ extensions: { restoreBackup: true } }), true);
  assert.equal(revealSupported({ reveal: true }), false, '旧的顶层镜像不再认'); assert.equal(revealSupported(undefined), false);
});

test('backupList：只留四个元数据键，兼容数组与 {backups}，丢掉没有 operationId 的项', () => {
  const raw = [{ operationId: 'op-1', at: '2026-10-31T01:02:03.000Z', summary: '保存 a', servers: 3, content: 'SECRET', path: '/etc/x' }, { at: 'x' }, null, { operationId: '' }, { operationId: 'op-2', servers: -1, summary: 5 }];
  const list = backupList({ kind: 'mcpConfig', version: 1, backups: raw });
  assert.deepEqual(list, [{ operationId: 'op-1', summary: '保存 a', at: '2026-10-31T01:02:03.000Z', servers: 3 }, { operationId: 'op-2', summary: '', at: '', servers: null }]);
  assert.equal(JSON.stringify(list).includes('SECRET'), false);
  assert.deepEqual(backupList(raw), list); assert.deepEqual(backupList(undefined), []); assert.deepEqual(backupList({ backups: 'x' }), []);
});

test('backupTime / backupMeta：可读时间 + 服务个数；读不出来原样给出，不抛错', () => {
  assert.match(backupTime('2026-10-31T01:02:03.000Z'), /^2026\/10\/31 \d{2}:\d{2}$/);
  assert.equal(backupTime('not a date'), 'not a date'); assert.equal(backupTime(''), ''); assert.equal(backupTime(undefined), '');
  assert.match(backupMeta({ at: '2026-10-31T01:02:03.000Z', servers: 3 }), /· 3 个服务$/);
  assert.equal(backupMeta({ at: '', servers: 0 }), '0 个服务'); assert.equal(backupMeta({ at: '', servers: null }), '');
});

test('revealBody：只产出 kind + id / clientId；不认识的 kind、缺 id 都不发请求；绝不带路径', () => {
  assert.deepEqual(revealBody('mcpConfig'), { kind: 'mcpConfig' });
  assert.deepEqual(revealBody('mcpConfig', { id: 'x', path: '/etc' }), { kind: 'mcpConfig' });
  assert.deepEqual(revealBody('skill', { id: 'api-design', path: '/etc' }), { kind: 'skill', id: 'api-design' });
  assert.deepEqual(revealBody('client', { clientId: 'claude', id: 'ignored' }), { kind: 'client', clientId: 'claude' });
  assert.equal(revealBody('skill', {}), null); assert.equal(revealBody('client', { id: 'x' }), null); assert.equal(revealBody('path', { id: 'x' }), null); assert.equal(revealBody(undefined), null);
});

test('revealErrorMessage：501 / 404 / 500 / 400 各有提示；501 优先；「复制路径」提示只在有路径可复制时出现', () => {
  assert.match(revealErrorMessage({ status: 501, code: 'EXTENSIONS_UNSUPPORTED' }, { canCopy: true }), /不支持.*macOS.*复制路径/);
  assert.doesNotMatch(revealErrorMessage({ status: 501 }), /复制路径/); assert.match(revealErrorMessage({ status: 501 }), /不支持/);
  assert.match(revealErrorMessage({ status: 404, code: 'EXTENSIONS_OBJECT_MISSING' }), /不存在.*重新扫描/);
  assert.match(revealErrorMessage({ status: 500, code: 'EXTENSIONS_REVEAL_FAILED' }, { canCopy: true }), /没有打开.*复制路径/);
  assert.doesNotMatch(revealErrorMessage({ status: 500 }), /复制路径/);
  assert.match(revealErrorMessage({ status: 400 }), /不在 Daylight 管理的扩展目录/);
  assert.match(revealErrorMessage({ message: '网络断了' }, { canCopy: true }), /网络断了.*复制路径/);
  assert.match(revealErrorMessage(undefined), /请求没有完成/);
});

test('revealFallbackPath：只用页面已有字段', () => {
  assert.equal(revealFallbackPath('skill', { item: { sourcePath: '/s/a' } }), '/s/a');
  assert.equal(revealFallbackPath('client', { item: { skillsRoot: '/c/skills' } }), '/c/skills');
  assert.equal(revealFallbackPath('mcpConfig', { problemPath: '/m/servers.json' }), '/m/servers.json');
  assert.equal(revealFallbackPath('skill', {}), ''); assert.equal(revealFallbackPath('x', {}), '');
});

test('appliedMessage / undoable：恢复有自己的文案，并且可撤销', () => {
  assert.equal(appliedMessage({ type: 'mcp.restoreBackup', operationId: 'op-1' }), '已从备份恢复 MCP 配置');
  assert.equal(undoable({ type: 'mcp.restoreBackup', operationId: 'op-1' }, { operationId: 'op-9' }), true);
  assert.equal(undoable({ type: 'operation.restore', operationId: 'op-9' }, { operationId: 'op-10' }), false);
  assert.match(restoreNoticeText, /撤销/);
});

test('page.js 接线：新模块已登记；检查器按钮门控；reveal 只传 body；恢复提示条接撤销', () => {
  assert.equal(assets['/extensions/restore-reveal.js'], 'extensions/restore-reveal.js');
  assert.match(page, /revealButton\('skill', item\)/); assert.match(page, /item\.selected \? revealButton\('client', item\)/);
  assert.match(page, /const revealButton = \(kind, item\) => capability\('reveal'\)/);
  assert.match(page, /revealErrorMessage\(error, \{ canCopy: !!path \}\)/);
  assert.match(readFileSync(new URL('../public/components/banner.css', import.meta.url), 'utf8'), /\.ui-toast-action \{ flex: none; white-space: nowrap;/);
  assert.match(page, /client\.reveal\(body\)/); assert.doesNotMatch(page, /client\.reveal\(\{[^}]*path/);
  assert.match(page, /data-restore-slot/); assert.match(page, /data-restore-undo/); assert.match(page, /ok\[0\]\.action\?\.type === 'mcp\.restoreBackup'/);
  assert.match(page, /await undoOperations\(restoreNotice \|\| \[\]\)/);
  assert.match(page, /backupList\(await client\.backups\('mcpConfig'\)\)/);
});
