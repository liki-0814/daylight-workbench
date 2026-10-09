# 开发说明

Web 调试直接使用 `PORT=4328 WORKBENCH_DATA_DIR="$PWD/.local/web-dev" npm run dev`，不依赖 App 或 dist；前端修改刷新生效，后端由 Node watch 重启。`npm run dev:debug` 增加仅本机的 9229 断点入口。普通启动用 `npm run web` 自动打开浏览器。入口均复用 server.mjs 和本机 CLI 适配器，默认数据、CLI 登录和扩展主来源保持现有规则；隔离业务目录不自动隔离扩展写入。

`npm run test:web-cli` 使用隔离业务/扩展/客户端目录，通过真正 `npm run web -- --no-open` 启动并检测本机 Codex/Qoder 模型，不执行推理，隔离 Daylight 管理写入；CLI 自身的认证和缓存遵循其原生规则。需本机已安装并登录 CLI，不属于离线 Node 单元测试。启动、端口冲突、浏览器时机和停止/重启覆盖在 test/web.test.mjs。

## 数据存储

默认写入 `~/Library/Application Support/Daylight/state.json`。网页开发服务和桌面应用使用相同目录。首次启动时，从旧工程 `~/liki_dev/daylight-workbench/.local/` 复制已有数据及 skill 凭证；保留旧文件，不覆盖已有新目录数据。它是本地文件，不依赖浏览器缓存；关闭网页或重启服务后保留。没有已有数据时，初始化为空项目、空任务和空日程；安装包不包含个人项目或任务。

写入通过临时文件原子替换；数据目录中的 `state.previous.json` 保留上一版成功数据。数据格式异常时停止启动，保留原文件。多窗口使用版本检查；过期写入被拒绝，并在界面加载最新数据，避免覆盖。

`WORKBENCH_DATA_DIR` 可指定数据目录，测试使用临时目录，与真实数据隔离。导出是用户可读的业务数据；尚未提供导入 UI。恢复上一版可停止服务后，将 `state.previous.json` 复制为 `state.json`，再启动。此操作会用上一版替换当前数据，请先保存当前文件副本。

## 网页与原生共享契约

`core/web-assets.json` 是静态资源允许列表，网页与原生服务共同使用；新增页面资源只在这里登记。`core/contracts.js` 统一接口的方法、鉴权类别、AI/中转转发目标与 capabilities，运行时分别执行 HTTP 收发和鉴权，未知 Agent 路径也先鉴权再拒绝。

`core/task-write.js` 统一任务写请求校验、版本检查、回执去重、撤销和业务变更判断，返回待保存的 state/receipt 或错误。Node 的写锁和异步文件写入、Swift 的串行队列和原子写入保留在各自服务中。请求指纹继续使用原请求的 JSON.stringify 文本与 SHA-256，保留旧回执兼容；读取上一版期间 Node 保持写锁。

`native/core-entry.js` 声明 JavaScriptCore 所需导出，`scripts/build-native-core.mjs` 将它编译成安装包中的 `native-core.js`。UUID 由原生桥提供；不再通过删 import/export 文本拼接源码。任务管理仍无需 Node。新增原生共享函数时更新入口导出和调用端；Node-only 模块不能进入这个依赖图。

构建 App 后运行 `npm run test:contracts`：同一组 HTTP 用例分别检查 Node 和实际原生二进制，包括鉴权、非法输入、版本、原子失败、删除/撤销、重启去重、旧回执和资源允许列表。运行时特有错误文案及时间字段不要求逐字相同。测试只使用临时数据目录，不替换已安装 App。

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

`core/task-selection.js` 统一范围、项目、关键词、状态及计数，`public/task-view.js` 保留兼容导出；网页与 Node 直接复用，原生加载同一规则到 JavaScriptCore。`public/routes.js` 集中处理新旧 Hash。公开接口包括 `/api/v1/tasks` 和 `/api/v1/calendar`，旧业务 schema、actions 和 CLI state 语义不变。AI 关联位于 `ai/context.mjs` 和会话存档，不写入业务 state；导航条件也不写入业务 state。

视图规则、旧链接与删除恢复见 [任务与导航](tasks.md)，会话关联与草稿契约见 [AI 说明](ai.md)。

