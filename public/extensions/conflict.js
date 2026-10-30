import { escapeButtonText as esc } from '../components/button.js';
import { tildePath } from './staging.js';

// 扩展页 Skill 接入冲突（0.7 E-11）：纯函数，无 DOM；状态、事件、焦点在 page.js。
// 后端契约：api-contract-skill-enable.md「后端修订」G（#32）：`GET /compare`、`skill.resolveConflict`、`bindings[].resolution / resolutionStale`。
// 红线：对比视图只读，凭据永不进 DOM。后端已替换疑似凭据的行，前端不信任它，所有进入 DOM 的对比文本只经过 shownText()。

// ---- 三态：未处理 / 已保留 / 已变化 ----
// 只有 state==='conflict' 的绑定有这个概念：resolution==='keepLocal' → kept；resolutionStale → stale（软件内版本在决定之后又变了）；其余 → open。
export function conflictOf(binding) {
  if (!binding || binding.state !== 'conflict') return null;
  if (binding.resolution === 'keepLocal') return 'kept';
  return binding.resolutionStale === true ? 'stale' : 'open';
}
// 「仅看问题」只算还需要处理的冲突（已保留的不算；已变化的要再处理，算）。
export const isOpenConflict = binding => { const kind = conflictOf(binding); return kind === 'open' || kind === 'stale'; };

// 契约 G.4 的能力探测：网页读不了 /api/v1/capabilities，/state 镜像里也没有 Skill 冲突的键；前端与后端同仓同版本发布，所以默认支持，
// 只有镜像里 `capabilities.extensions.skillConflict` 是字面 false 才隐藏（预留给 Jevis；缺失 / 其它值都按支持处理）。
export const conflictSupported = capabilities => capabilities?.extensions?.skillConflict !== false;

// 行里和检查器里的文字（点 + 文字，不只靠颜色）。
export const conflictNote = binding => ({ open: '同名位置冲突，未改动', kept: '已保留软件内版本，未改动', stale: '软件内版本已变化，请重新处理' })[conflictOf(binding)] || '';
export const conflictHint = binding => ({ open: '冲突', kept: '已保留', stale: '已变化' })[conflictOf(binding)] || '';

