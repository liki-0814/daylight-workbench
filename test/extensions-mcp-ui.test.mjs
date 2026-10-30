import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isShared, hasMcpSwitch, mcpHealth, toolCountLabel, redactArgs, commandLine, refRows, refBadge, refNote, adviceFor, probeCard, probeAllPlan, chunkIds, resumablePlan, PROBE_BATCH_SIZE, progressOf, progressText, finishText, mcpErrorMessage, shouldRefresh, disabledProbeHint, activeProbe, finishedProbe } from '../public/extensions/mcp.js';

const shared = (extra = {}) => ({ id: 's', name: 'S', scope: 'shared', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], revision: 'r1', ...extra });
const probe = (status, extra = {}) => ({ id: 'p', serverId: 's', status, configRevision: 'r1', toolCount: null, tools: [], message: '', ...extra });

test('only shared servers with a boolean enabled get a row switch', () => {
  assert.equal(hasMcpSwitch(shared()), true);
  assert.equal(hasMcpSwitch(shared({ enabled: undefined })), false);
  assert.equal(hasMcpSwitch(shared({ scope: 'client' })), false);
  assert.equal(hasMcpSwitch(undefined), false);
  assert.equal(isShared({ scope: 'client' }), false);
});

test('health vocabulary: every state has text; disabled wins; stale never shows a green dot', () => {
  const cases = [
    [shared({ enabled: false, lastProbe: probe('running') }), 'disabled', '已停用', 'neutral'],
    [shared({ scope: 'client' }), 'client', '用户级配置', 'neutral'],
    [shared(), 'untested', '尚未检测', 'neutral'],
    [shared({ lastProbe: probe('queued') }), 'queued', '排队中', 'accent'],
    [shared({ lastProbe: probe('running') }), 'running', '正在检测', 'accent'],
    [shared({ lastProbe: probe('succeeded', { toolCount: 3 }) }), 'succeeded', '握手成功', 'success'],
    [shared({ lastProbe: probe('failed') }), 'failed', '检测失败', 'danger'],
    [shared({ lastProbe: probe('timed_out') }), 'timed_out', '检测超时', 'danger'],
    [shared({ lastProbe: probe('cancelled') }), 'cancelled', '已取消', 'neutral'],
    [shared({ lastProbe: probe('succeeded', { stale: true }) }), 'stale', '配置已变更 · 上次握手成功', 'neutral'],
    [shared({ revision: 'r2', lastProbe: probe('failed') }), 'stale', '配置已变更 · 上次检测失败', 'neutral'],
    [shared({ lastProbe: probe('weird') }), 'unknown', '未知状态', 'neutral'],
  ];
  for (const [server, key, label, tone] of cases) { const health = mcpHealth(server); assert.deepEqual([health.key, health.label, health.tone], [key, label, tone], key); }
  assert.equal(mcpHealth(shared({ lastProbe: probe('succeeded') })).dot, true);
  assert.equal(mcpHealth(shared()).dot, false);
});

test('a running probe is never marked stale even if the revision differs', () => {
  assert.equal(mcpHealth(shared({ revision: 'r2', lastProbe: probe('running') })).key, 'running');
  assert.equal(activeProbe(probe('queued')), true); assert.equal(finishedProbe(probe('queued')), false); assert.equal(finishedProbe(probe('cancelled')), true);
});

test('tool count label only for succeeded probes', () => {
  assert.equal(toolCountLabel(probe('succeeded', { toolCount: 5 })), '5 个工具');
  assert.equal(toolCountLabel(probe('succeeded', { toolCount: 0 })), '0 个工具');
  assert.equal(toolCountLabel(probe('failed', { toolCount: 5 })), '');
  assert.equal(toolCountLabel(null), '');
});

test('command line hides credential-looking arguments and strips URL query', () => {
  assert.deepEqual(redactArgs(['-y', 'pkg', '--token=abc', '--api-key', 'xyz', '--port=8080', 'ghp_' + 'a'.repeat(30), 'A'.repeat(40)]), ['-y', 'pkg', '--token=…', '--api-key', '…', '--port=8080', '…', '…']);
  assert.equal(commandLine(shared({ args: ['--password=hunter2', 'run'] })), 'npx --password=… run');
  assert.equal(commandLine({ transport: 'http', url: 'https://example.com/mcp?x=1#h' }), 'https://example.com/mcp');
  assert.equal(commandLine({ transport: 'http', url: 'https://example.com/' }), 'https://example.com');
  assert.equal(commandLine({ transport: 'http', url: 'nonsense' }), '');
  assert.equal(commandLine(shared({ args: undefined })), 'npx');
  assert.equal(commandLine(undefined), '');
});

