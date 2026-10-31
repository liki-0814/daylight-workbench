// 0.8 页面模块单测（node 环境，无 DOM）：页面只组合库组件，且每个用户可控文字都经过转义。
import test from 'node:test';
import assert from 'node:assert/strict';
import { tasksPage, dueLabel, estimateLabel, activityOf } from '../public/pages/tasks.js';
import { dueOptions } from '../public/pages/new-task.js';
import { sidebarNav } from '../public/pages/shell.js';
import { rowEmpty } from '../public/ui/patterns/data-row/data-row.js';

const EVIL = '<img src=x onerror=alert(1)>"\'';
const inert = (out, name) => {
  const text = String(out);
  assert.ok(!/<img\b(?![^>]*\/favicon)/i.test(text.replace(/<img src="\/favicon\.svg"[^>]*>/g, '')), `${name}: <img> 没被转义`);
  assert.ok(!/<script\b/i.test(text), `${name}: <script>`);
  assert.ok(!/<[a-z][^>]*\sstyle\s*=/i.test(text.replace(/"[^"]*"/g, '""')), `${name}: 内联 style`);
  assert.ok(text.includes('&lt;img'), `${name}: 注入文本应被转义`);
};

const state = (over = {}) => ({
  projects: [{ id: 'p1', name: EVIL, color: 'green', path: EVIL }], plans: { '2026-10-30': ['t1'] },
  tasks: [{ id: 't1', title: EVIL, projectId: 'p1', notes: EVIL, status: 'todo', priority: 'high', due: '2026-10-30', estimate: 90 }, { id: 't2', title: 'b', projectId: null, notes: '', status: 'todo' }],
  ...over,
});
const model = (over = {}) => {
  const s = over.state || state();
  return { state: s, view: 'all', tab: 'open', query: '', selectedId: null, tasks: s.tasks, counts: { open: 2, done: 0 }, today: '2026-10-30', currentProject: null, codes: new Map(s.tasks.map((t, i) => [t.id, `DL-0${i + 1}`])), ...over };
};

test('dueLabel：今天 / 明天 / 日期 / 逾期 / 无', () => {
  assert.deepEqual(dueLabel('', '2026-10-30'), { text: '—' });
  assert.deepEqual(dueLabel('2026-10-30', '2026-10-30'), { text: '今天', tone: 'today' });
  assert.deepEqual(dueLabel('2026-10-31', '2026-10-30'), { text: '明天' });
  assert.deepEqual(dueLabel('2026-11-05', '2026-10-30'), { text: '11月5日', tone: undefined });
  assert.equal(dueLabel('2026-10-01', '2026-10-30').tone, 'overdue');
  assert.deepEqual(dueLabel('2027-01-02', '2026-12-31'), { text: '1月2日', tone: undefined });
});
test('estimateLabel', () => {
  assert.equal(estimateLabel(), '—'); assert.equal(estimateLabel(30), '30 分钟'); assert.equal(estimateLabel(60), '1 小时'); assert.equal(estimateLabel(90), '1 小时 30 分');
});
test('dueOptions：下周一永远在未来，并带月日', () => {
  for (const today of ['2026-10-26', '2026-10-30', '2026-11-01', '2026-12-31']) {
    const monday = dueOptions(today).find(o => o.label === '下周一');
    assert.ok(monday.value > today, `${today} → ${monday.value}`);
    assert.equal(new Date(monday.value + 'T00:00:00').getDay(), 1);
  }
});

test('任务页：固定列、选中行高亮、注入文字被转义', () => {
  const out = String(tasksPage(model({ selectedId: 't1' })));
  inert(out, 'tasks-page');
  assert.match(out, /class="dl-row is-selected"/);
  assert.match(out, /DL-01/);
  assert.match(out, /dl-row__due is-today/);
  assert.match(out, /aria-label="任务详情"|任务详情/);
});
test('任务页：空列表给出下一步，搜索词被转义', () => {
  const out = String(tasksPage(model({ tasks: [], query: EVIL })));
  inert(out, 'tasks-empty');
  assert.match(out, /dl-rows-empty/);
});
test('任务页：项目视图的检查器显示项目信息（转义）', () => {
  const s = state();
  const out = String(tasksPage(model({ state: s, view: 'project:p1', currentProject: s.projects[0], tasks: s.tasks.filter(t => t.projectId === 'p1') })));
  inert(out, 'project-inspector');
});
test('侧栏：项目名转义；当前页 aria-current；数量显示', () => {
  const out = String(sidebarNav({ view: 'project:p1', projects: state().projects, counts: { open: 2, today: 1, byProject: { p1: 1 }, inbox: 1 }, aiActivity: '2', updateAvailable: true }));
  inert(out, 'sidebar');
  assert.equal((out.match(/aria-current="page"/g) || []).length, 1);
  assert.match(out, /有更新/);
  assert.match(out, /data-action="new-project"/);
});
test('rowEmpty：标题 / 提示 / 操作文字转义', () => {
  inert(rowEmpty({ title: EVIL, hint: EVIL, action: { label: EVIL, attrs: { 'data-action': 'new' } } }), 'row-empty');
});

test('详情栏：主按钮只有两个，其余在「更多」菜单；子任务 / 备注 / 动态文字全部转义；没有钉底操作区', () => {
  const s = state(); s.tasks[0].subtasks = [{ id: 's1', title: EVIL, done: false }]; s.tasks[0].createdAt = '2026-10-29T09:00:00+08:00';
  const out = String(tasksPage(model({ state: s, selectedId: 't1' })));
  inert(out, 'inspector');
  const primary = out.slice(out.indexOf('dl-insp__primary'), out.indexOf('dl-insp__body'));
  assert.equal((primary.match(/<button class="dl-btn/g) || []).length, 2, '两个主按钮');
  assert.ok(primary.includes('开始专注') && primary.includes('完成'));
  for (const label of ['编辑', '讨论', '相关对话', '删除', '移出今天']) assert.ok(primary.includes(`data-value="${label === '移出今天' ? 'unplan' : { 编辑: 'edit', 讨论: 'discuss', 相关对话: 'related', 删除: 'delete-task' }[label]}"`), `更多菜单含 ${label}`);
  assert.ok(!out.includes('dl-insp__actions'), '没有钉底操作区');
  assert.ok(out.indexOf('dl-insp__props') < out.indexOf('dl-insp__primary') && out.indexOf('dl-insp__primary') < out.indexOf('dl-insp__body'), '顺序：属性 → 操作 → 分区');
});
test('activityOf：只用真实数据，按时间倒序', () => {
  const task = { id: 't1', status: 'done', createdAt: '2026-10-29T09:00:00+08:00', completedAt: '2026-10-30T18:00:00+08:00' };
  const log = activityOf(task, { '2026-10-30': ['t1'], '2026-10-29': ['t2'] });
  assert.deepEqual(log.map(item => item.text), ['标记完成', '加入 10月30日 的计划', '创建任务']);
  assert.deepEqual(activityOf({ id: 'x', status: 'todo' }, {}), []);
});
