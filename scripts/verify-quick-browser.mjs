// Isolated quick-palette acceptance; model replies are synthetic.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTaskWorkbench, closeWorkbench } from '../fixtures/workbench.mjs';
const { chromium } = await import(process.env.DAYLIGHT_PLAYWRIGHT_MODULE || 'playwright');
const dir = await mkdtemp(path.join(os.tmpdir(), 'daylight-quick-browser-'));
const output = path.resolve(process.argv[2] || '.local/verification/quick'); await mkdir(output, { recursive: true });
const server = await createTaskWorkbench(dir); await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser, count = 0, polls = 0, cancels = 0, state = 'done', gate;
const checks = [], errors = [];
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 720, height: 650 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/api/ai/quick**', async route => {
    assert(route.request().headers()['x-workbench-token'], 'quick requests must authenticate to the workbench');
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/cancel')) { cancels++; return route.fulfill({ json: { ok: true } }); }
    if (route.request().method() === 'POST') {
      count++; polls = 0;
      if (gate) await gate.promise;
      return route.fulfill({ json: { id: 'fixture-' + count, backend: 'qoder', model: 'DeepSeek-Flash' } });
    }
    polls++;
    return route.fulfill({ json: { status: state, text: state === 'error' ? '' : polls === 1 ? '正在写答案' : '## 临时回答\n\n只回答这一轮。\n\n```js\nconst answer = 42;\n```\n\n[参考](https://example.com)', error: state === 'error' ? '模拟模型不可用' : '' } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/quick.html`);
  const input = page.getByRole('textbox'), ai = page.getByRole('radio', { name: 'AI 问答' }), google = page.getByRole('radio', { name: 'Google' });
  await ai.waitFor(); assert.equal(await ai.getAttribute('aria-checked'), 'true');
  await input.press('ArrowRight'); assert.equal(await google.getAttribute('aria-checked'), 'true');
  assert(await input.evaluate(element => element === document.activeElement));
  await input.press('ArrowLeft'); assert.equal(await ai.getAttribute('aria-checked'), 'true');
  assert(await input.evaluate(element => element === document.activeElement));
  await input.fill('abc'); await input.press('Home'); await input.press('ArrowRight');
  assert.equal(await input.evaluate(element => element.selectionStart), 1);
  assert.equal(await input.inputValue(), 'abc'); assert.equal(await ai.getAttribute('aria-checked'), 'true');
  await input.fill(' '); await input.press('ArrowRight'); assert.equal(await input.inputValue(), ' ');
  assert.equal(await ai.getAttribute('aria-checked'), 'true');
  await input.fill('');
  for (const key of ['Shift+ArrowRight', 'Alt+ArrowRight', 'Control+ArrowRight', 'Meta+ArrowRight']) {
    await input.press(key); assert.equal(await ai.getAttribute('aria-checked'), 'true');
  }
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
    await input.dispatchEvent('keydown', { key: 'ArrowRight', bubbles: true, ...extra });
    assert.equal(await ai.getAttribute('aria-checked'), 'true');
  }
  checks.push('empty input switches modes with arrows and retains focus; text, modifiers, IME and held keys are preserved');
  state = 'running'; await input.fill('解释一下 42'); await input.press('Enter');
  await page.getByRole('status').getByText('正在回答…').waitFor();
  assert.equal(await input.getAttribute('readonly'), '');
  await input.press('Enter'); assert.equal(count, 1);
  state = 'done'; await page.getByText('回答完成 · 关闭即清空', { exact: true }).waitFor();
  await page.getByRole('heading', { name: '临时回答' }).waitFor();
  await page.getByRole('button', { name: '复制回答' }).click();
  assert((await page.evaluate(() => navigator.clipboard.readText())).includes('const answer = 42;'));
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  checks.push('single turn streams formatted answer, copies text, and writes no browser storage');
  await page.screenshot({ path: path.join(output, 'answer-wide.png') });
  await page.keyboard.press('Escape'); assert.equal(await input.inputValue(), '');
  assert.equal(await page.locator('#quick-answer').textContent(), ''); assert(await page.locator('#quick-result').isHidden());
  await input.fill('new question'); await input.press('Enter'); await page.getByText('回答完成 · 关闭即清空', { exact: true }).waitFor();
  assert.equal(count, 2); checks.push('Escape clears all content and next invocation is independent');
  await page.evaluate(() => window.quickReset()); state = 'running'; await input.fill('cancel me'); await input.press('Enter');
  await page.getByRole('status').getByText('正在回答…').waitFor();
  await page.evaluate(() => window.quickDismiss()); await page.waitForFunction(() => document.querySelector('#quick-answer').textContent === '');
  await page.waitForTimeout(400); assert(cancels > 0); assert.equal(await input.inputValue(), '');
  checks.push('native dismissal cancels active generation and prevents late answer restoration');
  gate = Promise.withResolvers(); await input.fill('slow start'); await input.press('Enter'); await page.getByText('正在连接 AI…', { exact: true }).waitFor();
  await page.evaluate(() => window.quickDismiss()); gate.resolve(); gate = null;
  await page.waitForTimeout(400); assert(cancels >= 2); assert(await page.locator('#quick-result').isHidden());
  checks.push('dismissal during request creation cancels late start response');
  state = 'error'; await input.fill('failure'); await input.press('Enter'); await page.getByText('模拟模型不可用').waitFor();
  await page.evaluate(() => window.quickReset()); state = 'done';
  checks.push('provider failure is visible and cleared on next invocation');
  await google.focus(); await page.keyboard.press('ArrowLeft'); assert.equal(await ai.getAttribute('aria-checked'), 'true');
  await ai.focus(); await page.keyboard.press('ArrowRight'); assert.equal(await google.getAttribute('aria-checked'), 'true');
  await page.evaluate(() => { window.open = url => { window.openedURL = url; }; });
  await input.fill('Google 搜索'); await input.press('Enter');
  assert.equal(new URL(await page.evaluate(() => window.openedURL)).searchParams.get('q'), 'Google 搜索');
  await input.fill('example.com'); await input.press('Enter'); assert.equal(await page.evaluate(() => window.openedURL), 'https://example.com');
  checks.push('shared mode control supports arrow keys; Google searches and URL opening remain available');
  for (const width of [720, 390]) {
    await page.setViewportSize({ width, height: 650 });
    await page.screenshot({ path: path.join(output, `search-${width}.png`) });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await ai.click(); await input.fill('narrow answer'); await input.press('Enter'); await page.getByText('回答完成 · 关闭即清空', { exact: true }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(output, `answer-${width}.png`) }); await google.click();
  }
  checks.push('search and answer modes fit wide and narrow windows without horizontal overflow');
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, errors, output }));
} finally { gate?.resolve(); await browser?.close(); await closeWorkbench(server); await rm(dir, { recursive: true, force: true }); }
