import { selectField } from './components/select.js';
import { refreshButton, setRefreshState } from './components/section.js';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function mountAISettings(root, getToken) {
  const section = document.createElement('section'); section.className = 'settings-panel ai-settings';
  root.querySelector('.settings-grid').prepend(section);
  let settings, backend, catalog = {}, dirty = false;
  const api = async (route, data) => { const res = await fetch('/api/ai/' + route, { method: data ? 'POST' : 'GET', headers: { 'X-Workbench-Token': getToken(), 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) }); const r = await res.json(); if (!res.ok) throw new Error(r.error); return r; };
  function capture() {
    if (!settings || !section.querySelector('form')) return;
    const data = new FormData(section.querySelector('form'));
    settings[backend] = { path: data.get('path'), model: data.get('model'), effort: data.get('effort'), accessMode: data.get('accessMode') || 'standard', contextWindow: data.get('contextWindow') || null, ...(backend === 'qoder' ? { maxOutputTokens: data.get('maxOutputTokens') || null } : {}) };
  }
  function paint() {
    delete section.dataset.feedback;
    const s = settings[backend], models = catalog[backend]?.models || [];
    const selected = models.find(m => m.id === s.model);
    const efforts = selected?.efforts?.length ? selected.efforts : s.effort ? [s.effort] : [];
    section.innerHTML = `<div class="settings-heading"><h2>AI 对话</h2><p>使用本机 CLI，访问模式从下一次发送生效</p></div><form>${selectField({name:'backend',label:'AI 后端',value:backend,options:[{value:'codex',label:'Codex'},{value:'qoder',label:'Qoder'}]})}${selectField({name:'accessMode',label:'访问模式',value:s.accessMode || 'standard',options:[{value:'standard',label:'标准 · 按需确认'},{value:'full',label:'完全访问 · 不询问命令权限'}]})}<p class="ai-setting-hint">完全访问允许运行时读写文件、执行命令和访问网络，无需逐次确认。Daylight 数据变更仍需审阅；正在等待的确认不受切换影响。</p><label>CLI 路径<input name="path" value="${esc(s.path)}" placeholder="自动检测本机安装"></label>${refreshButton({label:'刷新模型与技能',loadingLabel:'刷新中…',attrs:{'data-detect':true}})}${selectField({name:'model',label:'默认模型',value:s.model,options:[{value:'',label:'请先检测并选择模型'},...(s.model && !models.some(m => m.id === s.model) ? [{value:s.model,label:s.model}] : []),...models.map(m => ({value:m.id,label:m.name || m.id}))]})}${selectField({name:'effort',label:'思考强度',value:s.effort,options:[{value:'',label:'使用 CLI 默认值'},...efforts.map(e => ({value:e,label:e}))]})}${selected?.contextWindows?.length ? selectField({name:'contextWindow',label:'上下文窗口（Token）',value:s.contextWindow || '',options:[{value:'',label:'使用模型默认值'},...selected.contextWindows.map(n => ({value:n,label:n.toLocaleString()}))]}) : `<label>上下文窗口（Token）<input type="number" name="contextWindow" min="1" max="10000000" value="${esc(s.contextWindow || '')}" placeholder="使用模型默认值"></label>`}${backend === 'qoder' ? `<label>最大输出（Token）<input type="number" name="maxOutputTokens" min="1" max="10000000" value="${esc(s.maxOutputTokens || '')}" placeholder="使用 CLI 默认值"></label>` : '<p class="ai-setting-hint">Codex 未提供已适配的最大输出设置，使用运行时默认值。</p>'}<p class="ai-setting-hint">上下文设置不会扩大模型真实能力。${backend === 'qoder' ? '思考强度与上下文覆盖以所选模型实际支持为准，不支持时会显示错误。' : ''}认证复用本机 CLI 登录；模型不可用时不会自动切换。</p><div class="ai-card-actions"><span class="ai-settings-status" role="status">${dirty ? '有未保存的修改' : ''}</span><button class="primary" type="submit">保存 AI 设置</button></div></form>`;
  }
  section.addEventListener('input', () => { dirty = true; section.querySelector('.ai-settings-status').textContent = '有未保存的修改'; });
  section.addEventListener('change', e => { const name = e.target.querySelector?.('input')?.name || e.target.name; dirty = true; if (name === 'backend') { capture(); backend = e.target.value; paint(); void loadCatalog(); } else if (name === 'model') { capture(); settings[backend].effort = ''; paint(); } else section.querySelector('.ai-settings-status').textContent = '有未保存的修改'; });
  section.addEventListener('click', async e => {
    if (!e.target.closest('[data-detect]')) return; capture(); const button = e.target.closest('button'); setRefreshState(button, {loading:true}); const selected = backend;
    section.querySelector('.ai-settings-status').textContent = '正在检测…';
    try { const result = await api('discover', { backend: selected, path: settings[selected].path, force: true }); catalog[selected] = result; settings[selected].path = result.path; dirty = true; paint(); section.querySelector('.ai-settings-status').textContent = `已连接，发现 ${result.models.length} 个模型；选择后保存`; }
    catch (e) { section.querySelector('.ai-settings-status').textContent = e.message; } finally { setRefreshState(button); }
  });
  section.addEventListener('submit', async e => { e.preventDefault(); capture(); settings.backend = backend; const b = e.target.querySelector('[type=submit]'); b.disabled = true;
    try { settings = (await api('settings', settings)).settings; dirty = false; paint(); section.querySelector('.ai-settings-status').textContent = '已保存，访问模式从下一次发送生效；其他配置用于新对话'; }
    catch (e) { section.querySelector('.ai-settings-status').textContent = e.message; } finally { b.disabled = false; }
  });
  async function loadCatalog() {
    const selected = backend, cliPath = settings[selected].path;
    try {
      const result = await api('discover', { backend: selected, path: cliPath });
      if (backend !== selected || section.querySelector('[name=path]')?.value !== cliPath) return;
      capture(); catalog[selected] = result; paint();
    } catch (e) { if (backend === selected) section.querySelector('.ai-settings-status').textContent = e.message; }
  }
  function feedback(message) {
    section.dataset.feedback = '';
    const paragraph = document.createElement('p');
    paragraph.className = 'ui-feedback';
    paragraph.setAttribute('role', 'status');
    paragraph.textContent = message;
    section.replaceChildren(paragraph);
  }
  feedback('正在读取 AI 设置…');
  api('settings').then(r => { settings = r.settings; backend = settings.backend; paint(); void loadCatalog(); }).catch(e => { feedback('AI 设置暂时不可用：' + e.message); });
}
