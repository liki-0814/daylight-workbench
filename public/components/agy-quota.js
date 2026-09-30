export function renderAgyQuota(groups, now = new Date()) {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const duration = date => {
    const minutes = Math.max(0, Math.ceil((date - now) / 60000));
    if (!minutes) return '等待刷新';
    const hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
    return days ? `${days}天 ${hours % 24}小时` : hours ? `${hours}小时 ${minutes % 60}分` : `${minutes}分钟`;
  };
  const meter = (group, window, label) => {
    const bucket = group.buckets?.find(b => b.window === window), known = Number.isFinite(bucket?.remainingFraction) && !bucket?.disabled;
    const percent = known ? Math.min(100, Math.max(0, bucket.remainingFraction * 100)) : 0;
    const percentage = known ? `${(Math.floor(percent * 10) / 10).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%` : '—';
    const reset = new Date(bucket?.resetTime), validDate = Number.isFinite(reset.getTime());
    const resetText = validDate ? `${String(reset.getMonth() + 1).padStart(2, '0')}/${String(reset.getDate()).padStart(2, '0')} ${reset.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}` : '暂未提供重置时间';
    return `<div class="agy-pool-meter${percent < 20 && known ? ' low' : ''}"><div class="agy-meter-heading"><span>${label}</span><small>${known && validDate ? escape(duration(reset)) : '暂无额度数据'}</small><strong>${percentage}</strong></div><div class="agy-pool-track" ${known ? `role="meter" aria-label="${escape(group.displayName)} ${label}剩余" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"` : 'aria-hidden="true"'}><span style="width:${percent}%"></span></div><time title="${escape(bucket?.resetTime || '')}">${escape(resetText)}</time></div>`;
  };
  if (!groups.length) return '<p class="proxy-hint">上游暂未提供额度汇总。</p>';
  return `<div class="agy-quota-card"><div class="agy-quota-card-heading"><span class="agy-quota-mark" aria-hidden="true">A</span><div><strong>Antigravity CLI</strong><span>共享额度 · 剩余</span></div><span class="agy-native-label">本机账号</span></div>${[...groups].sort((a, b) => a.displayName.localeCompare(b.displayName, 'en')).map(group => `<div class="agy-pool-row"><div class="agy-pool-name" title="${escape(group.description)}">${escape(group.displayName === 'Claude and GPT models' ? 'Claude / GPT' : group.displayName === 'Gemini Models' ? 'Gemini' : group.displayName)}</div>${meter(group, '5h', '5 小时')}${meter(group, 'weekly', '7 天')}</div>`).join('')}</div>`;
}
