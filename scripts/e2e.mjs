#!/usr/bin/env node
// Daylight L2/L3 end-to-end runner (Playwright library API, fixture-v1, isolated temp HOME). See docs/e2e.md.
// Usage: node scripts/e2e.mjs [--grep id-substring] [--widths 760,1240,1440] [--visual]
//                             [--update-baseline --reason "why"] [--list]
// Exit codes: 0 all as expected; 1 unexpected failure / unexpectedly passing expectedFail; 2 browser unavailable (not verified).
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startFixture } from '../e2e/fixture.mjs';
import { E2E_DIR, WIDTHS, loadPlaywright, launchBrowser, newPage, settle, checkBaseline } from '../e2e/harness.mjs';
import cases from '../e2e/cases/index.mjs';

const args = process.argv.slice(2), flag = name => args.includes(name), value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const grep = value('--grep'), widths = (value('--widths') || '').split(',').filter(Boolean).map(Number), update = flag('--update-baseline'), reason = value('--reason'), visual = flag('--visual') || update;
const selected = cases.filter(item => !grep || item.id.includes(grep));
if (flag('--list')) { for (const item of selected) console.log(`${item.id}\t${item.priority}\t${item.expectedFail ? 'expectedFail\t' : ''}${item.title}`); process.exit(0); }
if (update && !reason) { console.error('--update-baseline 必须同时给出 --reason "…"'); process.exit(1); }

const playwright = await loadPlaywright();
if (!playwright) { console.error('未验证：找不到 playwright（可设 DAYLIGHT_PLAYWRIGHT_MODULE）。E2E 未运行。'); process.exit(2); }
let browser; try { browser = await launchBrowser(playwright); } catch (error) { console.error('未验证：无法启动 Chromium（' + error.message.split('\n')[0] + '）。可设 DAYLIGHT_CHROME_EXECUTABLE。'); process.exit(2); }

const results = [], out = path.join(E2E_DIR, '.out');
await fs.mkdir(out, { recursive: true });
let fixtureVersion = '';
try {
  for (const item of selected) for (const width of (widths.length ? widths : item.widths || WIDTHS)) {
    const fixture = await startFixture(); fixtureVersion = fixture.version;
    const label = `${item.id}@${width}`, { context, page, errors, blocked } = await newPage(browser, { url: fixture.url, width });
    const notes = [], visuals = [];
    const shot = async name => { await settle(page); const buffer = await page.screenshot({ animations: 'disabled', caret: 'initial' }); const key = `${item.id}-${name}-${width}`; await fs.writeFile(path.join(out, key + '.png'), buffer); if (visual) visuals.push(await checkBaseline({ name: key, buffer, update, reason })); };
    let outcome = 'pass', detail = '';
    try { await item.run({ page, url: fixture.url, fixture, errors, blocked, width, assert, shot, note: text => notes.push(text) }); }
    catch (error) { outcome = 'fail'; detail = (error.message || String(error)).split('\n').slice(0, 3).join(' | '); }
    for (const check of visuals) if (check.status === 'different') { outcome = 'fail'; detail += ` 视觉差异 ${(check.ratio * 100).toFixed(3)}%`; }
    const status = item.expectedFail ? (outcome === 'fail' ? 'known-fail' : 'unexpected-pass') : outcome;
    results.push({ id: label, priority: item.priority, status, detail, notes, visual: visuals.map(check => check.status), expectedFail: item.expectedFail || null });
    console.log(`${{ pass: 'PASS', fail: 'FAIL', 'known-fail': 'KNOWN', 'unexpected-pass': 'UNEXPECTED-PASS' }[status].padEnd(15)} ${label}  ${status === 'known-fail' ? item.expectedFail + ' ← ' + detail : detail}${notes.length ? '  ' + notes.join('; ') : ''}`);
    await context.close(); await fixture.close();
  }
} finally { await browser.close(); }
await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ fixture: fixtureVersion, results }, null, 2));
const count = status => results.filter(result => result.status === status).length, missing = results.filter(result => result.visual.includes('missing')).length;
console.log(`\n共 ${results.length}：通过 ${count('pass')}，已知缺陷 ${count('known-fail')}，失败 ${count('fail')}，已知缺陷意外通过 ${count('unexpected-pass')}${visual ? `；无基线 ${missing}` : '（未跑视觉比对，加 --visual）'}。报告：${path.relative(process.cwd(), path.join(out, 'report.json'))}`);
process.exit(count('fail') || count('unexpected-pass') ? 1 : 0);
