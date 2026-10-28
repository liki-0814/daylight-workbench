// Messages needs explicit cache breakpoints; Chat/Responses cache implicitly.
// Generated policies only; providers preserve native callers' explicit policies.
export function applyMessageCachePolicy(body, ttl = '5m') {
  const mark = block => { if (block) block.cache_control = {type:'ephemeral',...(ttl==='1h'?{ttl}:{})}; };
  const lastCacheable = blocks => Array.isArray(blocks)?blocks.findLast(block =>
    block.type === 'text' ? !!block.text : ['image','tool_use','tool_result'].includes(block.type)):undefined;
  // Four breakpoints at most: stable tools/system and two rolling turn boundaries.
  // Mark outer tool_result blocks, never nested content or JSON schemas.
  mark(body.tools?.at(-1));
  if (typeof body.system === 'string' && body.system) body.system = [{type:'text',text:body.system}];
  mark(lastCacheable(body.system));
  for (const message of (body.messages || []).slice(-2)) {
    if(typeof message.content==='string'&&message.content)message.content=[{type:'text',text:message.content}];
    mark(lastCacheable(message.content));
  }
  return body;
}

// Inspect only protocol fields, never tool JSON schemas or opaque tool output.
export function hasMessageCachePolicy(body) {
  return body.cache_control !== undefined || body.tools?.some(t=>t.cache_control !== undefined) ||
    Array.isArray(body.system) && body.system.some(b=>b.cache_control !== undefined) ||
    body.messages?.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.cache_control !== undefined));
}
