import { escapeButtonText as esc } from './button.js';
// 状态 chip（design-spec §6）：高 20，底色 = 状态 10%，必须带文字（颜色不是唯一含义）；neutral 用于「已接入/未接入」类信息。
export const chipTones = ['neutral', 'success', 'warning', 'danger', 'accent'];
export function chip({ label, tone = 'neutral', dot = false, title = '', className = '' } = {}) {
  const kind = chipTones.includes(tone) ? tone : 'neutral';
  return `<span class="ui-chip ui-chip-${kind} ${esc(className)}"${title ? ` title="${esc(title)}"` : ''}>${dot ? '<span class="ui-chip-dot" aria-hidden="true"></span>' : ''}${esc(label)}</span>`;
}
