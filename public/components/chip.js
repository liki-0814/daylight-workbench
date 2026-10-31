import { escapeButtonText as esc } from './button.js';
// 状态 chip（design-spec §6）：高 20，底色 = 状态 10%，必须带文字（颜色不是唯一含义）；neutral 用于一般信息；「已接入」配色见 chip.css：connected（= success）圆点 + 中性底，idle 空心圆环，update 琥珀点；failure（检测失败 / 超时）是琥珀三角 + #FFF4E5 底，不用红色圆点；off（已停用）是一条短横线。
export const chipTones = ['neutral', 'success', 'warning', 'danger', 'accent', 'connected', 'idle', 'update', 'failure', 'off'];
export function chip({ label, tone = 'neutral', dot = false, title = '', className = '' } = {}) {
  const kind = chipTones.includes(tone) ? tone : 'neutral';
  return `<span class="ui-chip ui-chip-${kind} ${esc(className)}"${title ? ` title="${esc(title)}"` : ''}>${dot ? '<span class="ui-chip-dot" aria-hidden="true"></span>' : ''}${esc(label)}</span>`;
}
