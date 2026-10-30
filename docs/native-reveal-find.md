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
