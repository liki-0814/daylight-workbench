import {marked} from './marked.js';
import DOMPurify from './purify.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function markdown(text) {
  return DOMPurify.sanitize(marked.parse(text || '',{gfm:true,breaks:false}),{ALLOWED_TAGS:['p','br','strong','em','del','h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote','pre','code','hr','table','thead','tbody','tr','th','td','a'],ALLOWED_ATTR:['href','title','start','align'],ALLOW_DATA_ATTR:false});
}
export function processMessage(m) {
  const items=m.items || [], active=items.some(i=>i.status==='running'), failed=items.some(i=>i.status==='failed');
  const label = i => {
    const status=({running:'进行中',completed:'已完成',failed:'失败',interrupted:'已中断',unknown:'未返回完成状态'})[i.status] || i.status;
    const seconds=Math.max(0,Math.round(((i.finishedAt || Date.now())-i.startedAt)/1000));
    return `<span class="ai-process-dot ${escape(i.status)}">${i.status==='completed'?'✓':i.status==='failed'?'!':'·'}</span><span>${escape(i.name.replace(/^mcp__daylight__/,''))}</span><small>${escape(status)} · ${seconds}s</small>`;
  };
  const content = i => `<div class="ai-process-content">${i.text?`<div class="ai-markdown">${markdown(i.text)}</div>`:''}${i.input!==undefined?`<div class="ai-process-caption">输入</div><pre>${escape(i.input)}</pre>`:''}${i.output!==undefined?`<div class="ai-process-caption">结果</div><pre>${escape(i.output)}</pre>`:''}${!i.text && i.input===undefined && i.output===undefined ? `<span class="ai-process-empty">${i.status==='running'?'正在等待内容…':'未提供可展示的内容'}</span>` : ''}</div>`;
  if (items.length === 1) return `<details class="ai-process ai-process-single" data-disclosure="${escape(m.id)}" ${active?'open':''}><summary>${label(items[0])}</summary>${content(items[0])}</details>`;
  return `<details class="ai-process" data-disclosure="${escape(m.id)}" ${active?'open':''}><summary>${active?'正在处理':failed?'处理出现错误':'处理记录'}<span>${items.length} 项</span></summary><div class="ai-process-items">${items.map(i=>{
    return `<details class="ai-process-item" data-disclosure="${escape(m.id+':'+i.id)}"><summary>${label(i)}</summary>${content(i)}</details>`;
  }).join('')}</div></details>`;
}
