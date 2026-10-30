import { escapeButtonText as esc } from '../components/button.js';
import { shownText, REDACTED } from './conflict.js';
import { extensionCapability } from './capabilities.js';
import { refStatusLabels } from './mcp.js';

// 扩展页 MCP 同 ID 冲突（0.7 PR-12）：纯函数，无 DOM；状态、事件、焦点在 page.js。
// 后端契约：api-contract-skill-enable.md「I. MCP 同 ID 冲突处理」：`POST /mcp-compare`、`mcp.importJson.resolutions`、`mcp.save.onConflict`。
// 复用 E-11：脱敏函数 shownText、`extension-compare-*` 外壳类；不新造对比弹窗。
// 红线：对比只读；后端只给变量名与「是否已设置」，前端仍对所有进入 DOM 的文本再脱敏一次。

// 能力探测只读 capabilities.extensions.mcpConflictCompare 的字面 true；没有就不出「对比」与处理方式选择（旧后端）。
export const mcpCompareSupported = capabilities => extensionCapability(capabilities, 'mcpConflictCompare');

export const RESOLUTIONS = ['adoptNew', 'keepExisting'];
export const resolutionLabel = (resolution, source = 'import') => resolution === 'adoptNew' ? (source === 'form' ? '用新填写的替换' : '用导入的替换') : '保留现有';

const FIELD_LABEL = { name: '名称', transport: '连接方式', enabled: '状态', command: '命令', args: '参数', cwd: '工作目录', url: '地址' };
const TRANSPORT = { stdio: '本地命令（stdio）', http: 'HTTP 服务' };
const REF_KIND = { env: '环境变量', header: '请求头' };
const REF_STATUS = { added: '导入的多了', removed: '导入的少了', changed: '引用的变量不同' };

// 一个字段值 → 文本。命令、参数、地址、目录都过 shownText（疑似凭据整段隐藏）。
export function fieldValueText(field, value, { root = '' } = {}) {
  if (value === undefined || value === null || value === '') return '（无）';
  if (field === 'enabled') return value ? '启用' : '禁用';
  if (field === 'transport') return TRANSPORT[value] || shownText(value, { root });
  if (Array.isArray(value)) return value.length ? value.map(part => shownText(part, { root })).join(' ') : '（无）';
  return shownText(value, { root });
}

// 引用只显示名称与状态，永远没有值：已设置 / 未设置 / 内部引用。
export function refStatusText(ref) {
  if (ref?.internal) return refStatusLabels.internal;
  return ref?.set === true ? refStatusLabels.set : refStatusLabels.unset;
}
const refLine = ref => `<li data-mcp-ref data-ref-set="${ref?.set === true}"><span>${esc(REF_KIND[ref?.kind] || '引用')} <code>${esc(ref?.key ?? '')}</code> → <code>${esc(ref?.ref ?? '')}</code></span> <span class="extension-ref-badge" data-tone="${ref?.internal || ref?.set === true ? 'neutral' : 'warning'}">${esc(refStatusText(ref))}</span></li>`;
const refList = (refs, label) => Array.isArray(refs) && refs.length ? `<div><small>${esc(label)}</small><ul class="extension-mcp-refs">${refs.map(refLine).join('')}</ul></div>` : '';