// ---- 脱敏：所有进入 DOM 的对比文本都走这一个函数（展示点清单：diff 行、路径、localLink、note、文件名）----
export const REDACTED = '[已隐藏：疑似凭据]';
const SECRET_LINE = [
  /(?:api[_-]?key|secret|token|passw(?:or)?d|authorization|credential|private[_-]?key|access[_-]?key)["']?\s*[:=]\s*\S/i,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/i, /-----BEGIN [A-Z ]*PRIVATE KEY/,
];
export function shownText(value, { root = '' } = {}) {
  const text = String(value ?? '');
  if (text === REDACTED) return text;
  return SECRET_LINE.some(pattern => pattern.test(text)) ? REDACTED : tildePath(text, root);
}

// ---- 动作文案 ----
export const resolveTitle = { adoptShared: '采用共享版本', keepLocal: '保留软件内版本', reopen: '重新处理' };
export const resolveLabel = { adoptShared: '采用共享版本', keepLocal: '保留软件内版本', reopen: '重新处理' };
export function resolveIntro({ resolution, skillName, clientName }) {
  const where = `${clientName} 里的同名内容`;
  if (resolution === 'adoptShared') return `<div class="extension-archive-intro extension-conflict-intro" data-conflict-intro><p><strong>用共享版本替换 ${esc(where)}</strong></p><p>「${esc(skillName)}」在 ${esc(clientName)} 里会变成指向共享版本的链接。软件内多出的内容不会再被读取。</p><p>被替换的内容会先记录下来：完成后可以在提示里点「撤销」还原，建议先用「对比差异」核对。</p></div>`;
  if (resolution === 'keepLocal') return `<div class="extension-archive-intro extension-conflict-intro" data-conflict-intro><p><strong>保留 ${esc(clientName)} 里的版本</strong></p><p>不会改动任何文件，也不会建立链接；之后不再作为问题提示。该位置的内容再变化时，会重新提示。</p></div>`;
  return `<div class="extension-archive-intro extension-conflict-intro" data-conflict-intro><p><strong>重新处理 ${esc(clientName)} 里的同名位置</strong></p><p>撤销「保留软件内版本」的记录，这个位置重新作为冲突提示；不会改动任何文件。</p></div>`;
}
// ---- 检查器里的冲突块 ----
// block：{ reason }——采用 / 保留按钮置灰的原因（总开关有暂存、Skill 已停用）；空串 = 可用。
export function conflictPanel({ skill, binding, client, root = '', busy = false, masterStaged = false, skillOff = false }) {
  const kind = conflictOf(binding); if (!kind) return '';
  const name = client?.name || binding.clientId, attrs = `data-skill="${esc(skill.id)}" data-client="${esc(binding.clientId)}"`, id = `extension-conflict-block-${esc(binding.clientId)}`;
  const keepBlock = conflictBlock({ masterStaged }), adoptBlock = conflictBlock({ masterStaged, skillOff, resolution: 'adoptShared' });
  const where = binding.target ? `<code class="extension-conflict-path">${esc(shownText(binding.target, { root }))}</code>` : '';
  const text = { open: `${esc(name)} 里已经有同名内容，Daylight 没有改动它。`, kept: `已保留 ${esc(name)} 里的版本；它的内容变化前不会再提示。`, stale: `${esc(name)} 里的版本在你做出决定之后又变了，请重新处理。` }[kind];
  const button = (attr, label, blocked = '') => `<button type="button" class="secondary" ${attr} ${attrs} ${busy || blocked ? 'disabled' : ''}${blocked ? ` aria-describedby="${id}" title="${esc(blocked)}"` : ''}>${label}</button>`;
  const actions = kind === 'kept'
    ? button('data-conflict-compare', '对比差异…') + button('data-conflict-reopen', '重新处理')
    : button('data-conflict-compare', '对比差异…') + button('data-conflict-adopt', '采用共享版本…', adoptBlock) + button('data-conflict-keep', '保留软件内版本', keepBlock);
  const why = kind === 'kept' ? '' : adoptBlock;
  return `<div class="extension-conflict" data-conflict data-conflict-state="${kind}" data-client="${esc(binding.clientId)}" role="group" aria-label="${esc(name)} 的同名位置冲突"><p class="extension-conflict-text"><strong>${kind === 'kept' ? '已保留软件内版本' : kind === 'stale' ? '软件内版本已变化' : '同名位置冲突'}</strong> · ${text}</p>${where}${why ? `<p class="extension-conflict-block" id="${id}"><small>${esc(why)}</small></p>` : ''}<div class="extension-actions">${actions}</div></div>`;
}

// ---- 对比视图（只读）----
const STATUS = { same: '相同', different: '不同', onlyShared: '仅共享版本有', onlyLocal: '仅软件内有', typeDiffers: '类型不同', unknown: '无法比较' };
const STATUS_TONE = { same: 'neutral', different: 'warning', onlyShared: 'accent', onlyLocal: 'accent', typeDiffers: 'warning', unknown: 'neutral' };
const WITHHELD = { sensitive: '疑似凭据文件：只比较是否相同，内容不显示', binary: '二进制文件：只显示大小，内容不显示', tooLarge: '文件太大：内容不显示' };
const REASON = { missing: '软件里的这个位置已经不存在，没有可对比的内容。', link: '软件里的这个位置是指向别处的链接。对比不会跟随链接去读取它的内容。', special: '软件里的这个位置不是普通文件或目录，不能对比。' };
const sizeText = size => Number.isFinite(size) ? (size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`) : '';
export const statusLabel = status => STATUS[status] || '未知';

// 汇总行：不为 0 的才显示（「不同」始终显示，让「0 处不同」可见）。
export function summaryText(summary = {}) {
  const parts = [`${summary.different || 0} 个文件不同`, ['same', '个相同'], ['onlyShared', '个仅共享版本有'], ['onlyLocal', '个仅软件内有'], ['typeDiffers', '个类型不同'], ['unknown', '个无法比较']].map(part => {
    if (typeof part === 'string') return part;
    const count = summary[part[0]] || 0; return count ? `${count} ${part[1]}` : '';
  }).filter(Boolean);
  if (summary.withheld) parts.push(`${summary.withheld} 个文件内容未显示`);
  if (summary.redactedLines) parts.push(`${summary.redactedLines} 行疑似凭据已隐藏`);
  return parts.join(' · ');
}

function diffMarkup(hunks, root) {
  if (!Array.isArray(hunks) || !hunks.length) return '';
  const sign = { same: ' ', shared: '−', local: '+' }, word = { same: '相同行', shared: '只在共享版本', local: '只在软件内' };
  return hunks.map(hunk => `<div class="extension-compare-hunk" data-compare-hunk><small class="extension-compare-hunk-head">共享版本第 ${Number(hunk.sharedStart) || 0} 行 · 软件内第 ${Number(hunk.localStart) || 0} 行</small><pre class="extension-compare-lines">${(hunk.lines || []).map(line => { const op = sign[line.op] ? line.op : 'same'; return `<span class="extension-compare-line extension-compare-${op}" data-op="${op}"><span class="extension-compare-sign" aria-hidden="true">${sign[op]}</span><span class="extension-visually-hidden">${word[op]}：</span>${esc(shownText(line.text, { root }))}</span>`; }).join('\n')}</pre></div>`).join('');
}

function fileMarkup(file, { root, open }) {
  const status = STATUS[file.status] ? file.status : 'unknown', sizes = file.sharedSize !== undefined || file.localSize !== undefined ? `共享 ${sizeText(file.sharedSize)} · 软件内 ${sizeText(file.localSize)}` : sizeText(file.size);
  const withheld = file.withheld ? `<p class="extension-compare-withheld" data-compare-withheld>${esc(WITHHELD[file.withheld] || '内容不显示')}</p>` : '';
  // 被隐藏的文件不渲染正文：即使响应里带了 diff 也忽略（凭据红线）。
  const body = file.withheld ? '' : diffMarkup(file.diff, root) + (file.diffTruncated ? '<p class="extension-compare-note" data-compare-truncated><small>这个文件的差异很长，只显示了前面一部分。</small></p>' : '');
  const note = file.note ? `<p class="extension-compare-note"><small>${esc(shownText(file.note, { root }))}</small></p>` : '';
  const kinds = status === 'typeDiffers' ? `<p class="extension-compare-note"><small>共享版本里是 ${esc(file.sharedKind || '?')}，软件内是 ${esc(file.localKind || '?')}。</small></p>` : '';
  return `<details class="extension-compare-file" data-compare-file data-status="${status}" ${open ? 'open' : ''}><summary><span class="extension-compare-path">${esc(shownText(file.path, { root }))}</span><span class="extension-compare-status" data-tone="${STATUS_TONE[status]}">${esc(STATUS[status])}</span>${sizes ? `<small class="extension-compare-size">${esc(sizes)}</small>` : ''}</summary>${note}${kinds}${withheld}${body}</details>`;
}

export function compareView(result, { skillName = '', clientName = '', root = '' } = {}) {
  const intro = `<p class="extension-compare-readonly" data-compare-readonly>只读对比：不会改动任何文件。疑似凭据的内容已隐藏，不会显示在这里。</p>`;
  const paths = `<dl class="extension-compare-paths"><dt>共享版本</dt><dd>${esc(shownText(result?.shared?.path, { root }))}</dd><dt>${esc(clientName || '软件内版本')}</dt><dd>${esc(shownText(result?.local?.path, { root }))}${result?.local?.kind ? ` <small>（${esc({ directory: '目录', file: '文件', link: '链接', missing: '不存在', special: '特殊文件' }[result.local.kind] || result.local.kind)}）</small>` : ''}</dd></dl>`;
  if (!result || result.compared === false) {
    const link = result?.localLink ? `<p>链接指向：<code>${esc(shownText(result.localLink, { root }))}</code></p>` : '';
    return `${intro}${paths}<p class="extension-compare-empty" role="status" data-compare-uncompared>${esc(REASON[result?.reason] || '这个位置不能对比。')}</p>${link}`;
  }
  const files = Array.isArray(result.files) ? result.files : [], firstDiff = files.findIndex(file => file.status !== 'same');
  const identical = result.identical === true ? `<p class="extension-compare-empty" role="status" data-compare-identical>两边的内容完全一致，只是软件里是一份独立的副本，不是指向共享版本的链接。</p>` : '';
  const truncated = result.truncated ? `<p class="extension-compare-note" role="status" data-compare-truncated-all>内容很多，只显示了一部分；没有显示的部分没有被比较。</p>` : '';
  const ignored = result.ignored ? `<p class="extension-compare-note"><small>已跳过 ${Number(result.ignored) || 0} 个 .git / node_modules 项。</small></p>` : '';
  const legend = files.some(file => file.diff?.length) ? '<p class="extension-compare-legend"><small>− 只在共享版本里　+ 只在软件内版本里</small></p>' : '';
  return `${intro}${paths}<p class="extension-compare-summary" data-compare-summary>${esc(summaryText(result.summary))}</p>${identical}${truncated}${legend}<div class="extension-compare-files">${files.map((file, index) => fileMarkup(file, { root, open: index === firstDiff })).join('') || '<p>没有文件可对比。</p>'}</div>${ignored}`;
}

// ---- 错误文案（对比 / 处理）----
export function conflictErrorMessage(error, { name = '', clientName = '' } = {}) {
  const where = clientName ? `${clientName} 里的` : '', title = name ? `「${name}」` : '';
  switch (error?.code) {
    case 'EXTENSIONS_VERSION_CONFLICT': return '来源或接入文件在你打开之后变化了，已刷新；请重新打开再试。';
    case 'EXTENSIONS_NOT_CONFLICT': return `${where}${title}已经没有冲突（可能刚被处理或被改动），已刷新。`;
    case 'EXTENSIONS_SKILL_DISABLED': return `${title}已停用，不能接入软件。先启用它，再采用共享版本。`;
    case 'EXTENSIONS_ALREADY_RESOLVED': return `${where}${title}已经保留了软件内版本；内容变化前不会再提示。`;
    case 'EXTENSIONS_NOT_RESOLVED': return `${where}${title}没有「保留软件内版本」的记录，不需要重新处理。`;
    case 'EXTENSIONS_OBJECT_MISSING': return '共享来源里的 Skill 已不可读，不能对比或采用。请重新扫描。';
    default: return error?.message || '冲突处理失败，没有改动任何文件。';
  }
}
// 这些错误说明页面上的数据过时了：自动刷新一次。
export const conflictShouldRefresh = error => ['EXTENSIONS_VERSION_CONFLICT', 'EXTENSIONS_NOT_CONFLICT', 'EXTENSIONS_NOT_RESOLVED', 'EXTENSIONS_ALREADY_RESOLVED'].includes(error?.code);

// 采用 / 保留按钮的置灰原因（总开关有暂存；Skill 已停用只影响采用）。
export function conflictBlock({ masterStaged = false, skillOff = false, resolution = 'keepLocal' } = {}) {
  if (masterStaged) return '已暂存总开关变更，先应用或还原';
  if (skillOff && resolution === 'adoptShared') return '已停用，启用后才能采用共享版本';
  return '';
}
