# Daylight · 任务管理

本地运行的个人任务管理软件。管理项目、任务、状态和每日安排，层级为项目 → 任务。默认包含用户提供的两个项目、八项原始任务。

所有日常管理操作均可在网页中完成。软件提供本地管理 API；Codex 等外部工具可通过独立 skill 访问该 API，作为可选集成，不改变任务管理软件的主体定位。

## macOS 应用

原生 AppKit + WKWebView 外壳，复用系统 JavaScriptCore 运行任务逻辑。安装包不包含 Electron、Chromium、Node.js、Pi SDK 或外部 skill；窗口标题栏固定为与页面一致的亮色。需要 macOS 13 或更高版本。

构建需要 Xcode Command Line Tools（Swift）及 Python 3。Apple Silicon 安装包由 `npm run dist:mac` 生成到 `dist/`。将 DMG 中的 Daylight 拖入 Applications 后启动，不需要用户安装 Node.js。当前使用本地 ad-hoc 签名，未配置 Apple Developer ID 签名及公证。

菜单栏显示待办总数，展开可查看今日任务和其他待办，每组最多 8 项，更多任务可打开主窗口查看。任务子菜单支持完成、开始/暂停、加入/移出今天和查看任务。关闭主窗口后继续驻留，菜单栏“退出 Daylight”或 ⌘Q 才退出并停止本地接口。再次启动只激活已有实例。

桌面版占用本机 4318 端口。开发网页服务与桌面应用不能同时占用该端口；如提示占用，先停止开发服务。`PORT` 和 `WORKBENCH_DATA_DIR` 可用于隔离验证。

## 网页开发运行

需要 Node.js 22 或更高版本；没有第三方运行依赖，无需 npm install。

```sh
cd /Users/liki/liki_dev/daylight-workbench
npm start
```

访问 http://127.0.0.1:4318 。用 `PORT` 可修改端口，只允许本机访问。

## 已实现

- 今天、收件箱、全部任务、已完成、项目详情。
- 原始两个项目的目录关联与路径复制；新建项目。
- 新增和编辑任务、项目归属、选填备注。
- 加入和移出今天、上下移动顺序、开始或暂停、完成及恢复。
- 全局最多一条进行中任务；开始任务同时加入今天。
- 关键词搜索；⌘/Ctrl K 新建任务，/ 搜索，Escape 关闭对话框。
- 最近一次操作撤销、JSON 导出。
- 本机日期切换时使用新的今日清单，旧的未完成安排可手动重新选入。
- 外部 AI 管理 API，支持项目与任务增改删、显式状态、日期计划、批量原子写入及撤销。
- 外部修改约 3 秒内自动同步到闲置网页；编辑中的表单不被刷新覆盖，保存时校验版本。

## 外部 AI skill

Skill 源文件随本仓库提交，位于 `skills/daylight-workbench/`，独立安装，不进入 App 或 DMG。本机按用户指定安装到 `~/agents/skills/daylight-workbench/`（没有前导点）。不假定所有 AI 宿主自动扫描这个目录，未发现 skill 时请让 AI 读取该目录的 SKILL.md。

安装或同步仓库中的 skill：

```sh
mkdir -p ~/agents/skills
cp -R skills/daylight-workbench ~/agents/skills/
python3 ~/agents/skills/daylight-workbench/scripts/workbench.py capabilities
python3 ~/agents/skills/daylight-workbench/scripts/workbench.py state --view today
```

示例对话：“读取 `~/agents/skills/daylight-workbench/SKILL.md`，把 Flink 推理流代码收尾加入今天。”

Skill 的 config.json 只保存本机地址和路径。服务自动生成权限为 0600 的 数据目录中的 `agent-token`，客户端直接读取，凭证不在 skill、Git 或模型服务中保存。使用其他数据目录或端口时同步修改 config，或传 `--url`、`--data-dir`。本机凭证给予整个工作台的管理权，仅供用户信任的本机 AI 使用。

API 契约见 [skill 接口说明](skills/daylight-workbench/references/api.md)。写接口必须提供 expectedVersion 与 requestId；最近 100 个成功请求可跨重启去重。网络不确定时保留原请求参数重试，冲突时重新读取后判断，不自动覆盖。

API 只管理工作台数据，不执行关联目录中的代码或部署。不需要接入模型账号；现有 AI 使用自身模型与对话上下文。

## 数据

默认写入 `~/Library/Application Support/Daylight/state.json`。网页开发服务和桌面应用使用相同目录。首次启动时，从旧工程 `~/liki_dev/daylight-workbench/.local/` 复制已有数据及 skill 凭证；保留旧文件，不覆盖已有新目录数据。它是本地文件，不依赖浏览器缓存；关闭网页或重启服务后保留。首次启动才写入两项目、八任务，初始待办仅为录入默认值，今天为空。

写入通过临时文件原子替换；数据目录中的 `state.previous.json` 保留上一版成功数据。数据格式异常时停止启动，保留原文件。多窗口使用版本检查；过期写入被拒绝，并在界面加载最新数据，避免覆盖。

`WORKBENCH_DATA_DIR` 可指定数据目录，测试使用临时目录，与真实数据隔离。导出是用户可读的业务数据；尚未提供导入 UI。恢复上一版可停止服务后，将 `state.previous.json` 复制为 `state.json`，再启动。此操作会用上一版替换当前数据，请先保存当前文件副本。

## 复用下拉组件

`public/components/select.js` 导出 `selectField({ name, label, value, options, disabled })`，其中每个选项为 `{ value, label }`。新建和编辑任务共用该组件；后续选择字段可直接复用。样式集中在同目录 `select.css`。

组件以隐藏字段参加原有 FormData 提交；列表作为独立浮层在选择框下方展开，可覆盖后续字段，不撑高表单容器。支持鼠标、方向键、Home/End、Enter/Space 选择，以及 Escape、Tab、外部点击收起；连接和销毁时管理事件监听器。

## 验证命令

```sh
npm run check
npm test
npm run pack:mac
npm run test:native
```

使用 Node 自带测试器验证初始任务、任务操作、跨日安排、引用校验、持久化、重启、写入冲突、请求验证和损坏文件保护。网页开发服务直接提供浏览器原生 ES modules。原生集成测试针对实际 App 二进制，验证相同操作、认证、版本冲突、原子批处理、重启及 Node → 原生的请求去重兼容。

## 本轮边界

工作台不接入 Pi SDK 或模型。外部 AI 按 skill 管理数据，仅在用户要求时在对话中帮助澄清任务。没有执行项目代码、目录扫描或系统提醒。路径绑定只记录和复制目录，不声明已同步仓库进度。该原型并非完整 PRD 的所有功能。
