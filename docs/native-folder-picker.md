# 原生「选择文件夹」（Skill 导入，PR-8）

> 状态：**未验证**。`native/NativeFolderPicker.swift` 在没有 Swift 工具链的环境中写成，只有源码层面的 Node 测试（`test/native-folder-picker.test.mjs`）；必须在 Mac 上 `python3 scripts/build-native.py` 编译并手动试用后才算完成（清单见下）。

## 给前端的接口

| 项 | 值 |
| --- | --- |
| 探测桥是否存在 | `window.webkit?.messageHandlers?.pickFolder`（`undefined` 就是没有：浏览器、旧壳、Launcher 面板） |
| 请求 | `window.webkit.messageHandlers.pickFolder.postMessage({requestId})`，`requestId` 匹配 `^[a-zA-Z0-9_-]{8,100}$`，**不能带别的键** |
| 应答事件 | `window` 上的 `CustomEvent('daylight-folder-picked')`，`event.detail` 如下 |
| 选中 | `{requestId, ok: true, path: "/绝对/路径"}` |
| 取消 | `{requestId, ok: false, cancelled: true}` |
| 出错 | `{requestId, ok: false, error: "中文说明"}`（已经有一个选择窗口打开 / 主窗口不是 key window / 位置无法读取） |

- 每次请求恰好得到一个应答事件（除非请求本身格式不对、来源不对，这时壳**静默忽略**，所以页面要有超时，建议 ≥ 5 分钟，因为用户可能一直开着选择窗口）。用 `requestId` 对应，忽略不是自己发的 id。
- 同一时间只允许一个选择窗口；第二个请求立刻得到 `error`。
- 选择窗口是挂在主窗口上的 sheet：只能选文件夹（`canChooseDirectories`），不能选文件，单选，不能新建文件夹。页面不能指定起始目录或任何选项。
- 页面拿到的 `path` 只是「用户刚刚亲手选的那个文件夹」；它和手动输入的路径一样，仍要走后端 `skill.import` 的路径校验（绝对路径、符号链接、`SKILL.md` 等），前端不要因为来自选择窗口就跳过校验。
- 回退：桥不存在（非 macOS、浏览器里打开、旧壳）时前端显示手动输入路径的文本框；桥存在但应答 `error` 时同样可以让用户改用手动输入。

## 壳里怎么做的

- `NativeFolderPicker`（`WKScriptMessageHandler`，消息名 `pickFolder`）只注册到**主窗口**的 `WKUserContentController`（`main.swift`）；快捷面板（Launcher）没有这个桥。
- 与 `focusNotifications` 相同的来源检查：只处理主 frame、`http://127.0.0.1:<server.port>`、来自主 web view 的消息；`body` 键集合必须恰好是 `["requestId"]`。
- 应答只发给仍在 `http://127.0.0.1:<port>` 的页面（页面已被导航走就丢弃）；路径必须以 `/` 开头且不含 NUL。
- 不菜单化：没有菜单项、没有快捷键。
- 退出时 `stop()` 移除消息处理器。
- 构建：`scripts/build-native.py` 的 swiftc 源文件列表已加入 `NativeFolderPicker.swift`。

## Mac 上的手动检查（未做，已加入 Air 清单）

1. 编译通过（`python3 scripts/build-native.py`），没有警告变错误。
2. 导入 Skill 页点「选择文件夹」→ 出现挂在主窗口上的 sheet，只能选目录；选一个目录后页面显示该绝对路径。
3. 点取消 → 页面回到未选择状态，没有报错。
4. sheet 打开时再触发一次（双击按钮）→ 第二次立刻得到错误提示，不会叠出第二个 sheet。
5. 选择含中文 / 空格的路径、符号链接指向的目录，路径原样回到页面（符号链接不被解析成别的位置——如行为不同，记录下来）。
6. 在浏览器（非原生壳）里打开同一页面 → 只显示手动输入路径。
7. 快捷面板（Launcher）里没有这个桥（`window.webkit.messageHandlers.pickFolder` 为 `undefined`）。
