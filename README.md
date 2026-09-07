# Daylight · 个人工作台

本地网页原型。使用用户提供的两个项目、八项原始任务，项目 → 任务，不进一步拆分，不调用 AI。

对话入口由本机 Codex 等外部 AI 提供。工作台不内嵌模型或 Pi SDK，通过本地管理 API 与独立 skill 连接外部 AI。

## 运行

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

Skill 源文件随本仓库提交，位于 `skills/daylight-workbench/`。本机按用户指定安装到 `~/agents/skills/daylight-workbench/`（没有前导点）。不假定所有 AI 宿主自动扫描这个目录，未发现 skill 时请让 AI 读取该目录的 SKILL.md。

安装或同步仓库中的 skill：

```sh
mkdir -p ~/agents/skills
cp -R skills/daylight-workbench ~/agents/skills/
python3 ~/agents/skills/daylight-workbench/scripts/workbench.py capabilities
python3 ~/agents/skills/daylight-workbench/scripts/workbench.py state --view today
```

示例对话：“读取 `~/agents/skills/daylight-workbench/SKILL.md`，把 Flink 推理流代码收尾加入今天。”

Skill 的 config.json 只保存本机地址和路径。服务自动生成权限为 0600 的 `.local/agent-token`，客户端直接读取，凭证不在 skill、Git 或模型服务中保存。使用其他数据目录或端口时同步修改 config，或传 `--url`、`--data-dir`。本机凭证给予整个工作台的管理权，仅供用户信任的本机 AI 使用。

API 契约见 [skill 接口说明](skills/daylight-workbench/references/api.md)。写接口必须提供 expectedVersion 与 requestId；最近 100 个成功请求可跨重启去重。网络不确定时保留原请求参数重试，冲突时重新读取后判断，不自动覆盖。

API 只管理工作台数据，不执行关联目录中的代码或部署。不需要接入模型账号；现有 AI 使用自身模型与对话上下文。

## 数据

默认写入本工程 `.local/state.json`。它是本地文件，不依赖浏览器缓存；关闭网页或重启服务后保留。首次启动才写入两项目、八任务，初始待办仅为录入默认值，今天为空。

写入通过临时文件原子替换；`.local/state.previous.json` 保留上一版成功数据。数据格式异常时停止启动，保留原文件。多窗口使用版本检查；过期写入被拒绝，并在界面加载最新数据，避免覆盖。

`WORKBENCH_DATA_DIR` 可指定数据目录，测试使用临时目录，与真实数据隔离。导出是用户可读的业务数据；尚未提供导入 UI。恢复上一版可停止服务后，将 `state.previous.json` 复制为 `state.json`，再启动。此操作会用上一版替换当前数据，请先保存当前文件副本。

## 复用下拉组件

`public/components/select.js` 导出 `selectField({ name, label, value, options, disabled })`，其中每个选项为 `{ value, label }`。新建和编辑任务共用该组件；后续选择字段可直接复用。样式集中在同目录 `select.css`。

组件以隐藏字段参加原有 FormData 提交；列表在选择框下方占据布局空间，不覆盖选择框或后续字段。支持鼠标、方向键、Home/End、Enter/Space 选择，以及 Escape、Tab、外部点击收起；连接和销毁时管理事件监听器。

## 验证命令

```sh
npm run check
npm test
```

使用 Node 自带测试器验证初始任务、任务操作、跨日安排、引用校验、持久化、重启、写入冲突、请求验证和损坏文件保护。不需要构建步骤，服务直接提供浏览器原生 ES modules。

## 本轮边界

工作台不接入 Pi SDK 或模型。外部 AI 按 skill 管理数据，仅在用户要求时在对话中帮助澄清任务。没有执行项目代码、目录扫描、提醒、DMG 或菜单栏。路径绑定只记录和复制目录，不声明已同步仓库进度。该原型并非完整 PRD 的所有功能。
