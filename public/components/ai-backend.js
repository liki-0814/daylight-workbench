import { aiBackends } from '../../core/ai-backends.js';
import { clientIcon } from '../extensions/client-icons.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function backendField({ id, value, backends = [] }) {
  const options = aiBackends.map(item => {
    const detected = backends.find(backend => backend.id === item.id);
    return { value: item.id, label: item.name + (detected ? detected.available ? '' : ' · 未检测到' : ''), disabled: detected ? !detected.available : false };
  });
  return `<div class="ai-backend-icons" role="radiogroup" aria-label="AI 后端"><input type="hidden" id="${escape(id)}" name="backend" value="${escape(value)}">${options.map(item => `<button type="button" class="ai-backend-icon${item.value === value ? ' selected' : ''}" data-backend="${escape(item.value)}" title="${escape(item.label)}" aria-pressed="${item.value === value}" ${item.disabled ? 'disabled data-unavailable="1"' : ''}>${clientIcon(item.value, 'ai-backend-mark')}</button>`).join('')}</div>`;
}
