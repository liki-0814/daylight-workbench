import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import extensionsP0 from './extensions-p0.mjs';
import extensionsPr1 from './extensions-pr1.mjs';
import extensionsPr3 from './extensions-pr3.mjs';
import extensionsE11 from './extensions-e11.mjs';
import extensionsMcpConflict from './extensions-mcp-conflict.mjs';
import extensionsRevealRestore from './extensions-reveal-restore.mjs';
import extensionsFollowups from './extensions-followups.mjs';
import extensionsPr5 from './extensions-pr5.mjs';
import extensionsPr6 from './extensions-pr6.mjs';
import extensionsPr8 from './extensions-pr8.mjs';
import tasksR1 from './tasks-r1.mjs';
import settingsExtUi from './settings-ext-ui.mjs';
import shellPr4 from './shell-pr4.mjs';
import uiComponents from './ui-components.mjs';

// #29 must stay green on its own (the 0.6.1 UI) and flip by itself once the 0.7 frontend is in the build under test.
// Cases written for Iris's 0.7 frontend are therefore marked expectedFail while the build does not contain it; when it does, the mark
// disappears (nothing to edit), and a case that then fails is a real failure. Detection is by a file/marker the frontend PR adds.
const root = fileURLToPath(new URL('../../', import.meta.url));
const contains = (file, text) => { try { const content = fs.readFileSync(root + file, 'utf8'); return text === undefined || content.includes(text); } catch { return false; } };
const gate = (cases, applies, present, reason) => present ? cases : cases.map(item => applies(item.id) && !item.expectedFail ? { ...item, expectedFail: reason } : item);
const FRONTEND_PR1_PR3 = new Set(['ext-a11y-03', 'ext-sk-16', 'ext-sk-17', 'ext-sk-09', 'ext-mcp-02', 'ext-mcp-03', 'ext-mcp-09']);

export default gate(gate(gate(gate([...extensionsP0, ...extensionsPr1, ...extensionsPr3, ...extensionsE11, ...extensionsMcpConflict, ...extensionsRevealRestore, ...extensionsFollowups, ...extensionsPr5, ...extensionsPr6, ...extensionsPr8, ...settingsExtUi, ...shellPr4, ...uiComponents, ...tasksR1],
  id => FRONTEND_PR1_PR3.has(id) || id.startsWith('ext-pr3-'), contains('public/components/switch.js'),
  '需要 0.7 扩展页前端（PR-1 / PR-3：role=switch、横幅、28px 命中区）：该前端合入后此标记自动消失'),
  id => id.startsWith('shell-pr4-'), contains('public/style.css', 'reduce-transparency'),
  '需要 0.7 外壳前端（PR-4：侧栏三档、52px 工具栏、降低透明度回退）：该前端合入后此标记自动消失'),
  id => id.startsWith('ext-l-'), contains('public/extensions/list.js'),
  '需要 0.7 扩展页清单前端（PR-5：表格、吸顶检查器、roving tabindex）：该前端合入后此标记自动消失'),
  id => id.startsWith('ext-pr6-') || id === 'ext-r13-01', contains('public/extensions/staging.js'),
  '需要 0.7 扩展页 Skills 前端（PR-6：暂存与批量应用、加载可取消、⌘F）：该前端合入后此标记自动消失');
