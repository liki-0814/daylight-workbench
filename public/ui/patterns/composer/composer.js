import { html, attrs, slot, flag } from '../../core/html.js';
import { dot } from '../../components/chip/chip.js';
import { input } from '../../components/input/input.js';
import { select } from '../../components/select/select.js';
import { iconButton } from '../../components/icon-button/icon-button.js';
import { switchControl } from '../../components/switch/switch.js';
import { dialog } from '../../components/dialog/dialog.js';
import { icon } from '../../core/icons.js';

// composerBody({ project, projects, title, notes, status, priority, due, estimate, options..., attachments, keepOpen })
//   新建任务面板内容（放进 dialog 里）：面包屑 + Esc、无边框标题、描述、附件缩略图、胶囊属性（均为 select 组件）、底栏。
//   attachments: [{ name, meta }]（只记录文件名与大小）。
export function composerBody({ project, projects = [], title = '', notes = '', status, statusOptions = [], priority, priorityOptions = [], due, dueOptions = [], estimate, estimateOptions = [], attachments = [], keepOpen = false, projectLabel = '项目', hint = '⌘↵ 创建' } = {}) {
  const current = projects.find(p => p.value === project);
  const projectOptions = [...projects, { divider: true }, { value: '__new__', label: '新建项目…', icon: 'plus', action: true }];
  return html`<div class="dl-comp">
<div class="dl-comp__head">${current?.dot ? dot(current.dot) : ''}<span>${current ? current.label : '未归类'}</span><span aria-hidden="true">›</span><span>新建任务</span><kbd class="dl-kbd dl-comp__esc">Esc</kbd></div>
${input({ name: 'title', value: title, label: '任务标题', placeholder: '任务标题', variant: 'title', autofocus: true })}
${input({ name: 'notes', value: notes, label: '描述', placeholder: '添加描述…', variant: 'bare', multiline: true, rows: 2 })}
<div class="dl-comp__thumbs" data-key="thumbs">${attachments.map((file, index) => html`<div class="dl-thumb" data-key="thumb-${index}"><b>${file.name}</b><span>${file.meta}</span></div>`)}</div>
<div class="dl-comp__props">${select({ name: 'status', value: status, label: '状态', options: statusOptions, variant: 'chip' })}${select({ name: 'project', value: project ?? '', label: projectLabel, options: projectOptions, variant: 'chip', search: true, placeholder: '未归类' })}${select({ name: 'priority', value: priority ?? '', label: '优先级', options: priorityOptions, variant: 'chip', placeholder: '优先级' })}${select({ name: 'due', value: due ?? '', label: '截止', options: dueOptions, variant: 'chip', placeholder: '截止' })}${select({ name: 'estimate', value: estimate ?? '', label: '预估时长', options: estimateOptions, variant: 'chip', placeholder: '预估时长' })}</div>
<div class="dl-comp__foot">${iconButton({ label: '添加附件（仅记录文件名）', icon: 'plus', attrs: { 'data-action': 'attach-files' } })}<label class="dl-comp__keep">${switchControl({ name: 'keepOpen', checked: keepOpen, label: '继续新建' })}<span>继续新建</span></label><span class="dl-comp__hint">${hint}</span>${iconButton({ label: '创建任务（⌘↵）', icon: 'arrow-up', variant: 'send', attrs: { 'data-action': 'create-task', 'data-dialog-submit': true } })}</div>
</div>`;
}

export function composerDialog(props) {
  return dialog({ id: 'new-task-dialog', label: '新建任务', width: 680, className: 'dl-composer', children: composerBody(props) });
}
