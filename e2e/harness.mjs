// Browser harness: deterministic context + baseline handling. Library API of Playwright only (no @playwright/test).
import fs from 'node:fs/promises';
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
