export function actionLinks(action) {
  const links = new Map();
  for (const a of action.type === 'batch' ? action.actions : [action]) {
    if (/^(source|model|route|auth|service)\./.test(a.type)) links.set('proxy', '<a class="text-button" href="#proxy">查看代理</a>');
    else if (a.type.startsWith('pi.')) links.set('cli', '<a class="text-button" href="#cli">查看 CLI 配置</a>');
    else if (a.type.startsWith('ai.')) links.set('ai', '<a class="text-button" href="#settings">查看 AI 设置</a>');
    else if (a.type.endsWith('.delete')) links.set(a.id, '<span class="muted">对象已删除</span>');
    else if (a.type.startsWith('project.') && a.id) links.set('p:' + a.id, `<a class="text-button" href="#project=${encodeURIComponent(a.id)}">查看项目</a>`);
    else if (/^(task|plan)\./.test(a.type)) for (const id of a.ids || (a.id ? [a.id] : [])) links.set('t:' + id, `<a class="text-button" href="#task=${encodeURIComponent(id)}">查看任务</a>`);
  }
  return [...links.values()].join('');
}