const refs = [{ kind: 'env', key: 'TOKEN', ref: 'GH_TOKEN', set: true, internal: false }, { kind: 'header', key: 'Authorization', ref: 'AUTH', set: false, internal: false }, { kind: 'env', key: 'X', ref: 'DAYLIGHT_SECRET', set: true, internal: true }];
test('ref rows: status set / unset / internal; purpose names the key; no value field exists', () => {
  const rows = refRows(shared({ refStatus: refs }));
  assert.deepEqual(rows.map(row => [row.ref, row.status, row.purpose]), [['GH_TOKEN', 'set', '环境变量 TOKEN'], ['AUTH', 'unset', '请求头 Authorization'], ['DAYLIGHT_SECRET', 'internal', '环境变量 X']]);
  assert.ok(rows.every(row => Object.keys(row).every(key => ['kind', 'key', 'ref', 'purpose', 'status'].includes(key))));
});
test('ref rows: client-local servers are never judged against Daylight\'s environment; old backend returns null', () => {
  assert.deepEqual(refRows(shared({ scope: 'client', refStatus: refs })).map(row => row.status), ['unknown', 'unknown', 'unknown']);
  assert.equal(refRows(shared()), null);
  assert.equal(refBadge(shared({ scope: 'client', refStatus: refs })), null);
});
test('ref badge: internal beats missing; nothing when all set', () => {
  assert.equal(refBadge(shared({ refStatus: refs })).label, '含内部凭据引用');
  assert.equal(refBadge(shared({ refStatus: [refs[0], refs[1]] })).label, '缺 1 个变量');
  assert.equal(refBadge(shared({ refStatus: [refs[0]] })), null);
  assert.equal(refBadge(shared({ refStatus: [] })), null);
  assert.match(refNote, /不读取、不显示值/);
});

test('advice: missing refs first, then known backend messages (pins the backend wording), then generic', () => {
  const server = shared({ refStatus: [refs[1]] });
  assert.match(adviceFor(probe('failed', { message: 'x' }), server), /设置 AUTH/);
  assert.match(adviceFor(probe('failed', { message: '找不到可执行命令，请检查安装和 PATH。' }), shared()), /PATH/);
  assert.match(adviceFor(probe('failed', { message: '服务要求授权；请检查环境变量引用。' }), shared()), /授权/);
  assert.match(adviceFor(probe('timed_out', { message: '检测超时，请检查服务是否能够启动或连通。' }), shared()), /重新检测/);
  assert.match(adviceFor(probe('failed', { message: '握手或工具清单读取失败，请检查配置及服务状态。' }), shared()), /让 AI 诊断/);
  assert.match(adviceFor(probe('failed', { message: '环境变量内部', status: 'failed' }), shared({ refStatus: [refs[2]] })), /内部凭据/);
  assert.equal(adviceFor(probe('succeeded'), server), '');
  assert.equal(adviceFor(null, server), '');
  const backend = readFileSync(new URL('../extensions/mcp-probes.mjs', import.meta.url), 'utf8');
  for (const text of ['找不到可执行命令', '服务要求授权']) assert.ok(backend.includes(text), '后端文案变了：' + text + '，同步 mcp.js 的 adviceFor');
});

test('probe card: success lists the first 8 tools and the remainder; queued/running are cancellable', () => {
  const card = probeCard(probe('succeeded', { toolCount: 12, tools: Array.from({ length: 12 }, (_, index) => ({ name: 't' + index })), serverVersion: '1.2', protocolVersion: '2025' }), shared());
  assert.equal(card.tools.length, 8); assert.equal(card.moreTools, 4); assert.equal(card.cancellable, false); assert.equal(card.version, '1.2');
  assert.equal(probeCard(probe('queued'), shared()).cancellable, true);
  assert.equal(probeCard(probe('running'), shared()).cancellable, true);
  assert.equal(probeCard(probe('failed', { message: 'm' }), shared({ refStatus: [refs[1]] })).advice.includes('AUTH'), true);
  assert.equal(probeCard(null, shared()), null);
  assert.equal(probeCard(probe('succeeded', { toolCount: 0 }), shared()).toolCount, 0);
});
test('probe card of a disabled server still describes the old probe, not "已停用"', () => {
  assert.equal(probeCard(probe('succeeded', { toolCount: 1 }), shared({ enabled: false })).label, '握手成功');
});

