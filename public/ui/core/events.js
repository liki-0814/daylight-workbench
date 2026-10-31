// ui:* 事件契约（0.8）。组件只能经这里的 emit() 派发事件（scripts/lint-deps.mjs 守卫）。
//
//   事件名  ui:<verb>，verb ∈ change | select | open | close | dismiss
//   冒泡    bubbles: true；可被页面取消的事件（cancelable: true）在 README 里逐个标出，页面调用 preventDefault() 阻止默认行为
//   detail  { value, previousValue?, source: 'user' | 'keyboard' }
//   时机    只在用户动作之后派发。组件的 update(props) 永远不派发（程序改状态不应回声）
//   边界    data-action 只用于页面级命令（新建、删除、专注…）；组件自己的状态变化只走 ui:*，页面不得通过原生 click 去猜组件状态
export const VERBS = Object.freeze(['change', 'select', 'open', 'close', 'dismiss']);
export const SOURCES = Object.freeze(['user', 'keyboard']);
export const eventName = verb => `ui:${verb}`;

// detail 的 schema：返回错误数组（空 = 合法）。单元测试和 emit 共用。
export function detailErrors(detail) {
  const errors = [];
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return ['detail must be an object'];
  if (!('value' in detail)) errors.push('detail.value is required');
  if (!SOURCES.includes(detail.source)) errors.push(`detail.source must be one of ${SOURCES.join(' | ')}`);
  for (const key of Object.keys(detail)) if (!['value', 'previousValue', 'source'].includes(key)) errors.push(`unexpected detail.${key}`);
  return errors;
}

// emit(target, 'change', { value, previousValue, source }, { cancelable })
// 返回 false 表示被页面 preventDefault 了（只有 cancelable 事件才可能）。
export function emit(target, verb, detail, { cancelable = false } = {}) {
  if (!VERBS.includes(verb)) throw new TypeError(`ui:${verb} is not part of the ui event contract (${VERBS.join(', ')})`);
  const errors = detailErrors(detail);
  if (errors.length) throw new TypeError(`ui:${verb} detail invalid: ${errors.join('; ')}`);
  const event = new CustomEvent(eventName(verb), { bubbles: true, cancelable, composed: true, detail: { ...detail } });
  target.dispatchEvent(event);
  return !event.defaultPrevented;
}
// 键盘触发的事件 source 为 'keyboard'，其余为 'user'。
export const sourceOf = event => (event && (event.type === 'keydown' || event.type === 'keyup' || event.detail === 0 && event.type === 'click' && event.pointerType === '') ? 'keyboard' : 'user');
