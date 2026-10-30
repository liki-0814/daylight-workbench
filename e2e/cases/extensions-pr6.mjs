// 0.7 PR-6 (frontend) cases: Skills 暂存 → 预览并应用 → 撤销（ext-pr6-01..04）、总开关（05）、加载可取消（06）、⌘F（07）、行高 R13（ext-r13-01）。
// 全部先要求页面里有暂存栏（[data-staging-bar]）/ 表格清单：在 0.6.1 UI 上会因前置条件失败，所以 index.mjs 的 expectedFail 门控是真实的，不会"空过"。
import fs from 'node:fs/promises';
import path from 'node:path';
import { clickAdd, addDisabled, addItemVisible } from '../add-menu.mjs';

const rows = page => page.locator('.extension-row');
const open = async (page, url, tab = 'skills') => { await page.goto(`${url}/#extensions&tab=${tab}`); await rows(page).first().waitFor({ timeout: 10000 }); };
const needStaging = async page => { if (!await page.locator('[data-staging-bar]').count()) throw new Error('前置条件：页面没有暂存栏（需要 PR-6 前端）'); };
const dialog = page => page.locator('dialog[open]');
const gone = page => page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 8000 }).catch(async () => { throw new Error('对话框没有关闭：' + (await page.locator('dialog[open]').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)); });
const bar = page => page.locator('[data-staging-bar]');
const toggle = (page, label, scope = '.extension-list') => page.locator(scope).getByRole('switch', { name: label, exact: true });
const confirm = async page => { const button = dialog(page).locator('[data-batch-apply]'); await button.waitFor(); if (await button.isDisabled()) throw new Error('应用按钮不可用：' + (await dialog(page).innerText()).replace(/\s+/g, ' ').slice(0, 400)); await button.click(); };
const exists = async file => fs.lstat(file).then(() => true, () => false);
const link = (fixture, client, name) => path.join(fixture.roots[client], client === 'pi' ? 'agent/skills' : 'skills', name);
const stateOf = async fixture => JSON.parse((await fixture.api('/api/extensions/state')).text);
const skillState = async (fixture, id) => (await stateOf(fixture)).skills.find(item => item.name === id);
const toast = page => page.locator('.ui-toast');
// 清单里一次应用：暂存 → 预览并应用 → 等对话框关闭。
const applyStaged = async page => { await bar(page).getByRole('button', { name: '预览并应用', exact: true }).click(); await dialog(page).waitFor(); await confirm(page); await gone(page); };
const mockActions = (page, handler) => page.route(/\/api\/extensions\/actions$/, route => handler(route));

