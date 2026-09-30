const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const states = { disabled: '已停用', unconfigured: '待配置', unchecked: '尚未检查', ready: '可路由', no_models: '无可路由模型', unavailable: '暂不可用' };
const outcomes = { completed: '完成', truncated: '输出截断', failed: '失败', cancelled: '已取消', timeout: '超时', unknown: '完成状态未采集' };
const stages = { validation: '请求校验', routing: '路由', authentication: '认证', discovery: '模型目录', conversion: '协议转换', upstream: '上游请求', response: '响应读取', retry: '等待重试' };

const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未验证';
const duration = value => value === undefined ? '未采集' : `${Math.round(value)} ms`;

export function describeSource(source) {
  const v = source.verification;
  return `${states[source.state]} · ${source.routableModels} 个可路由模型 · 目录检查 ${source.checkedAt ? time(source.checkedAt) : '未执行'} · 生成 ${time(v.generation)} · 流式 ${time(v.streaming)} · 工具调用${v.toolCall ? '已观察到' : '未观察到'}${source.error ? ' · ' + source.error.hint : ''}`;
}

export function createDiagnostics({ getToken, onSources }) {
  const root = document.createElement('div'); root.className = 'workspace proxy-diagnostics';
  root.innerHTML = `<details class="proxy-disclosure" data-sources><summary>来源状态<span>检查结果与使用记录</span></summary><div class="proxy-detail-body"><p class="proxy-error" data-source-error role="alert" hidden></p><div data-source-list></div></div></details>
    <details class="proxy-disclosure" data-requests><summary>最近请求<span>所有来源共用</span></summary><div class="proxy-detail-body">
      <div class="proxy-request-filters"><label>来源<select data-source><option value="">全部来源</option></select></label><label>模型<input data-model placeholder="模型名称"></label><label>结果<select data-outcome><option value="">全部结果</option>${Object.entries(outcomes).map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select></label><button type="button" class="text-button" data-refresh>刷新</button></div>
      <p class="proxy-hint" data-note role="status"></p><div data-record-list></div></div></details>`;
  const $ = selector => root.querySelector(selector);
  let sources = [], signature = '', renderedSources = '', renderedRecords = '', loading = false;
  async function api(path) {
    const response = await fetch('/api/proxy/' + path, { headers: { 'x-workbench-token': getToken() }, signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '诊断信息读取失败');
    return data;
  }
  function renderRecords(rows) {
    const signature = JSON.stringify(rows);
    if (signature === renderedRecords) return;
    renderedRecords = signature;
    const open = new Set([...root.querySelectorAll('[data-record][open]')].map(node => node.dataset.record));
    $('[data-record-list]').innerHTML = rows.length ? rows.map((r, index) => {
      const id = r.id || `legacy-${r.time}-${index}`, source = sources.find(s => s.id === r.provider)?.name || r.provider;
      const pair = (label, value) => `<div><dt>${label}</dt><dd>${esc(value ?? '未提供')}</dd></div>`;
      return `<details class="proxy-request" data-record="${esc(id)}" ${open.has(id) ? 'open' : ''}><summary><span>${esc(r.model || '模型未解析')} · ${esc(source)}</span><span>${esc(outcomes[r.outcome] || '历史记录')} · ${duration(r.durationMs)}</span><small>${esc(time(r.time))}</small></summary><dl>
        ${pair('请求 ID', r.id)}${pair('调用来源', r.origin === 'test' ? '手动推理测试' : '客户端')}${pair('客户端协议', r.protocol)}${pair('执行方式', { native: '原生转发', converted: '协议转换', adapted: '来源适配' }[r.execution])}
        ${pair('上游模型', r.upstreamModel)}${pair('上游报告模型', r.reportedModel)}${pair('上游协议', r.upstreamProtocol)}${pair('HTTP 状态', r.httpStatus)}${pair('上游 HTTP 状态', r.upstreamStatus)}${pair('首个有效内容', duration(r.firstContentMs))}${pair('重试次数', r.retries)}
        ${pair('输入 Token', r.usage?.inputTokens)}${pair('输出 Token', r.usage?.outputTokens)}${pair('缓存读取', r.usage?.cacheReadTokens)}${pair('缓存写入', r.usage?.cacheWriteTokens)}${pair('请求速度档位', r.requestedTier)}${pair('实际速度档位', r.actualTier)}
        ${Object.entries(r.stages || {}).map(([stage, value]) => pair(stages[stage] || stage, duration(value))).join('')}
        ${r.error ? pair('失败阶段', stages[r.error.stage] || '未知') + pair('错误码', r.error.code ?? r.error.status) + pair('建议', r.error.hint) : ''}
      </dl></details>`;
    }).join('') : '<p class="proxy-hint">暂无匹配的请求记录</p>';
  }
  async function refresh() {
    if (!getToken() || loading) return;
    loading = true;
    try {
      sources = (await api('sources')).sources;
      $('[data-source-error]').hidden = true;
      const nextSignature = JSON.stringify(sources.map(s => [s.id, s.name]));
      if (signature !== nextSignature) {
        const selected = $('[data-source]').value;
        $('[data-source]').innerHTML = '<option value="">全部来源</option>' + sources.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
        $('[data-source]').value = selected; signature = nextSignature;
      }
      const sourceSignature = JSON.stringify(sources);
      if (renderedSources !== sourceSignature) {
        renderedSources = sourceSignature;
        $('[data-source-list]').innerHTML = sources.map(s => `<div class="proxy-model"><strong>${esc(s.name)}</strong><p class="proxy-hint">${esc(describeSource(s))}</p>${s.observations.map(o => `<small>${esc(o.model)} · ${esc(o.protocol)} · ${o.streaming ? '流式' : '非流式'} · ${esc(time(o.time))}</small>`).join('')}</div>`).join('');
        onSources(sources);
      }
      if (!$('[data-requests]').open) return;
      const query = new URLSearchParams({ source: $('[data-source]').value, model: $('[data-model]').value.trim(), outcome: $('[data-outcome]').value });
      const data = await api('requests?' + query);
      renderRecords(data.records);
      $('[data-note]').textContent = data.error || `匹配 ${data.matched} 条，显示最近 ${data.records.length} 条。仅统计 Daylight 中转请求；缺失用量不按零计算。`;
    } catch (error) {
      $('[data-note]').textContent = error.message;
      $('[data-source-error]').textContent = error.message; $('[data-source-error]').hidden = false;
    }
    finally { loading = false; }
  }
  $('[data-requests]').ontoggle = () => { if ($('[data-requests]').open) void refresh(); };
  for (const selector of ['[data-source]', '[data-model]', '[data-outcome]']) $(selector).onchange = refresh;
  $('[data-refresh]').onclick = refresh;
  return { element: root, refresh, describe: describeSource };
}