test('probe-all plan: visible shared servers only; disabled are listed as skipped; client-local counted', () => {
  const servers = [shared({ id: 'a' }), shared({ id: 'b', enabled: false }), shared({ id: 'c', scope: 'client' })];
  const plan = probeAllPlan(servers);
  assert.deepEqual([plan.targets.map(s => s.id), plan.skipped.map(s => s.id), plan.clientLocal], [['a'], ['b'], 1]);
  assert.deepEqual(probeAllPlan(undefined), { targets: [], skipped: [], clientLocal: 0 });
});
test('progress: queued/running are active; timed_out counts as failed; texts', () => {
  const list = [probe('queued'), probe('running'), probe('succeeded'), probe('failed'), probe('timed_out'), probe('cancelled')];
  const progress = progressOf(list);
  assert.deepEqual(progress, { total: 6, queued: 1, running: 1, active: 2, done: 4, succeeded: 1, failed: 2, cancelled: 1 });
  assert.equal(progressText(progress), '检测中：完成 4 / 6 · 排队 1');
  assert.equal(finishText({ ...progress, queued: 0, running: 0 }), '检测完成：成功 1，失败 2，已取消 1');
  assert.equal(finishText(progressOf([probe('succeeded')])), '检测完成：成功 1，失败 0');
});

test('error messages by code; 409 means refresh', () => {
  assert.equal(mcpErrorMessage({ code: 'EXTENSIONS_ALREADY_ENABLED' }, 'GitHub'), '「GitHub」已经是启用状态，已刷新。');
  assert.equal(mcpErrorMessage({ code: 'EXTENSIONS_ALREADY_DISABLED' }), '该服务已经是停用状态，已刷新。');
  assert.equal(mcpErrorMessage({ code: 'EXTENSIONS_PROBE_BUSY', message: '最多同时检测两个 MCP 服务，请等待或取消现有检测' }), '最多同时检测两个 MCP 服务，请等待或取消现有检测');
  assert.equal(mcpErrorMessage({ code: 'EXTENSIONS_PROBE_BUSY' }).includes('两个'), true);
  assert.equal(mcpErrorMessage({ message: '服务已禁用', status: 400 }), '服务已禁用');
  assert.equal(shouldRefresh({ status: 409 }), true); assert.equal(shouldRefresh({ status: 400 }), false); assert.equal(shouldRefresh(null), false);
});
test('disabled probe hint wording', () => {
  assert.equal(disabledProbeHint(true, false), ''); assert.equal(disabledProbeHint(false, false), '已停用，启用后可检测'); assert.equal(disabledProbeHint(false, true), '启用待应用，应用后才能检测');
});

