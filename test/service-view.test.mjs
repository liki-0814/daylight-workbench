// 反向代理页状态卡的纯函数：四态映射、错误三段话、端口校验、运行时长。
import test from 'node:test';
import assert from 'node:assert/strict';
import { viewState, heroProps, errorCopy, uptimeText, validPort, alternatePort, portHint, START_SLOW_MS } from '../public/pages/proxy-service-view.js';

const running = { state: 'running', port: 4319, baseUrl: 'http://127.0.0.1:4319/v1', startedAt: '2026-10-31T00:00:00Z', activeRequests: 0, lastError: '' };
test('viewState: running / starting / stopped / error, with optimistic pending', () => {
  assert.equal(viewState(running), 'running');
  assert.equal(viewState({ state: 'starting' }), 'starting');
  assert.equal(viewState({ state: 'stopped' }), 'stopped');
  assert.equal(viewState({ state: 'stopped', lastError: '端口 4319 已被占用' }), 'error');
  assert.equal(viewState({ state: 'stopped', runtimeError: 'no node' }), 'error');
  assert.equal(viewState({ state: 'stopped' }, 'starting'), 'starting', 'optimistic start shows within one frame');
  assert.equal(viewState(running, 'stopping'), 'stopped');
  assert.equal(viewState({ state: 'stopping' }), 'stopped');
  assert.equal(viewState(undefined), 'stopped');
});
test('heroProps running: green tag, copyable address, uptime / requests / sources; never invents a request count', () => {
  const props = heroProps({ status: running, sources: { available: 3, total: 4 }, today: 1284, now: Date.parse('2026-10-31T02:14:00Z') });
  assert.equal(props.state, 'running'); assert.equal(props.tagLabel, '运行中'); assert.equal(props.address, 'http://127.0.0.1:4319/v1');
  assert.deepEqual(props.meta.map(item => item.label), ['已运行', '今日请求', '来源']);
  assert.equal(props.meta[0].value, '2 小时 14 分钟'); assert.equal(props.meta[2].value, '3/4 可用');
  assert.ok(!heroProps({ status: running, now: Date.parse('2026-10-31T02:14:00Z') }).meta.some(item => item.label === '今日请求'));
});
test('heroProps starting: dashed note, cancel only after the slow threshold', () => {
  const quick = heroProps({ status: { state: 'starting', port: 4319 } });
  assert.equal(quick.tagLabel, '启动中…'); assert.match(quick.addressNote, /正在监听 127\.0\.0\.1:4319/); assert.equal(quick.cancel, undefined);
  assert.equal(START_SLOW_MS, 5000);
  const slow = heroProps({ status: { state: 'starting', port: 4319 }, slow: true });
  assert.equal(slow.cancel.label, '取消'); assert.equal(slow.cancel.attrs['data-action'], 'cancel-start');
});
test('heroProps stopped and error', () => {
  const stopped = heroProps({ status: { state: 'stopped', port: 4319 } });
  assert.equal(stopped.tagLabel, '已停用'); assert.match(stopped.addressNote, /未在监听/); assert.match(stopped.note, /下次启用时生效/);
  const failed = heroProps({ status: { state: 'stopped', port: 4319, lastError: '端口 4319 已被占用，请在设置中更换端口' } });
  assert.equal(failed.tagLabel, '启动失败'); assert.match(failed.error.what, /端口 4319 已被占用/); assert.equal(failed.error.alternate, 4320);
  assert.equal(heroProps({ status: { state: 'stopped', port: 4320, lastError: '端口 4320 已被占用' } }).error.alternate, 4321);
  const other = heroProps({ status: { state: 'stopped', port: 4319, lastError: '启动失败，请检查模型来源的登录状态与网络' } });
  assert.equal(other.error.alternate, null);
});
test('errorCopy: three parts — what happened, why, what to do', () => {
  for (const status of [{ port: 4319, lastError: '端口 4319 已被占用' }, { port: 4319, lastError: '请先登录 Qoder' }, { port: 1, lastError: 'x' }, { port: 1, runtimeError: 'Node 18' }]) {
    const copy = errorCopy(status); assert.ok(copy.what && copy.why && copy.todo, JSON.stringify(status));
  }
});
test('ports and hints', () => {
  assert.ok(validPort('4319') && validPort(1024) && validPort(65535)); assert.ok(!validPort('80') && !validPort('70000') && !validPort('43.5') && !validPort('') && !validPort('abc'));
  assert.equal(alternatePort(4319), 4320); assert.equal(alternatePort(4320), 4321);
  assert.match(portHint('running'), /自动重启/); assert.match(portHint('stopped'), /下次启用/); assert.match(portHint('starting'), /启动完成后生效/); assert.match(portHint('error'), /重试/);
});
test('uptimeText', () => {
  const t = Date.parse('2026-10-31T10:00:00Z');
  assert.equal(uptimeText('2026-10-31T09:59:40Z', t), '不到 1 分钟'); assert.equal(uptimeText('2026-10-31T09:15:00Z', t), '45 分钟');
  assert.equal(uptimeText('2026-10-29T08:00:00Z', t), '2 天 2 小时'); assert.equal(uptimeText('nonsense', t), '');
});