验证包括 `test/task-view.test.mjs`、Agent API/Skill 集成测试、AI 关联与草稿测试和 `test/native-test.py` 的原生查询契约。使用 WORKBENCH_DATA_DIR 临时目录测试，避免真实任务或会话数据。独立安装的 Skill 需另外更新，改仓库并不等于已安装 Skill 已更新。

Pi 个性化配置：POST /api/cli/pi/configuration 接收 api、expectedVersion、modelOverrides，使用版本保护持久保存，不直接写 Pi 文件。每模型支持 contextWindow、maxTokens、reasoning、input 和 thinkingLevelMap；缺失映射使用目录/Pi 默认，null 表示不支持。GET state 返回 configuration（有效值）及 overrides（用户覆盖）；prepare/apply 可接受覆盖，自动同步复用持久覆盖。

## 日历与专注维护

`public/task-client.js` 管理旧整体 PUT 的快照撤销与新 action 的服务端撤销，任何成功写入只保留对应的最近撤销来源。结果未知的 action 固定原请求重试；旧 PUT 通过读回确认，不能自动重放旧快照。`plan.reschedule` 原子完成移出/加入，各 action 可带独立 day，日历 remove 显式设置 preserveExecution，move 原本即保留执行状态。

专注使用独立 focus.json 与版本，不进入任务撤销。`core/focus-*` 是纯业务模块，运行时提供时钟、任务快照、时区日期窗口、原子保存和串行调度。Node 在 focus/ 组装；Swift 在自己的 queue 中持有 JavaScriptCore 权威对象，不把全历史逐秒来回转成 Foundation。损坏 focus 文件仅降级专注模块。产品语义与文件职责见 [日历与专注](focus.md)。

前端由唯一 focus/controller.js 持有轮询和显示时钟，各挂载组件订阅状态并提供 dispose；报表刷新与倒计时分别调度，settings 保留未保存输入。新增公共 UI 模块继续在 core/web-assets.json 登记；纯后端 core 模块不需要公开为静态资源。

专注审阅内容来自 `prepareFocusAction` 的可信 `impact.current`/`impact.target`，包括标题/项目快照、阶段、目标、累计及剩余时长。`focusSubmission` 单独冻结 impact 用于重启恢复卡，批准的 request body 不变；恢复只能提交原请求。普通计划操作消息保留 envelope day，`actionLinks(action, day)` 优先使用批量子 action 的有效日期；旧消息缺日期时不猜测今天。

`public/focus/presentation.js` 统一全局条和面板的冻结恢复条件及通知投递反馈；tick 在原节点更新继续按钮，设置页将投递错误与权限状态、dirty 输入分别维护。合法日期范围是 0001-01-01 至 9999-12-31，月历范围外补位为不可操作空格，查询只使用有效日期。

构建后运行 `npm run test:focus-contracts` 对照 Node/实际原生 HTTP；`npm run test:native-focus-time-zone` 用真实 Foundation 校验 DST、半小时偏移和消失日期。Node focus 保存错误统一为 503/FOCUS_SAVE_FAILED；写入失败保留原权威和回执，故障解除后用原 body 重试。

原生通知消费专项入口：

```sh
npm run test:native-focus-notifications
```

该脚本需要已构建的 `dist/native/Daylight.app/Contents/Resources/native-core.js`，在可清理的工作区临时目录用系统 Swift 解释器（macOS 13 目标）执行生产 Focus 存储及从生产文件精确抽取的 `FocusNotificationConsumer`。它使用真实临时 focus.json，注入 delivery 观察先持久 attempted 再投递、保存失败不投递以及重启/旧 DTO 不重发；不调用 OS 通知中心，也不请求权限。2026-10-07 此执行路径在两个独立临时目录全部断言通过。先前自签名辅助程序启动 SIGKILL 的失败证据保留，最终通过不反推旧平台失败的根因；实际 allow/deny/display/click/sleep 另留 GUI 证据。

`npm run benchmark:focus` 使用 1 万/5 万条合成历史、实际进程/HTTP/文件保存，报告状态大小、P95、同步占用、RSS、落盘到期延迟及通知消费成本。本轮增加 idle/报表/持续持久写入压力，409 只刷新版本，独立磁盘观察归档结果；RSS 采样覆盖重启与独立 consumer 子进程。它不代替真实 GUI 权限与系统通知展示验收，也不改用户数据。

