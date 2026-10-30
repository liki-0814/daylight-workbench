// api-contract §H (后端)：「在访达中显示」与「从备份恢复」。接口级，不依赖 UI。
// 依赖后端分支 feat/0.7-h-reveal-restore；当前构建没有 `restoreBackup` 能力时自动标为已知缺陷，后端合入后会「意外通过」，无需再改任何标记。
// 不调用有效的 reveal（会在真实 Mac 上打开访达）：只验证 reveal 拒绝原始路径（400；不支持的平台 501）。
import { extensionsCapability } from '../../core/extensions-contracts.js';
import { FIXTURE_SECRET } from '../fixture.mjs';

const hasBackend = typeof extensionsCapability.restoreBackup === 'string';
const BACKEND_GATE = hasBackend ? {} : { expectedFail: '§H 后端未包含在此构建（需要 feat/0.7-h-reveal-restore）：合入后自动变为必须通过' };
const json = response => JSON.parse(response.text);
const servers = async fixture => json(await fixture.api('/api/extensions/state')).servers.filter(item => item.scope !== 'client').map(item => item.id).sort();
async function applyAction(fixture, action) {
  const plan = await fixture.api('/api/extensions/prepare', { action });
  if (plan.status !== 200) return { plan, applied: null };
  const body = json(plan);
  const applied = await fixture.api('/api/extensions/actions', { requestId: crypto.randomUUID(), expectedVersion: body.expectedVersion, planId: body.planId, action: body.normalizedAction });
  return { plan, body, applied };
}

export default [
  { id: 'ext-rr-01', priority: 'P0', widths: [1440], ...BACKEND_GATE, title: '§H 接口：恢复点只含元数据；mcp.restoreBackup 走 prepare→apply 并可 operation.restore 撤销；reveal 拒绝原始路径', async run({ assert: check, fixture }) {
    const original = await servers(fixture);
    const state = json(await fixture.api('/api/extensions/state'));
    check.equal(state.capabilities?.restoreBackup, true, 'state.capabilities.restoreBackup');
    // two writes: the first one's result is a recovery point once the second is applied
    const first = await applyAction(fixture, { type: 'mcp.save', create: true, server: { id: 'rr-one', name: 'rr-one', transport: 'stdio', command: 'node', args: ['one.mjs'] } });
    check.equal(first.applied.status, 200, '第一次保存');
    const second = await applyAction(fixture, { type: 'mcp.save', create: true, server: { id: 'rr-two', name: 'rr-two', transport: 'stdio', command: 'node', args: ['two.mjs'] } });
    check.equal(second.applied.status, 200, '第二次保存');
    const listed = await fixture.api('/api/extensions/backups?kind=mcpConfig');
    check.equal(listed.status, 200, 'backups 状态码'); check.ok(!listed.text.includes(FIXTURE_SECRET) && !listed.text.includes('one.mjs'), '恢复点只含元数据');
    const point = json(listed).backups.find(item => item.operationId === json(first.applied).operationId);
    check.ok(point, '第一次保存后的状态是恢复点'); check.deepEqual(Object.keys(point).sort(), ['at', 'operationId', 'servers', 'summary']);
    check.equal((await fixture.api('/api/extensions/backups?kind=skills')).status, 400, 'kind 只支持 mcpConfig');
    // restore through prepare→apply; no secret echo; then undo
    const restored = await applyAction(fixture, { type: 'mcp.restoreBackup', operationId: point.operationId });
    check.equal(restored.applied.status, 200, '恢复提交');
    check.ok(!restored.plan.text.includes(FIXTURE_SECRET) && !restored.applied.text.includes(FIXTURE_SECRET), '恢复不回显凭据');
    check.deepEqual(await servers(fixture), [...original, 'rr-one'].sort(), '恢复后只剩第一次保存之后的服务');
    const undone = await applyAction(fixture, { type: 'operation.restore', operationId: json(restored.applied).operationId });
    check.equal(undone.applied.status, 200, '撤销恢复'); check.deepEqual(await servers(fixture), [...original, 'rr-one', 'rr-two'].sort(), '撤销后回到恢复前');
    check.equal((await fixture.api('/api/extensions/prepare', { action: { type: 'mcp.restoreBackup', operationId: '../etc' } })).status, 400, '无效 operationId');
    // reveal never takes a raw path (400 where supported, 501 elsewhere); 404/200 would mean a path was honoured
    const reveal = await fixture.api('/api/extensions/reveal', { kind: 'mcpConfig', path: '/etc' });
    check.ok([400, 501].includes(reveal.status), 'reveal 不接受路径字段：' + reveal.status);
  } },
];