export default [
  { id: 'ext-pr6-01', priority: 'P0', title: '暂存 2 项接入 → 底栏 → 预览是人话 → 应用写入软件目录 → 完成提示可撤销，撤销后回到原状（ext-sk-05）', async run({ page, url, assert: check, fixture }) {
    await open(page, url); await needStaging(page);
    const pi = link(fixture, 'pi', 'review-code'), codex = link(fixture, 'codex', 'review-code');
    check.equal(await bar(page).isVisible(), false, '没有暂存时底栏不显示');
    await toggle(page, 'review-code · Pi').click(); await toggle(page, 'review-code · Codex').click();
    await bar(page).waitFor();
    check.match(await bar(page).innerText(), /2 项待应用的变更/, '底栏显示暂存数量');
    check.equal(await toggle(page, 'review-code · Pi').isChecked(), true, '开关立即显示想要的值');
    check.match(await page.locator('.extension-row', { hasText: 'review-code' }).first().innerText(), /待应用/, '行里有「待应用」标注');
    check.deepEqual([await exists(pi), await exists(codex)], [false, false], '暂存时不写任何文件');
    await bar(page).getByRole('button', { name: '预览并应用', exact: true }).click(); await dialog(page).waitFor();
    check.match(await dialog(page).locator('h2, [role="heading"]').first().innerText(), /应用 2 项变更/, '对话框标题');
    check.equal(await dialog(page).locator('[data-batch-item]').count(), 2, '两项各一行');
    const text = await dialog(page).locator('[data-batch-list]').innerText();
    check.ok(/Pi/.test(text) && /Codex/.test(text) && /review-code/.test(text), '写明是哪个 Skill、哪个软件：' + text);
    check.ok(!/binding\.|skill\.(enable|disable)|actionType|undefined|\[object/.test(text), '预览里没有内部动作名');
    check.deepEqual([await exists(pi), await exists(codex)], [false, false], '预览也不写文件');
    await confirm(page); await gone(page);
    check.deepEqual([await exists(pi), await exists(codex)], [true, true], '应用后两个软件目录里有链接');
    check.equal(await bar(page).isVisible(), false, '应用后底栏消失');
    await toast(page).filter({ hasText: /已/ }).first().waitFor();
    await toast(page).getByRole('button', { name: '撤销', exact: true }).click(); await dialog(page).waitFor();
    check.match(await dialog(page).locator('h2, [role="heading"]').first().innerText(), /撤销/, '撤销也先预览');
    await confirm(page); await gone(page);
    check.deepEqual([await exists(pi), await exists(codex)], [false, false], '撤销后回到应用前');
    check.equal(await toggle(page, 'review-code · Pi').isChecked(), false, '开关回到未接入');
  } },
  { id: 'ext-pr6-02', priority: 'P1', title: '暂存后「还原」恢复且不写文件；切到别的 Tab 再回来，暂存与底栏仍在（ext-sk-06）', async run({ page, url, assert: check, fixture }) {
    await open(page, url); await needStaging(page);
    await toggle(page, 'review-code · Pi').click(); await bar(page).waitFor();
    await page.getByRole('tab', { name: /MCP/ }).click(); await page.waitForFunction(() => location.hash.includes('tab=mcp'));
    check.equal(await bar(page).isVisible(), true, '切到 MCP 时底栏仍提示有未应用的变更');
    await page.getByRole('tab', { name: /Skills/ }).click(); await rows(page).first().waitFor();
    check.equal(await toggle(page, 'review-code · Pi').isChecked(), true, '回到 Skills，暂存值还在');
    await bar(page).getByRole('button', { name: '还原', exact: true }).click();
    check.equal(await bar(page).isVisible(), false, '还原后底栏消失');
    check.equal(await toggle(page, 'review-code · Pi').isChecked(), false, '开关回到原值');
    check.equal(await exists(link(fixture, 'pi', 'review-code')), false, '整个过程没有写文件');
  } },
  { id: 'ext-pr6-03', priority: 'P0', title: '批量应用中途失败：已应用 / 失败 / 未执行逐项显示，只清掉已应用的暂存，已应用的不回滚且仍可撤销', async run({ page, url, assert: check, fixture }) {
    await open(page, url); await needStaging(page);
    let calls = 0;
    await mockActions(page, async route => { calls++; if (calls === 2) await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'EXTENSIONS_VERSION_CONFLICT', error: '扩展内容已经变化，需要重新预览' }) }); else await route.continue(); });
    await toggle(page, 'review-code · Pi').click(); await toggle(page, 'review-code · Codex').click(); await toggle(page, 'ui-copywriting · Pi').click();
    await bar(page).getByRole('button', { name: '预览并应用', exact: true }).click(); await dialog(page).waitFor();
    await confirm(page);
    await page.waitForFunction(() => document.querySelector('[data-batch-item="1"]')?.dataset.status === 'failed');
    const statuses = await dialog(page).locator('[data-batch-item]').evaluateAll(items => items.map(item => item.dataset.status));
    check.deepEqual(statuses, ['done', 'failed', 'skipped'], '第 1 项已应用、第 2 项失败、第 3 项未执行');
    check.match(await dialog(page).locator('[data-batch-summary]').innerText(), /已应用 1 项，2 项未完成/, '汇总');
    check.match(await dialog(page).innerText(), /重新预览/, '失败原因给出来');
    check.equal(await dialog(page).locator('[data-batch-apply]').isVisible(), false, '失败后不再提供原样重试按钮');
    const live = await stateOf(fixture);
    const connected = (skill, client) => live.skills.find(item => item.name === skill).bindings.find(item => item.clientId === client).state;
    check.deepEqual([await exists(link(fixture, 'pi', 'review-code')), await exists(link(fixture, 'codex', 'review-code')), await exists(link(fixture, 'pi', 'ui-copywriting'))], [true, false, false], '只有第 1 项落了盘');
    check.ok(connected('review-code', 'pi') !== 'not_connected', '后端状态与盘一致');
    await dialog(page).locator('[data-batch-cancel]').click(); await gone(page);
    check.match(await bar(page).innerText(), /2 项待应用的变更/, '已应用的暂存被清掉，未完成的 2 项仍在暂存里');
    await toast(page).getByRole('button', { name: '撤销', exact: true }).waitFor();
    await page.unroute(/\/api\/extensions\/actions$/);
    await bar(page).getByRole('button', { name: '还原', exact: true }).click();
    await toast(page).getByRole('button', { name: '撤销', exact: true }).click(); await dialog(page).waitFor(); await confirm(page); await gone(page);
    check.equal(await exists(link(fixture, 'pi', 'review-code')), false, '撤销已应用的那一项后恢复原状');
  } },
  { id: 'ext-pr6-04', priority: 'P0', title: '归档：入口在「危险操作」分组，确认框列出受影响软件、主按钮为红色「归档」，完成后可撤销（ext-sk-11）', async run({ page, url, assert: check, fixture }) {
    await open(page, url); await needStaging(page);
    await toggle(page, 'review-code · Pi').click(); await applyStaged(page);
    await toast(page).first().waitFor();
    await rows(page).filter({ hasText: 'review-code' }).locator('[data-extension-id]').first().click();
    const detail = page.locator('.extension-detail:not([hidden])'); await detail.waitFor();
    const zone = detail.locator('.extension-danger-zone'); await zone.waitFor();
    check.match(await zone.innerText(), /危险操作/, '危险分组标题');
    check.equal(await detail.locator('[data-archive]').count(), 1, '归档入口只有一个');
    check.equal(await zone.locator('[data-archive]').count(), 1, '且在危险分组里');
    await zone.locator('[data-archive]').click(); await dialog(page).waitFor();
    check.match(await dialog(page).locator('[data-archive-affected]').innerText(), /Pi/, '确认框列出受影响的软件');
    const primary = dialog(page).getByRole('button', { name: '归档', exact: true });
    check.match(await primary.getAttribute('class'), /destructive|danger/, '主按钮是危险样式');
    const color = await primary.evaluate(el => getComputedStyle(el).backgroundColor);
    const [r, g, b] = color.match(/\d+/g).map(Number); check.ok(r > g + 40 && r > b + 40, '主按钮是红色：' + color);
    await primary.click(); await gone(page);
    await page.waitForFunction(() => ![...document.querySelectorAll('.extension-row')].some(row => row.textContent.includes('review-code')));
    check.equal(await exists(link(fixture, 'pi', 'review-code')), false, '归档后软件目录里的链接已移除');
    await toast(page).filter({ hasText: '归档' }).getByRole('button', { name: '撤销', exact: true }).click(); await dialog(page).waitFor(); await confirm(page); await gone(page);
    await rows(page).filter({ hasText: 'review-code' }).first().waitFor();
    check.equal(await exists(link(fixture, 'pi', 'review-code')), true, '撤销归档后链接回来');
  } },
  { id: 'ext-pr6-05', priority: 'P1', title: '总开关：停用后软件里的链接移除并记住原绑定，重新启用恢复（ext-sk-12）；与接入开关的暂存互斥', async run({ page, url, assert: check, fixture }) {
    await open(page, url); await needStaging(page);
    await toggle(page, 'review-code · Pi').click(); await toggle(page, 'review-code · Codex').click(); await applyStaged(page);
    const pi = link(fixture, 'pi', 'review-code'), codex = link(fixture, 'codex', 'review-code');
    check.deepEqual([await exists(pi), await exists(codex)], [true, true], '先接入两个软件');
    const master = toggle(page, 'review-code · 启用');
    check.equal(await master.isChecked(), true, '总开关默认开');
    await master.click(); await bar(page).waitFor();
    check.equal(await toggle(page, 'review-code · Pi').isDisabled(), true, '总开关已暂存时，同一 Skill 的接入开关不可再改（互斥）');
    await applyStaged(page);
    check.deepEqual([await exists(pi), await exists(codex)], [false, false], '停用后链接移除');
    const off = await skillState(fixture, 'review-code');
    check.equal(off.enabled, false, '后端状态：已停用'); check.deepEqual([...off.rememberedClientIds].sort(), ['codex', 'pi'], '后端记住了原绑定');
    check.match(await rows(page).filter({ hasText: 'review-code' }).first().innerText(), /停用前接入：.*Pi.*Codex|停用前接入：.*Codex.*Pi/, '行里提示停用前接入了哪些软件');
    check.equal(await toggle(page, 'review-code · Pi').isDisabled(), true, '停用时接入开关不可用');
    await master.click(); await applyStaged(page);
    check.deepEqual([await exists(pi), await exists(codex)], [true, true], '重新启用后恢复原绑定');
    check.equal((await skillState(fixture, 'review-code')).enabled, true, '后端状态：已启用');
  } },
  { id: 'ext-pr6-06', priority: 'P0', title: '加载超过 1 秒可取消：取消后数据与焦点不变、不留半截数据，显示非阻塞「已取消」+「重试」；重试恢复', async run({ page, url, assert: check }) {
    await open(page, url); await needStaging(page);
    let slow = false, late = false;
    await page.route(/\/api\/extensions\/(state|refresh)(\?.*)?$/, async route => {
      if (!slow) return route.continue();
      try { await new Promise(resolve => setTimeout(resolve, 3500)); const response = await route.fetch(), body = await response.json(); body.skills[0].name = 'LATE-ARRIVAL'; late = true; await route.fulfill({ response, json: body }); } catch { /* 请求已被页面取消 */ }
    });
    const before = await rows(page).evaluateAll(list => list.map(row => row.textContent));
    const refresh = page.getByRole('button', { name: '重新扫描扩展', exact: true });
    slow = true; await refresh.focus(); await refresh.click();
    check.equal(await page.locator('[data-cancel-load]').isVisible(), false, '1 秒内不出现取消按钮（不闪）');
    await page.locator('[data-cancel-load]').waitFor({ timeout: 3000 });
    check.equal(await rows(page).count(), before.length, '加载中旧数据仍在');
    await page.locator('[data-cancel-load]').click();
    const banner = page.locator('[data-cancelled-banner]'); await banner.waitFor();
    check.match(await banner.innerText(), /已取消/, '「已取消」'); check.equal(await banner.getByRole('button', { name: '重试', exact: true }).count(), 1, '带「重试」');
    check.equal(await page.locator('[data-cancel-load]').count() ? await page.locator('[data-cancel-load]').isVisible() : false, false, '取消按钮收起');
    check.deepEqual(await rows(page).evaluateAll(list => list.map(row => row.textContent)), before, '数据与取消前完全一致');
    check.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim()), '重新扫描扩展', '焦点回到取消前的位置（刷新按钮）');
    check.equal(await dialog(page).count(), 0, '非阻塞：没有对话框');
    check.equal(await page.evaluate(() => !!document.querySelector('.extension-browser')?.inert), false, '页面没有被置为 inert');
    await page.waitForFunction(() => true); await new Promise(resolve => setTimeout(resolve, 3000));
    check.equal(await page.getByText('LATE-ARRIVAL').count(), 0, '被取消的请求即使迟到也不会写进页面（没有半截数据）');
    slow = false; await banner.getByRole('button', { name: '重试', exact: true }).click();
    await page.locator('[data-cancelled-banner]').waitFor({ state: 'detached' });
    check.equal(await rows(page).count(), before.length, '重试成功后列表正常');
  } },
  { id: 'ext-pr6-07', priority: 'P1', title: '⌘F：window 上的 daylight-find 事件把焦点放到可见搜索框并全选；有对话框时不抢焦点；事件被处理则 dispatchEvent 返回 false', async run({ page, url, assert: check }) {
    await open(page, url); await needStaging(page);
    const find = () => page.evaluate(() => window.dispatchEvent(new CustomEvent('daylight-find', { cancelable: true })));
    const search = page.getByRole('searchbox', { name: '搜索扩展' }).or(page.locator('.extension-search input[type="search"]')).first();
    await search.fill('review'); await page.locator('body').click({ position: { x: 3, y: 3 } });
    check.equal(await search.evaluate(el => document.activeElement === el), false, '前置：搜索框此刻没有焦点');
    check.equal(await find(), false, '页面处理了事件（dispatchEvent 返回 false）');
    check.deepEqual(await search.evaluate(el => ({ focused: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd, length: el.value.length })), { focused: true, start: 0, end: 6, length: 6 }, '焦点在搜索框，内容全选');
    // #38 的原生 ⌘F 发的是不可取消的 `window.dispatchEvent(new CustomEvent('daylight-find'))`：同样要聚焦并全选；派发到 document 且不冒泡的也要收到。
    const focusState = () => search.evaluate(el => ({ focused: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd, length: el.value.length }));
    await page.locator('body').click({ position: { x: 3, y: 3 } });
    check.equal(await search.evaluate(el => document.activeElement === el), false, '前置：再次失焦');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('daylight-find')));
    check.deepEqual(await focusState(), { focused: true, start: 0, end: 6, length: 6 }, '原生 #38 形状（不可取消、派发到 window）也聚焦并全选');
    await page.locator('body').click({ position: { x: 3, y: 3 } });
    check.equal(await search.evaluate(el => document.activeElement === el), false, '前置：再次失焦');
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('daylight-find')));
    check.deepEqual(await focusState(), { focused: true, start: 0, end: 6, length: 6 }, '派发到 document（不冒泡）也聚焦并全选');
    await search.fill(''); await clickAdd(page, '新建 Skill'); await dialog(page).waitFor();
    check.equal(await find(), true, '对话框里没有搜索框：什么都不做（dispatchEvent 返回 true，原生侧可回退）');
    check.equal(await page.evaluate(() => !!document.activeElement?.closest('dialog[open]')), true, '焦点没有被抢出对话框');
    await page.keyboard.press('Escape'); await gone(page);
  } },
  { id: 'ext-r13-01', priority: 'P0', title: 'R13 行高：清单行 min-height 56px（计算样式 + 实测高度），行内打开按钮 ≥ 44px；三种宽度、Skills / MCP / 接入软件', async run({ page, url, assert: check }) {
    await open(page, url); if (!await page.locator('.extension-table').count()) throw new Error('前置条件：需要 0.7 表格清单（PR-5）');
    for (const tab of ['skills', 'mcp', 'clients']) {
      await open(page, url, tab);
      const result = await page.evaluate(() => [...document.querySelectorAll('.extension-row')].map(row => { const open = row.querySelector('.extension-row-open'), style = getComputedStyle(row); return { height: row.getBoundingClientRect().height, min: parseFloat(style.minHeight), open: open ? open.getBoundingClientRect().height : null, text: row.textContent.trim().slice(0, 24) }; }));
      check.ok(result.length > 0, tab + '：有行');
      for (const row of result) {
        check.ok(row.min >= 56, `${tab} / ${row.text}：计算 min-height ${row.min} < 56`);
        check.ok(row.height >= 55.5, `${tab} / ${row.text}：实测行高 ${row.height} < 56`);
        if (row.open !== null) check.ok(row.open >= 43.5, `${tab} / ${row.text}：打开按钮高度 ${row.open} < 44`);
      }
    }
  } },
];