// 一个同 ID 条目的差异块（details，和 E-11 的文件块同外观）。
export function mcpItemView(item, { root = '', open = true } = {}) {
  const identical = item?.identical === true;
  const fields = Array.isArray(item?.fields) ? item.fields : [], changes = Array.isArray(item?.refs) ? item.refs : [];
  const status = identical ? '内容一致' : '有不同';
  const rows = fields.map(entry => {
    const name = FIELD_LABEL[entry.field] || String(entry.field);
    return `<tr data-mcp-field="${esc(entry.field)}"><th scope="row">${esc(name)}</th><td>${esc(fieldValueText(entry.field, entry.existing, { root }))}</td><td>${esc(fieldValueText(entry.field, entry.incoming, { root }))}</td></tr>`;
  }).join('');
  const table = rows ? `<table class="extension-mcp-compare-table"><thead><tr><th scope="col">字段</th><th scope="col">现有</th><th scope="col">${esc(item?.incomingLabel || '导入的')}</th></tr></thead><tbody>${rows}</tbody></table>` : '';
  const refRows = changes.map(entry => `<li data-mcp-ref-change>${esc(REF_KIND[entry.kind] || '引用')} <code>${esc(entry.key ?? '')}</code>：${esc(REF_STATUS[entry.status] || '不同')}${entry.existingRef || entry.incomingRef ? `（现有 <code>${esc(entry.existingRef || '无')}</code> → 导入 <code>${esc(entry.incomingRef || '无')}</code>）` : ''}</li>`).join('');
  const refsDiff = refRows ? `<div><small>引用差异</small><ul class="extension-mcp-refs">${refRows}</ul></div>` : '';
  const same = identical ? '<p class="extension-compare-empty" role="status" data-mcp-identical>两边的内容完全一致，提交不会改动任何文件。</p>' : '';
  const locked = item?.editable === false ? '<p class="extension-compare-note" role="status" data-mcp-not-editable><small>这一项在软件自己的配置里，含有不能安全替换的内容：只能「保留现有」。需要修改请在对应的 CLI 里改。</small></p>' : '';
  const secrets = Array.isArray(item?.existing?.secretKeys) && item.existing.secretKeys.length ? `<p class="extension-compare-note" data-mcp-secret-keys><small>软件配置里还有 ${item.existing.secretKeys.length} 个读不出的凭据；即使替换，它们也保持原样，不会被删除，也不会显示在这里。</small></p>` : '';
  return `<details class="extension-compare-file extension-mcp-compare-item" data-mcp-compare-item data-id="${esc(item?.id)}" ${open ? 'open' : ''}><summary><span class="extension-compare-path">${esc(shownText(item?.id))}</span><span class="extension-compare-status" data-tone="${identical ? 'neutral' : 'warning'}">${status}</span></summary>${same}${locked}${table}${refsDiff}<div class="extension-mcp-refsets">${refList(item?.existing?.refs, '现有的引用')}${refList(item?.incoming?.refs, `${item?.incomingLabel || '导入的'}引用`)}</div>${secrets}</details>`;
}

// 对比结果的整体视图：外壳沿用 E-11 的只读说明与汇总行。
export function mcpCompareView(result, { root = '', incomingLabel = '导入的', only = '' } = {}) {
  const intro = '<p class="extension-compare-readonly" data-compare-readonly>只读对比：不会改动任何文件。只显示变量名和「是否已设置」，凭据的值不会显示在这里。</p>';
  const all = Array.isArray(result?.items) ? result.items : [], items = only ? all.filter(item => item.id === only) : all;
  const different = items.filter(item => item.identical !== true).length, same = items.length - different, fresh = (result?.newIds || []).length;
  const summary = `<p class="extension-compare-summary" data-compare-summary>${[`${different} 个同 ID 的内容不同`, same ? `${same} 个内容一致` : '', !only && fresh ? `${fresh} 个是新的，不冲突` : ''].filter(Boolean).join(' · ')}</p>`;
  if (!items.length) return `${intro}${summary}<p class="extension-compare-empty" role="status">没有同 ID 的服务可对比。</p>`;
  return `${intro}${summary}<div class="extension-compare-files">${items.map((item, index) => mcpItemView({ ...item, incomingLabel }, { root, open: item.identical !== true && index === items.findIndex(entry => entry.identical !== true) })).join('')}</div>`;
}

