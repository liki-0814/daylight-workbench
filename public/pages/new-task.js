// 新建任务面板（0.8）：composer 模式 + 本页的状态与创建流程。
//   openNewTask({ projects, projectId, today, onCreate, onNewProject }) → { el, close() }
//   表单状态保存在这里：输入框 / select / switch 都只经 ui:change 回填（页面不监听原生 input，不查询组件内部类）；
//   重绘走 dialog.update(composerBody(props))（组件内部用 morph 增量更新，标题输入框的焦点与输入法状态不丢）；错误文案走 composer 的 error prop。
import { composerBody } from '../ui/patterns/composer/composer.js';
import { mountDialog } from '../ui/components/dialog/dialog.js';
import { showToast } from '../ui/components/toast/toast.js';

const pad = n => String(n).padStart(2, '0');
const civil = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const shift = (day, n) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d + n); };
const size = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export const dueOptions = today => {
  const monday = shift(today, ((8 - shift(today, 0).getDay()) % 7) || 7);
  return [{ value: '', label: '无截止' }, { value: today, label: '今天' }, { value: civil(shift(today, 1)), label: '明天' }, { value: civil(monday), label: '下周一', meta: `${monday.getMonth() + 1}月${monday.getDate()}日` }, { value: civil(shift(today, 7)), label: '一周后' }];
};
const statusOptions = [{ value: 'todo', label: '待办' }, { value: 'active', label: '进行中' }];
const priorityOptions = [{ value: '', label: '默认（中）' }, { value: 'high', label: '高' }, { value: 'medium', label: '中' }, { value: 'low', label: '低' }];
const estimateOptions = [{ value: '', label: '不估算' }, ...[[15, '15 分钟'], [30, '30 分钟'], [60, '1 小时'], [120, '2 小时'], [240, '4 小时']].map(([value, label]) => ({ value: String(value), label }))];

export function openNewTask({ projects, projectId = null, today, onCreate, onNewProject, files = () => pickFiles() }) {
  const form = { title: '', notes: '', status: 'todo', project: projectId ?? '', priority: '', due: '', estimate: '', attachments: [], keepOpen: false, error: '' };
  let busy = false;
  const props = () => ({
    project: form.project, projects: [{ value: '', label: '未归类' }, ...projects.map(p => ({ value: p.id, label: p.name, dot: p.color }))],
    title: form.title, notes: form.notes, status: form.status, statusOptions, priority: form.priority, priorityOptions,
    due: form.due, dueOptions: dueOptions(today), estimate: form.estimate, estimateOptions,
    attachments: form.attachments.map(f => ({ name: f.name, meta: size(f.size) })), keepOpen: form.keepOpen, error: form.error,
  });
  const dialog = mountDialog({ id: 'new-task-dialog', label: '新建任务', width: 680, className: 'dl-composer', children: composerBody(props()) });
  const el = dialog.el;
  const paint = () => dialog.update(composerBody(props()));
  const field = name => el.querySelector(`[name="${name}"]`);
  const setError = message => { form.error = message; paint(); };

  el.addEventListener('ui:change', event => {
    const name = event.target.dataset.name || event.target.name || event.target.closest('[data-name]')?.dataset.name;
    if (name === 'title' || name === 'notes') { form[name] = event.detail.value; return; }
    if (name === 'keepOpen') { form.keepOpen = Boolean(event.detail.value); return; }
    if (name in form) form[name] = String(event.detail.value);
  });
  el.addEventListener('ui:select', event => { if (event.detail.value === '__new__') { onNewProject?.(); } });
  el.addEventListener('click', async event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'attach-files') {
      const picked = await files();
      if (picked.length) { form.attachments.push(...picked.map(f => ({ name: f.name, size: f.size }))); paint(); }
    }
    if (action === 'create-task') await create();
  });
  el.addEventListener('ui:close', event => { if (event.target === el) dialog.destroy(); });

  async function create() {
    if (busy) return;
    if (!form.title.trim()) { setError('请输入任务标题'); field('title')?.focus(); return; }
    busy = true; setError('');
    const notes = [form.notes.trim(), ...form.attachments.map(f => `附件：${f.name}（${size(f.size)}）`)].filter(Boolean).join('\n');
    try {
      await onCreate({ title: form.title.trim(), notes, projectId: form.project || null, status: form.status, ...(form.priority ? { priority: form.priority } : {}), ...(form.due ? { due: form.due } : {}), ...(form.estimate ? { estimate: Number(form.estimate) } : {}) });
      if (form.keepOpen) { Object.assign(form, { title: '', notes: '', attachments: [] }); paint(); field('title')?.focus(); showToast({ message: '任务已创建，可以继续新建', tone: 'success' }); }
      else el.close();
    } catch (error) { setError(error.message); showToast({ message: error.message, tone: 'error' }); }
    finally { busy = false; }
  }

  dialog.open();
  field('title')?.focus();
  return { el, close: () => dialog.close() };
}

function pickFiles() {
  return new Promise(resolve => {
    const picker = document.createElement('input');
    picker.type = 'file'; picker.multiple = true;
    picker.addEventListener('change', () => resolve([...picker.files]));
    picker.addEventListener('cancel', () => resolve([]));
    picker.click();
  });
}
