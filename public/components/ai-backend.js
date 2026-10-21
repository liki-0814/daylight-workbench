import { aiBackends } from '../../core/ai-backends.js';
import { selectField } from './select.js';

export function backendField({ id, value, backends = [], compact = true, hideLabel = true }) {
  return selectField({ id, name: 'backend', label: 'AI 后端', value, compact, hideLabel, options: aiBackends.map(item => {
    const detected = backends.find(backend => backend.id === item.id);
    return { value: item.id, label: item.name + (detected ? detected.available ? '' : ' · 未检测到' : '') };
  }) });
}
