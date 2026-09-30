# macOS 应用

原生 AppKit + WKWebView 外壳，复用系统 JavaScriptCore 运行任务逻辑。安装包不包含 Electron、Chromium、Node.js、Pi SDK、Codex/Qoder CLI 或个人 skill；窗口标题栏固定为与页面一致的亮色。需要 macOS 13 或更高版本。

构建需要 Xcode Command Line Tools（Swift）及 Python 3。Apple Silicon 安装包由 `npm run dist:mac` 生成到 `dist/`。将 DMG 中的 Daylight 拖入 Applications 后启动。任务管理不依赖 Node.js；反向代理模块需要本机 Node.js 22 或更新版本。当前使用本地 ad-hoc 签名，未配置 Apple Developer ID 签名及公证。

菜单栏显示待办总数，展开可查看今日任务和其他待办，每组最多 8 项，更多任务可打开主窗口查看。任务子菜单支持完成、开始/暂停、加入/移出今天和查看任务。关闭主窗口后继续驻留，菜单栏“退出 Daylight”或 ⌘Q 才退出并停止本地接口。再次启动只激活已有实例。

按 ⌥Space 可全局唤出快速搜索面板：输入关键词后用 Google Chrome 打开 Google 搜索结果页，输入网址（含 `localhost:3000`、`127.0.0.1:4318` 这类本机地址）则直接打开，Chrome 未安装时回退系统默认浏览器。Esc、再次按 ⌥Space 或点击面板外部关闭；快捷键被其他应用占用时，可从菜单栏或“文件”菜单打开。面板使用系统毛玻璃材质，内容由本机服务提供；除你确认打开的搜索或网址外不请求外部网络。

桌面版占用本机 4318 端口。开发网页服务与桌面应用不能同时占用该端口；如提示占用，先停止开发服务。`PORT` 和 `WORKBENCH_DATA_DIR` 可用于隔离验证。
