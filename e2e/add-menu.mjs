// 「添加 ▾」菜单（0.7 PR-8）的 e2e 辅助：新建 Skill / 新建 MCP 服务 / 导入 JSON… / 从文件夹导入… 现在都是这个菜单里的项。
// 兼容旧 UI（没有菜单、各自一个按钮）：旧页面按原按钮名点，所以同一份用例在合入 PR-8 前后都能跑。
const trigger = page => page.locator('[data-add-menu-button]');
const menuItem = (page, label) => page.getByRole('menuitem', { name: `${label}…`, exact: true });
const legacyButton = (page, label) => label === '导入 JSON' ? page.getByRole('button', { name: /导入.*JSON/ }) : page.getByRole('button', { name: label, exact: true });
export const hasAddMenu = async page => (await trigger(page).count()) > 0;
export async function clickAdd(page, label) {
  if (!(await hasAddMenu(page))) { await legacyButton(page, label).click(); return; }
  await trigger(page).click(); await menuItem(page, label).click();
}
// 当前页签「新建」是否被禁用（有 MCP_FORMAT 之类的横幅时）：新 UI 看触发按钮，旧 UI 看原按钮。
export async function addDisabled(page, label) { return (await hasAddMenu(page)) ? trigger(page).isDisabled() : legacyButton(page, label).isDisabled(); }
// 菜单里是否有某一项（不留下打开的菜单）。旧 UI：按钮是否可见。
export async function addItemVisible(page, label) {
  if (!(await hasAddMenu(page))) return legacyButton(page, label).isVisible();
  if (await trigger(page).isDisabled()) return false;
  await trigger(page).click(); const visible = await menuItem(page, label).isVisible(); await page.keyboard.press('Escape'); return visible;
}
