# 原生「在访达中显示」与 ⌘F 查找菜单

> 状态：**未验证**。此分支的 Swift 代码在没有 Swift 工具链的环境中写成，只有源码层面的 Node 测试（`test/native-reveal-find.test.mjs`）；必须在 Mac 上 `python3 scripts/build-native.py` 编译并手动试用后才算完成。

## 在访达中显示（NSWorkspace）

- 路径始终由服务端解析：页面只发 `{kind:"skill", id}` / `{kind:"mcpConfig"}` / `{kind:"client", clientId}`，见 [本地扩展管理](extensions.md) §H。
- 扩展服务运行在 AI helper（`ai/sidecar.mjs`）里。原生壳启动该 helper 时设置 `DAYLIGHT_REVEAL=native`（`Proxy.swift`），helper 因此不执行 `open -R`，而是回复 `{ok:true, hostReveal:"<绝对路径>"}`。
- `Server.swift` 只对 AI helper 的 `POST /api/extensions/reveal` 调用 `NativeReveal.finish`（`NativeReveal.swift`）：先从回复里**删除** `hostReveal`（页面始终只看到 `{ok:true}`），再对绝对路径、不含 NUL、确实存在的路径调用 `NSWorkspace.shared.activateFileViewerSelecting([url])`；其它情况回 500 `EXTENSIONS_REVEAL_FAILED`，不回显路径。
- 兼容：旧壳 + 新 helper（环境变量缺失）继续用 `open -R`；新壳 + 旧 helper（忽略变量）也继续用 `open -R`，回复里没有 `hostReveal` 时原样透传。
- Agent 接口 `/api/v1/extensions/reveal` 仍是 404，不受影响。

## 编辑 › 查找 › 查找…（⌘F）

- `main.swift` 在「编辑」菜单末尾加分隔线和「查找」子菜单，内含「查找…」，快捷键 ⌘F。
- 只在主窗口是 key window 时，向主 WKWebView 执行 `window.dispatchEvent(new CustomEvent('daylight-find'))`；快捷面板（Launcher）的 web view 不会收到。
- 页面侧监听 `daylight-find` 并聚焦当前页的 search-field 由前端实现；本分支不改 `public/`。

### ⌘F 与扩展页自己的 ⌘F（keydown）会不会重复处理

结论：**不会重复处理，两条路径都是安全的，Swift 一侧无需改动**（2026-10-30 审查；运行时行为仍须在 Mac 上手动确认，见下方清单）。

- 事件顺序：⌘F 的 keyDown 先到 key window 的视图层级（`WKWebView.performKeyEquivalent`），**网页的 `keydown` 先执行**；网页没有 `preventDefault()` 时才轮到主菜单的「查找…」。壳里没有 `performKeyEquivalent` 覆盖，也没有 `NSEvent` 本地监视器抢先处理 ⌘F（`test/native-reveal-find.test.mjs` 固定了这一点）。
- 扩展页（`public/extensions/page.js`，PR-6 / #39）的 `keydown` 处理：页面可见、无打开的对话框时，若找到可见搜索框就聚焦并全选，**并 `preventDefault()`**——WKWebView 视为已处理，菜单项不再触发（只处理一次）；没有可见搜索框则不 `preventDefault()`，菜单触发 `daylight-find`，网页侧再找一次，同样找不到，什么都不做（决定：没有搜索框时不回退到系统查找）。
- 即使两条路径都触发（例如以后某个 macOS 版本改变分发顺序）：网页里的 `keydown` 处理与 `daylight-find` 监听用同一个函数（`focusVisibleSearchField`），对同一个输入框重复「聚焦 + 全选」是幂等的；有对话框时只有 `daylight-find` 路径会在对话框内查找，`keydown` 路径直接返回，所以也不会互相抢焦点。
- `daylight-find` 是**不可取消、不冒泡**的事件（`new CustomEvent('daylight-find')`，没有选项）；网页不能依赖 `dispatchEvent` 的返回值，监听器在 `window` 的捕获阶段（#39，`7eeadb0`）。
- 只在主窗口是 key window 时才派发：快捷面板（Launcher）是 key window 时，⌘F 的菜单项因 `guard` 什么都不做，网页不会收到事件。

Mac 上的手动检查（未做）：扩展页有搜索框时按 ⌘F，焦点进搜索框并全选，只发生一次；搜索框被隐藏（如详情页覆盖清单的窄窗口）时按 ⌘F 无任何反应（不弹系统查找）；有打开的对话框且对话框里有搜索框时，焦点只进对话框；快捷面板打开时按 ⌘F，主窗口不受影响。