// ---- 选择：每个冲突 ID 一组单选，默认不选 ----
// choices：{ [id]: 'adoptNew' | 'keepExisting' }；只认 RESOLUTIONS，其它值当没选。
export const cleanChoices = (choices, ids) => Object.fromEntries((ids || []).filter(id => RESOLUTIONS.includes(choices?.[id])).map(id => [id, choices[id]]));
export const allChosen = (choices, ids) => (ids || []).length > 0 && ids.every(id => RESOLUTIONS.includes(choices?.[id]));
export const adoptedIds = (choices, ids) => (ids || []).filter(id => choices?.[id] === 'adoptNew');

let radioSeq = 0;
// 冲突清单：每组 fieldset（legend = ID），「对比」按钮 + 两个单选。editable:false 的只给「保留现有」。
export function conflictChoiceList(items, choices = {}, { source = 'import', busy = false, canCompare = true } = {}) {
  return `<div class="extension-mcp-conflicts" data-mcp-conflicts>${(items || []).map(item => {
    const group = `mcp-resolution-${++radioSeq}`, locked = item.editable === false, same = item.identical === true;
    const radio = resolution => {
      const off = busy || resolution === 'adoptNew' && locked;
      return `<label class="extension-mcp-choice"><input type="radio" name="${group}" value="${resolution}" data-mcp-resolution data-id="${esc(item.id)}" ${choices[item.id] === resolution ? 'checked' : ''} ${off ? 'disabled' : ''}><span>${esc(resolutionLabel(resolution, source))}</span></label>`;
    };
    return `<fieldset class="extension-mcp-conflict" data-mcp-conflict data-id="${esc(item.id)}" ${busy ? 'aria-busy="true"' : ''}><legend>已存在 ID「${esc(shownText(item.id))}」${same ? '（内容一致）' : ''}</legend>${canCompare ? `<button type="button" class="secondary" data-mcp-compare data-id="${esc(item.id)}">对比</button>` : ''}<div class="extension-mcp-choices" role="radiogroup" aria-label="「${esc(shownText(item.id))}」怎么处理">${radio('adoptNew')}${radio('keepExisting')}</div>${locked ? '<p class="extension-compare-note"><small>软件自己的配置里含不能安全替换的内容，只能保留现有。</small></p>' : ''}<div data-mcp-compare-body aria-live="polite"></div></fieldset>`;
  }).join('')}</div>`;
}

// ---- 文案 ----
export const REPLACE_NOTE = '可经操作历史撤销：被替换的配置会先记录下来，提示里点「撤销」就能还原。已经生成或已接入软件的配置不会自动更新，需要重新生成。';
export function replaceConfirm(ids, { source = 'import' } = {}) {
  const list = (ids || []).map(id => `<li><code>${esc(shownText(id))}</code></li>`).join('');
  return `<div class="extension-archive-intro extension-conflict-intro" data-mcp-replace-confirm><p><strong>用${source === 'form' ? '新填写' : '导入'}的配置替换现有服务</strong></p><ul>${list}</ul><p>现有服务的位置不变，连接方式、命令、参数、引用整体换成${source === 'form' ? '新填写' : '导入'}的。</p><p>${esc(REPLACE_NOTE)}</p></div>`;
}

export function mcpCompareErrorMessage(error) {
  switch (error?.code) {
    case 'EXTENSIONS_VERSION_CONFLICT': return '配置在你打开之后变化了，已刷新；请重新预览再对比。';
    case 'EXTENSIONS_CONFLICT': return '还有没处理的同 ID 冲突：请对每一个选「用导入的替换」或「保留现有」。';
    case 'EXTENSIONS_DUPLICATE_ID': return error.message || '已存在同 ID 的 MCP 服务。';
    default: return error?.message || '对比失败，没有改动任何文件。';
  }
}
export const mcpShouldRefresh = error => ['EXTENSIONS_VERSION_CONFLICT', 'EXTENSIONS_CONFLICT'].includes(error?.code);

export { importedMessage } from './staging.js';
export { REDACTED };