2026-10-07 回归记录：最终 `npm run check` 与 Node 292/292 无跳过，实际 Swift 任务、24 项任务合同、专注/时区/native AI/proxy/CLI conversations 回归通过，Codex/Qoder 的本地 HTTP/mock 模型持久恢复矩阵通过。最终 binary SHA256 为 `2f4bac81c44f40920d6e6ac968e2c05820c60986ef18fa677d9fdcffecad8f15`。独立 Chrome 19 条断言分为 6 真实、12 模拟和 1 异常守卫；新版性能 review-fix-performance.json 四组合全部预算通过，[App 安装读回](verification/calendar-focus/review-fix-install.json) 通过。81,865 个原有文件无丢失，业务/配置保留，缓存仅 /at 更新，初始化 focus.json。详细分层状态和 10-06 历史见[验证记录](verification/calendar-focus.md)，不得把历史预算或模拟通知视为本轮总验收通过。

## 中转代码结构

中转由 `proxy/service.js` 组装并管理生命周期；`gateway.js` 处理推理、路由回退和输出；`management.js` 提供直接管理操作及 HTTP 入口；`providers.js` 注册六类来源；`sidecar.mjs` 是桌面侧车入口。来源目录按 `provider/auth/models/quota/protocol` 职责命名（不支持额度或无专属协议的来源省略相应文件），仅保存对应认证、目录/额度解析、协议与执行逻辑，公共代码不从来源私有字段推断状态。

`proxy/shared/request-parameters.js` 负责推理参数规则，`model-settings.js` 负责默认设置的串行原子写入，`catalog-cache.js` 负责目录缓存、身份隔离和失效中的并发请求；其余 shared 模块提供协议转换、路由、凭据存储、额度规范化和请求记录。

前端 `public/proxy.js` 只组装页面与标签。`public/proxy/api.js` 统一 HTTP 请求，`state.js` 管理轮询与资源状态，`service-panel.js` 管理公共服务，`source-page.js` 按认证描述与模型能力渲染来源；`model-list.js` / `model-options.js`、`quota-panel.js` 共享模型和额度组件；`custom-sources.js` 保留自定义来源的草稿、Key 权限及保存事务。模型路由也使用同一 API 客户端。

新增来源通常只需注册来源描述并实现 `snapshot/listModels/execute/close`，即时模型设置、认证和额度按能力提供。公共推理入口接收原始请求，原生适配器保留字段，事件适配器使用 shared 协议解码，结果通过 `kind: response/events` 选择输出路径。完整文件职责、接口与问题记录见 [中转架构](proxy-architecture.md)。

旧 `/api/qoder` 等管理接口、`/v1` 推理接口及数据路径保持兼容；新前端使用 `/api/proxy` 统一入口。目录检查与实际推理检查分别声明，不把原来的免费目录测试改成付费生成。源码整理不迁移用户配置，也不安装或替换本机 App。

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

字段标签旁有操作时，使用 `design-system.css` 的 `ui-field-label` 与 `ui-field-label-action`。动作容器使用标签行高，内部按钮保留公共点击尺寸，不把标签行撑高；相邻普通字段与下拉框保持同一控件起点。自定义来源的 API Key / 添加 Key 使用该布局，避免每个页面另设偏移量。


## 扩展模块

新增入口与领域代码见[本地扩展管理](extensions.md)。core/extensions-contracts.js 是纯契约；extensions/ 负责来源、适配和回执；public/extensions/ 负责页面、客户端、控制器及共用审阅；ai/extensions-submissions.mjs 只管理审批与提交恢复。Swift 复用通用 helper 转发。不要把源内容放入任务 state、Pi 模型配置或 AI provider。

新增文件系统测试必须同时注入 agentsRoot、clientRoots，原生测试用 WORKBENCH_AGENTS_ROOT、WORKBENCH_EXTENSION_CLIENT_ROOTS。只隔离 WORKBENCH_DATA_DIR 不足以隔离扩展写入。运行 npm run test:extensions-contracts 前先 pack:mac。浏览器与规模验收脚本仅运行在独立 fixture，见验收报告。
