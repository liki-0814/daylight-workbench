// Browser harness: deterministic context + baseline handling. Library API of Playwright only (no @playwright/test).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePng, encodePng } from './png.mjs';

export const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
export const WIDTHS = [760, 1240, 1440], HEIGHT = 900;
export const FROZEN_TIME = '2026-10-30T10:00:00+08:00';

export async function loadPlaywright() {
  try { return await import(process.env.DAYLIGHT_PLAYWRIGHT_MODULE || 'playwright'); } catch { return null; }
}
export const launchBrowser = playwright => playwright.chromium.launch({ headless: true, args: ['--no-sandbox', '--font-render-hinting=none', '--disable-lcd-text'], ...(process.env.DAYLIGHT_CHROME_EXECUTABLE ? { executablePath: process.env.DAYLIGHT_CHROME_EXECUTABLE } : {}) });

// Fixed viewport, scale 1, light, reduced motion, zh-CN, Asia/Shanghai, frozen clock; everything except the local server is blocked.
export async function newPage(browser, { url, width }) {
  const context = await browser.newContext({ viewport: { width, height: HEIGHT }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce', locale: 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
  const origin = new URL(url).origin, blocked = [];
  await context.route('**/*', route => { const target = route.request().url(); if (target.startsWith(origin) || target.startsWith('data:') || target.startsWith('blob:')) return route.continue(); blocked.push(target); return route.abort(); });
  const page = await context.newPage();
  await page.clock.install({ time: new Date(FROZEN_TIME) });
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => message.type() === 'error' && !/Failed to load resource/.test(message.text()) && errors.push('console: ' + message.text()));
  return { context, page, errors, blocked };
}
// The app's CSP forbids injected styles, so motion is frozen via reducedMotion + screenshot({animations:'disabled'}).
export const settle = async page => { await page.evaluate(() => document.fonts.ready); };

// 视觉比对时只盖「带本机路径的文字行」：路径里有 worktree 目录名和 mkdtemp 随机后缀，换目录就会出 0.05–0.16% 的单行差异。
// 只用 selector（不改前端、不加 data 属性）；盖的是一行文字，不是整块。新增带路径的界面要往这里加，漏了会被 uncoveredPathText 抓到。
export const PATH_MASK_SELECTORS = [
  '.extension-row-command',          // MCP 表：命令行 / HTTP 地址（含 worktree 路径）
  '.extension-source',               // Skill 检查器：共享来源 / 软件本地来源路径（含 mkdtemp 后缀）
  '[data-config-path]',              // 配置问题横幅里的文件路径
  '.extension-compare-path',         // 对比弹窗：逐文件路径
  '.extension-compare-paths dd',     // 对比弹窗：共享版本 / 软件内版本路径
];
export const PATH_MASK_COLOR = '#808080';
export const PATH_NEEDLES = [path.join(os.tmpdir(), 'daylight-e2e'), path.resolve(E2E_DIR, '..')];
export const maskLocators = page => PATH_MASK_SELECTORS.map(selector => page.locator(selector));
// 返回页面上「含路径文字、却不在任何 mask selector 里」的元素摘要（空数组 = 全部已覆盖）。
export const uncoveredPathText = page => page.evaluate(({ selectors, needles }) => {
  const join = selectors.join(','), found = [];
  for (const element of document.body.querySelectorAll('*')) {
    if (element.closest('script,style') || !element.getClientRects().length) continue;
    const own = [...element.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('');
    if (needles.some(needle => own.includes(needle)) && !element.closest(join)) found.push(`${element.tagName.toLowerCase()}${element.className ? '.' + String(element.className).trim().split(/\s+/).join('.') : ''}：${own.trim().slice(0, 60)}`);
  }
  return found;
}, { selectors: PATH_MASK_SELECTORS, needles: PATH_NEEDLES });

// Baseline policy: a baseline changes only with --update-baseline --reason "…", and the reason is written to baselines/CHANGES.md.
export async function checkBaseline({ name, buffer, update, reason, baselineDir = path.join(E2E_DIR, 'baselines'), outDir = path.join(E2E_DIR, '.out') }) {
  const file = path.join(baselineDir, name + '.png');
  await fs.mkdir(outDir, { recursive: true });
  if (update) {
    if (!reason) throw new Error('--update-baseline 必须同时给出 --reason "…"');
    await fs.mkdir(baselineDir, { recursive: true }); await fs.writeFile(file, buffer);
    await fs.appendFile(path.join(baselineDir, 'CHANGES.md'), `- ${FROZEN_TIME.slice(0, 10)} \`${name}\`：${reason}\n`);
    return { status: 'updated' };
  }
  const expected = await fs.readFile(file).catch(() => null);
  if (!expected) return { status: 'missing' };
  const result = comparePng(expected, buffer);
  if (result.same) return { status: 'same', ratio: result.ratio };
  await fs.writeFile(path.join(outDir, name + '.actual.png'), buffer);
  if (result.diff) await fs.writeFile(path.join(outDir, name + '.diff.png'), encodePng(result.diff));
  return { status: 'different', ratio: result.ratio, reason: result.reason };
}