// ---- 页面接线（源码级断言，同 PR-6 的做法：没有 DOM 环境，行为由 e2e 覆盖） ----
{
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../public/extensions/page.js', import.meta.url), 'utf8');
  const assets = JSON.parse(readFileSync(new URL('../core/web-assets.json', import.meta.url), 'utf8'));
  test('page wires the MCP switch through staging (no direct action), probe-all through one confirmation and client.probeAll with the state version', () => {
    assert.match(page, /input\.dataset\.mcpSwitch !== undefined[\s\S]{0,200}stageChange\(staged, \{ kind: 'mcp'/);
    assert.match(page, /client\.probeAll\(ids, state\.version\)/);
    assert.match(page, /button\.hasAttribute\('data-probe-all'\)\) openProbeAll\(\)/);
    assert.match(page, /data-cancel-all-probes/); assert.match(page, /client\.cancelProbe\(probe\.id\)/);
  });
  test('probe polling treats queued as active (not only running) and pauses while the page is hidden', () => {
    const watch = page.slice(page.indexOf('function watchProbe'), page.indexOf('async function cancelOneProbe'));
    assert.match(watch, /activeProbe\(probe\)/); assert.doesNotMatch(watch, /status === 'running'/); assert.match(watch, /document\.hidden/);
    const all = page.slice(page.indexOf('async function pollProbeAll'), page.indexOf('async function finishProbeAll'));
    assert.match(all, /filter\(activeProbe\)/); assert.match(all, /document\.hidden/); assert.doesNotMatch(all, /Promise\.all/);   // 逐个查询，不并发
  });
  test('the ref table renders names and set/unset only; the inspector no longer dumps raw envRefs/headerRefs when refStatus exists', () => {
    const table = page.slice(page.indexOf('function refTableMarkup'), page.indexOf('function probeAvailability'));
    assert.doesNotMatch(table, /\.value|envRefs|headerRefs/); assert.match(table, /refNote/);
    assert.match(page, /\.\.\.\(refRows\(item\) \? \[\] : \['envRefs', 'headerRefs'\]\)/);
  });
  test('mcp.js is a registered web asset', () => { assert.equal(assets['/extensions/mcp.js'], 'extensions/mcp.js'); });
}

// 对比度守卫：行内 danger / accent 药丸必须是不透明（白底 + 色调）。半透明底色叠在选中 / 悬停行上，文字对比度会跌到 <4.5（巡检 ext7-probe-*）。
test('row health chips keep an opaque background (contrast on selected / hover rows)', () => {
  const css = readFileSync(new URL('../public/extensions/extensions.css', import.meta.url), 'utf8');
  for (const tone of ['danger', 'accent']) assert.match(css, new RegExp(`\\.extension-row \\.ui-chip-${tone} \\{ background: linear-gradient\\(var\\(--\\w+-bg\\), var\\(--\\w+-bg\\)\\) #fff; \\}`), tone);
});

// 布局锚点守卫：「检测全部服务」按钮比标题行高，必须收回占位，否则 MCP 页的清单标题比另外两个分类高 18px（suite LAY-溢出+锚点）。
test('probe-all button does not make the MCP list heading taller than the other categories', () => {
  const css = readFileSync(new URL('../public/extensions/extensions.css', import.meta.url), 'utf8');
  assert.match(css, /\.extension-list-heading > \.extension-probe-all \{ margin-block: -9px; \}/);
});

test('probe-all ids go to the backend in batches of at most 50, in order, without duplicates', () => {
  const ids = Array.from({ length: 120 }, (_, index) => `s${index}`);
  const batches = chunkIds([...ids, 's3', 's7']);
  assert.equal(PROBE_BATCH_SIZE, 50);
  assert.deepEqual(batches.map(batch => batch.length), [50, 50, 20]);
  assert.deepEqual(batches.flat(), ids);
  assert.deepEqual(chunkIds(ids.slice(0, 50)).map(batch => batch.length), [50]);
  assert.deepEqual(chunkIds([]), []);
  assert.deepEqual(chunkIds(undefined), []);
});

test('after a reload, two or more queued/running probes in /state resume as a probe-all run', () => {
  const server = (id, status, extra = {}) => shared({ id, lastProbe: probe(status, { id: `p-${id}`, serverId: id }), ...extra });
  assert.deepEqual(resumablePlan([server('a', 'queued'), server('b', 'running'), server('c', 'succeeded')]).map(item => item.id), ['p-a', 'p-b']);
  assert.deepEqual(resumablePlan([server('a', 'running'), server('b', 'succeeded')]), [], 'a single running probe is watched by the inspector, not resumed');
  assert.deepEqual(resumablePlan([server('a', 'queued', { enabled: false }), server('b', 'running')]), [], 'disabled servers are not counted');
  assert.deepEqual(resumablePlan([server('a', 'queued', { scope: 'client' }), server('b', 'queued', { scope: 'client' })]), []);
  assert.deepEqual(resumablePlan(undefined), []);
});

test('page wiring: the probe-all confirm sends batches and /state resumes active probes', () => {
  const page = readFileSync(new URL('../public/extensions/page.js', import.meta.url), 'utf8');
  assert.match(page, /for \(const \[index, ids\] of chunkIds\(/, 'probe-all must go through chunkIds');
  assert.match(page, /resumablePlan\(state\.servers\)/, 'the state handler must resume active probes');
  assert.doesNotMatch(page, /client\.probeAll\(plan\.targets\.map/, 'no single POST with every id');
});
