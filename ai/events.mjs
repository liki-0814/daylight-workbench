import { randomUUID } from 'node:crypto';
const clip = value => typeof value === 'string' ? value.slice(0, 100000) : value === undefined ? undefined : JSON.stringify(value).slice(0, 100000);
export function recordEvent(c, e) {
  if (e.type === 'delta') {
    let m = e.itemId && c.messages.find(m => m.role === 'assistant' && m.itemId === e.itemId);
    if (!m) { m = !e.itemId && c.messages.at(-1)?.role === 'assistant' ? c.messages.at(-1) : { id: randomUUID(), role: 'assistant', text: '', itemId: e.itemId }; if (!c.messages.includes(m)) c.messages.push(m); }
    m.text = (m.text + e.text).slice(0, 500000);
  } else if (e.type === 'process') {
    let group = c.messages.find(m => m.role === 'process' && m.items.some(i => i.id === e.id));
    if (!group) { group = c.messages.at(-1)?.role === 'process' ? c.messages.at(-1) : { id: randomUUID(), role: 'process', text: '', items: [] }; if (!c.messages.includes(group)) c.messages.push(group); }
    let item = group.items.find(i => i.id === e.id);
    if (!item) { item = {id:e.id,kind:e.kind || 'tool',name:e.name || '工具调用',status:'running',startedAt:Date.now(),text:''};group.items.push(item); }
    for (const key of ['name','status','input','output','text']) if (e[key] !== undefined) item[key] = clip(e[key]);
    if (e.textDelta) item.text = (item.text + e.textDelta).slice(0,100000);
    if (item.status !== 'running') item.finishedAt ||= Date.now();
    c.activity = item.status === 'running' ? (item.kind === 'reasoning' ? '正在思考…' : `正在调用 ${item.name}`) : '';
  } else if (e.type === 'tool') c.activity = `正在调用 ${e.name}`;
  c.revision = (c.revision || 0) + 1;
}
export function finishEvents(c, status = 'interrupted') {
  for (const m of c.messages) for (const item of m.items || []) if (item.status === 'running') {item.status = status;item.finishedAt=Date.now();}
}
