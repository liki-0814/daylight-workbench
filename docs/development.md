# 开发说明

## 数据存储

默认写入 `~/Library/Application Support/Daylight/state.json`。网页开发服务和桌面应用使用相同目录。首次启动时，从旧工程 `~/liki_dev/daylight-workbench/.local/` 复制已有数据及 skill 凭证；保留旧文件，不覆盖已有新目录数据。它是本地文件，不依赖浏览器缓存；关闭网页或重启服务后保留。没有已有数据时，初始化为空项目、空任务和空日程；安装包不包含个人项目或任务。

写入通过临时文件原子替换；数据目录中的 `state.previous.json` 保留上一版成功数据。数据格式异常时停止启动，保留原文件。多窗口使用版本检查；过期写入被拒绝，并在界面加载最新数据，避免覆盖。

`WORKBENCH_DATA_DIR` 可指定数据目录，测试使用临时目录，与真实数据隔离。导出是用户可读的业务数据；尚未提供导入 UI。恢复上一版可停止服务后，将 `state.previous.json` 复制为 `state.json`，再启动。此操作会用上一版替换当前数据，请先保存当前文件副本。

## 外部 AI skill

Skill 源文件随本仓库提交，位于 `skills/daylight-workbench/`，独立安装，不进入 App 或 DMG。本机按用户指定安装到 `~/agents/skills/daylight-workbench/`（没有前导点）。不假定所有 AI 宿主自动扫描这个目录，未发现 skill 时请让 AI 读取该目录的 SKILL.md。

安装或同步仓库中的 skill：

```sh
mkdir -p ~/agents/skills
cp -R skills/daylight-workbench ~/agents/skills/
python3 ~/agents/skills/daylight-workbench/scripts/workbench.py capabilities
python3 ~/agents/skills/daylight-workbench/scripts/workbench.py state --view today
```

示例对话：“读取 `~/agents/skills/daylight-workbench/SKILL.md`，把代码审查加入今天。”

Skill 的 config.json 只保存本机地址和路径。服务自动生成权限为 0600 的 数据目录中的 `agent-token`，客户端直接读取，凭证不在 skill、Git 或模型服务中保存。使用其他数据目录或端口时同步修改 config，或传 `--url`、`--data-dir`。本机凭证给予整个工作台的管理权，仅供用户信任的本机 AI 使用。

API 契约见 [skill 接口说明](../skills/daylight-workbench/references/api.md)。写接口必须提供 expectedVersion 与 requestId；最近 100 个成功请求可跨重启去重。网络不确定时保留原请求参数重试，冲突时重新读取后判断，不自动覆盖。

API 只管理工作台数据，不执行关联目录中的代码或部署。不需要接入模型账号；现有 AI 使用自身模型与对话上下文。

## 下拉组件

`public/components/select.js` 导出 `selectField({ name, label, value, options, disabled })`，其中每个选项为 `{ value, label }`。新建和编辑任务共用该组件；后续选择字段可直接复用。样式集中在同目录 `select.css`。

组件以隐藏字段参加原有 FormData 提交；列表作为独立浮层在选择框下方展开，可覆盖后续字段，不撑高表单容器。支持鼠标、方向键、Home/End、Enter/Space 选择，以及 Escape、Tab、外部点击收起；连接和销毁时管理事件监听器。
