# macOS 应用

原生 AppKit + WKWebView 外壳，复用系统 JavaScriptCore 运行任务逻辑。安装包不包含 Electron、Chromium、Node.js、Pi SDK、Codex/Qoder CLI 或个人 skill；窗口标题栏固定为与页面一致的亮色。需要 macOS 13 或更高版本。

构建需要 Node.js 22+、Xcode Command Line Tools（Swift）及 Python 3。Apple Silicon 安装包由 `npm run dist:mac` 生成到 `dist/`。将 DMG 中的 Daylight 拖入 Applications 后启动。任务管理不依赖 Node.js；AI 和反向代理模块需要本机 Node.js 22 或更新版本。当前使用本地 ad-hoc 签名，未配置 Apple Developer ID 签名及公证。

菜单栏显示待办总数，展开可查看今日任务和其他待办，每组最多 8 项，更多任务可打开主窗口查看。任务子菜单支持完成、开始/暂停、加入/移出今天和查看任务。关闭主窗口后继续驻留，菜单栏“退出 Daylight”或 ⌘Q 才退出并停止本地接口。再次启动只激活已有实例。

按 ⌥Space 可全局唤出快速搜索面板：输入关键词后用 Google Chrome 打开 Google 搜索结果页，输入网址（含 `localhost:3000`、`127.0.0.1:4318` 这类本机地址）则直接打开，Chrome 未安装时回退系统默认浏览器。Esc、再次按 ⌥Space 或点击面板外部关闭；快捷键被其他应用占用时，可从菜单栏或“文件”菜单打开。面板使用系统毛玻璃材质，内容由本机服务提供；除你确认打开的搜索或网址外不请求外部网络。

桌面版占用本机 4318 端口。开发网页服务与桌面应用不能同时占用该端口；如提示占用，先停止开发服务。`PORT` 和 `WORKBENCH_DATA_DIR` 可用于隔离验证。


原生服务通过构建生成的 `native-core.js` 加载共享业务与接口契约，不再改写源码的 import/export；具体职责见 [开发说明](development.md#网页与原生共享契约)。原生服务提供 `/api/v1/tasks` 并发布 capabilities.taskQuery，加载与网页相同的 task-view.js 选择器；routes.js 和 AI 上下文模块随资源打包。菜单中使用“未归类”名称。任务与链接契约见 [任务与导航](tasks.md)。重新打包和原生隔离测试不会自动替换 /Applications/Daylight.app。

Pi 模型配置抽屉支持手动上下文、最大输出 Token、扩展思考、图片输入和 thinkingLevelMap。参数保存在 Daylight 的 cli/pi-sync.json，目录刷新与后续同步均保留；保存配置不会直接写入 Pi，手动或已开启的自动同步才会应用。恢复跟随目录可清除覆盖。

构建前执行 `npm ci --ignore-scripts`。`scripts/build-runtime.mjs` 将 Qoder 适配器所需依赖编译为独立模块并保留完整依赖许可证；`scripts/trim-runtime.mjs` 根据浏览器页面和后台进程的依赖图裁剪资源、压缩网页代码。JavaScriptCore 的任务逻辑、动态启动的 MCP 入口及许可证显式保留，安装包不复制 `node_modules`、测试或构建审计报告。构建报告位于 `dist/native/runtime-build.json` 和 `runtime-files.json`，便于检查依赖与资源变化。

原生构建在临时目录完成编译、签名与校验，成功后发布 App；DMG 使用压缩 HFS+ 镜像。清理构建资源不会删除工作台数据或本机 CLI 配置。

## 本地 0.4.0 打包记录

2026-10-03：package.json 与 package-lock.json 版本为 0.4.0，已生成 `dist/native/Daylight.app` 和 `dist/Daylight-0.4.0-arm64.dmg`。App 签名、DMG 校验和及只读挂载后的包内版本均已核验；发布摘要位于本地 `dist/Daylight-0.4.0-release.json`，构建产物不提交 Git。

同日按用户要求完成本地替换：`/Applications/Daylight.app` 为 0.4.0，安装包文件与构建 App 一致，签名核验通过。替换时活动请求为零；旧 App 保存在 `dist/backups/Daylight-0.3.0-replaced-20261003.app`，此前复制的备份 `dist/backups/Daylight-0.3.0-before-0.4.0.app` 也保留。上述路径是本机交付记录，不代表其他机器的安装状态。

安装后原有 3 个项目、10 项任务正常显示，核验的 11 个业务/凭据/来源/代理配置文件摘要未改变；代理按原配置在 4319 端口自动启动。新的统一模型控件已在安装版页面显示。没有以本次安装核验代替真实上游推理回归。

后续替换也需先确认无进行中的请求或获得明确中断授权，再退出旧 App、备份替换、启动并核验数据与运行状态。

同日的对齐 fix 保持 0.4.0：重新生成 App 与同名 DMG，修复自定义来源 API Key 与 API 协议的 16px 错位。宽屏双 Key 控件顶部一致，390px 单列无横向溢出，按钮点击高度仍为 36px。新 DMG 校验及 App 签名通过；本轮只重新打包，已安装 App 仍是前次 0.4.0 构建。
