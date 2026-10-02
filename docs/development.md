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


## 统一任务视图

`public/task-view.js` 统一日期范围、项目、关键词、状态及计数；网页与 Node 直接复用，原生服务加载同一文件到 JavaScriptCore。`public/routes.js` 集中处理新旧 Hash。新增公开接口是 `/api/v1/tasks`，旧业务 schema、actions 和 CLI state 语义不变。AI 关联位于 `ai/context.mjs` 和会话存档，不写入业务 state；导航条件也不写入业务 state。

验证包括 `test/task-view.test.mjs`、Agent API/Skill 集成测试、AI 关联与草稿测试和 `test/native-test.py` 的原生查询契约。使用 WORKBENCH_DATA_DIR 临时目录测试，避免真实任务或会话数据。独立安装的 Skill 需另外更新，改仓库并不等于已安装 Skill 已更新。

Pi 个性化配置：POST /api/cli/pi/configuration 接收 api、expectedVersion、modelOverrides，使用版本保护持久保存，不直接写 Pi 文件。每模型支持 contextWindow、maxTokens、reasoning、input 和 thinkingLevelMap；缺失映射使用目录/Pi 默认，null 表示不支持。GET state 返回 configuration（有效值）及 overrides（用户覆盖）；prepare/apply 可接受覆盖，自动同步复用持久覆盖。

## 中转代码结构

所有中转代码集中在 `proxy/`：`service.js` 负责统一服务，`sidecar.mjs` 是桌面应用的进程入口；`qoder/`、`agy/`、`grok/`、`codex/`、`kimi/`、`custom/` 保存对应来源的适配，`shared/` 保存协议转换、路由、凭据存储和请求记录。新增来源时复用公共服务和前端 `public/proxy.js` 的 `createProviderPage`，只添加来源适配与确有必要的差异。

目录调整只影响源码和打包路径。已有 `/api/qoder` 等管理接口、推理接口以及用户数据目录继续兼容，避免让代码整理触发用户配置迁移。

## 全局界面配置与组件

`public/design-system.css` 是主窗口与快速搜索共用的视觉配置入口。修改 `:root` 中的变量即可调整各模块的字体、行高、留白、页面宽度和控件尺寸；模块通过 `var(...)` 与公共 `ui-*` 布局类复用。字号与对应行高成对调整，段落、字段、折叠区之间的距离使用语义间距变量。

| 配置 | 用途 |
| --- | --- |
| `--font-page-*`、`--font-section-*`、`--font-body-*`、`--font-caption-*` | 页面标题、分区标题、正文与辅助文字的字号和行高 |
| `--space-*`、`--paragraph-gap`、`--section-gap`、`--form-field-gap` | 通用留白、段间距、分区间距与字段间距 |
| `--page-inline`、`--page-max-width`、`--form-reading-width` | 页面共同起点、全屏扩展与表单阅读宽度；页面最大宽度默认 `none` |
| `--form-control-height`、`--button-height`、`--compact-button-height`、`--icon-button-size` | 输入框与下拉框、普通按钮、紧凑按钮及图标按钮的统一尺寸 |

`public/components/button.js` 的 `actionButton` 生成原生按钮，支持 primary、secondary、text、icon、danger 变体；`button.css` 统一按钮、可操作链接、导航与选择控件的外观和交互状态，并兼容现有类名。该样式在各页面样式之后加载。新增操作优先复用这些组件，事件仍使用原来的点击代理、表单提交和键盘行为。

`public/components/section.js` 提供 `sectionHeading`、`disclosureSection` 和 `refreshButton`。折叠标题、说明与刷新在同一操作行，正文共用起点和留白；`mountDisclosures` 保留折叠行为，`setRefreshState` 统一加载状态并保持刷新按钮宽度稳定。来源账号、模型与额度页面共用这套模板。
