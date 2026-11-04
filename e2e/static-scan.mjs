// L0 static scan over public/ (read-only). P0 blocks; P1 must be explained; counts go into the PR description.
import fs from 'node:fs';
import path from 'node:path';

const vendored = new Set(['purify.js', 'marked.js']), levels = ['P0', 'P1', 'P2', 'P3'];
const isRed = hex => { const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex); if (!m) return false; const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1]; const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); return r > 150 && g < 110 && b < 110 && r - Math.max(g, b) > 70; };
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

export function scanDirectory(root) {
  const files = [];
  (function walk(dir) { for (const name of fs.readdirSync(dir)) { const full = path.join(dir, name); if (fs.statSync(full).isDirectory()) { if (!['node_modules', '.git'].includes(name)) walk(full); } else if (/\.(css|js|mjs|html)$/.test(name) && !vendored.has(name)) files.push(full); } })(root);
  const findings = [], add = (rule, level, file, line, message) => findings.push({ rule, level, file: path.relative(root, file), line, message });
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.css')) {
      for (const block of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = block[1].trim(), body = block[2], line = lineOf(text, block.index + block[1].length);
        if (/background-clip\s*:\s*text/.test(body)) add('AES-gradient-text', 'P1', file, line, '渐变/裁剪文字');
        if (/outline\s*:\s*(none|0)\b/.test(body) && !/:focus/.test(selector)) add('A11Y-outline-none', 'P1', file, line, '移除了 outline 且选择器不含 :focus 系列');
        for (const size of body.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/g)) if (parseFloat(size[1]) < 11) add('TYP-tiny', 'P1', file, line, `字号 ${size[1]}px 小于 11px`);
        if (/border-radius\s*:\s*(50%|9999px|999px)/.test(body)) { const bg = /background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,6})\b/.exec(body); if (bg && isRed(bg[1])) add('AES-red-disc', 'P0', file, line, `红色实心圆形元素 ${bg[1]}（${selector.slice(0, 40)}）`); }
        if (/transition\s*:\s*all\b/.test(body)) add('MOT-transition-all', 'P2', file, line, 'transition: all');
      }
    } else {
      for (const hit of text.matchAll(/sakura|hinomaru|rising-?sun|旭日|樱花|和风|浮世绘|日之丸|asanoha|seigaiha/gi)) add('AES-jp-motif', 'P0', file, lineOf(text, hit.index), `日式意象词 ${hit[0]}`);
      for (const hit of text.matchAll(/<(button|a)\b[^>]*>\s*<svg[^>]*>(?:(?!<\/button>|<\/a>)[\s\S])*?<\/svg>\s*<\/\1>/g)) if (!/aria-label|title=/.test(hit[0]) && !/>[^<\s]/.test(hit[0].replace(/<svg[\s\S]*?<\/svg>/, ''))) add('A11Y-icon-button-name', 'P1', file, lineOf(text, hit.index), '仅含图标的按钮没有可访问名称');
    }
  }
  const byLevel = Object.fromEntries(levels.map(level => [level, findings.filter(item => item.level === level).length]));
  return { filesScanned: files.length, byLevel, findings: findings.sort((a, b) => levels.indexOf(a.level) - levels.indexOf(b.level) || a.file.localeCompare(b.file) || a.line - b.line) };
}

// Token pairing: where a stylesheet has both :root and a dark-scheme block, every token must be defined in both.
// Dark mode is not part of 0.7, so a stylesheet without a dark block passes trivially.
export function tokenPairs(css) {
  const root = new Set([...(/(?:^|\})\s*:root\s*\{([^}]*)\}/.exec(css)?.[1] || '').matchAll(/(--[\w-]+)\s*:/g)].map(item => item[1]));
  const darkBlock = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1];
  if (darkBlock === undefined) return { hasDark: false, missingInDark: [], missingInRoot: [] };
  const dark = new Set([...darkBlock.matchAll(/(--[\w-]+)\s*:/g)].map(item => item[1]));
  return { hasDark: true, missingInDark: [...root].filter(token => !dark.has(token)), missingInRoot: [...dark].filter(token => !root.has(token)) };
}
