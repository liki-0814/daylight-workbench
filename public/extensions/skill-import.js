// 扩展页「从文件夹导入 Skill」（0.7 PR-8）：纯函数，无 DOM；对话框、焦点、请求都在 page.js。
// 一次只导入一个 Skill 文件夹（skill.import + sourcePath）；多个 Skill / 父文件夹不在范围内。
// 后端契约：api-contract-skill-enable.md §C：绝对路径、目录名取 SKILL.md 的 name、同名不覆盖（409 EXTENSIONS_CONFLICT）、
// 400 的 field 恒为 sourcePath，code 之一 EXTENSIONS_IMPORT_*。前端的校验只为尽早给出看得懂的提示，是否合法以后端为准。

export const SOURCE_PATH_MAX = 4096;
const EXAMPLE = '例如 /Users/你的名字/skills/my-skill';

// 手输路径校验：去掉首尾空格；拒绝空、~ 开头、相对路径、含 . / .. 段、控制字符、根目录。成功返回规整后的路径（去掉末尾的 /）。
export function validateSourcePath(value) {
  const path = String(value ?? '').trim();
  const fail = message => ({ ok: false, message });
  if (!path) return fail('请填写 Skill 文件夹的完整路径。' + EXAMPLE + '。');
  if (/[\0\r\n]/.test(path)) return fail('路径里不能有换行或不可见字符，请重新输入。');
  if (path.startsWith('~')) return fail('不支持以 ~ 开头的路径，请写完整路径。' + EXAMPLE + '。');
  if (!path.startsWith('/')) return fail('需要完整路径（以 / 开头），不能是相对路径。' + EXAMPLE + '。');
  if (path.length > SOURCE_PATH_MAX) return fail(`路径太长（最多 ${SOURCE_PATH_MAX} 个字符）。`);
  const normalized = path.replace(/\/+$/, '');
  if (!normalized) return fail('请选择具体的 Skill 文件夹，不能是根目录。');
  if (normalized.split('/').some(part => part === '.' || part === '..')) return fail('路径里不能含 . 或 .. ，请写完整路径。' + EXAMPLE + '。');
  return { ok: true, path: normalized };
}

// 状态：idle 空闲 / picking 正在选文件夹 / previewing 正在预览 / ready 可导入 / conflict 同名冲突（不能导入）/ importing 导入中 / failed 失败。
// 成功后对话框关闭并出回执，没有「done」常驻状态。
export const IMPORT_PHASES = Object.freeze(['idle', 'picking', 'previewing', 'ready', 'conflict', 'importing', 'failed']);
export function importPhaseView(phase, { pickerAvailable = false } = {}) {
  const busy = phase === 'picking' || phase === 'previewing' || phase === 'importing';
  return {
    busy,
    canEditPath: !busy,
    canPick: pickerAvailable && !busy,                      // 选择进行中也禁用，防重复发请求
    canPreview: !busy,
    canApply: phase === 'ready',                            // 冲突时不能导入（后端也不会覆盖）
    status: ({ picking: '正在等待你选择文件夹…', previewing: '正在读取文件夹…', importing: '正在导入…' })[phase] || '',
  };
}

// 失败：后端 400 的 field 恒为 sourcePath（路径问题 → 挂在路径框下）；其余（版本变化、写入失败等）放在对话框提示里。
export function importFailure(error) {
  const code = error?.code || '';
  if (code === 'EXTENSIONS_VERSION_CONFLICT') return { field: null, message: '配置在你打开之后变化了，已刷新；请重新预览。' };
  const message = error?.message || '导入失败，没有改动任何文件。';
  return { field: error?.field === 'sourcePath' ? 'sourcePath' : null, message };
}

// 同名冲突：后端把冲突放在 plan.conflicts（字符串），不覆盖；这里只在 plan 里有冲突时才进入 conflict 状态。
export const importHasConflict = plan => Array.isArray(plan?.conflicts) && plan.conflicts.length > 0;
export const importConflictNote = '这个文件夹里的 Skill 与已有的同名，导入不会覆盖。请先归档已有的 Skill，或换一个文件夹后再预览。';

export const importedSkillMessage = name => `已导入 Skill${name ? `「${name}」` : ''}`;
export const importDialogIntro = ({ pickerAvailable }) => `<p>从本机一个文件夹复制 Skill 到共享来源；文件夹顶层需要有 <code>SKILL.md</code>，来源文件夹不会被修改。一次只导入一个。${pickerAvailable ? '可以点「选择文件夹…」，也可以直接输入完整路径。' : '请输入文件夹的完整路径。'}</p>`;
export const sourcePathLabel = 'Skill 文件夹路径';
export const sourcePathHint = `完整路径，以 / 开头。${EXAMPLE}`;
