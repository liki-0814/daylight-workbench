# 扩展管理验收记录

日期：2026-10-09。实施基线：`8275db8`（先提交原暂存代码）；实施分支：`codex/extensions-management`。本轮不推送远端，不替换已安装 App，不更新独立安装的 Daylight Skill。

前半部分保留初次实施的 319 项回归和 13 组浏览器结果。Web 启动功能和随后界面反馈修复的最新验收见末尾：333 项回归、24 组浏览器流程。

新增主导航「扩展管理」，管理范围为 `~/.agents/skills` 和 `~/.agents/mcp/servers.json`。Codex、当前支持共享目录的 Pi 不新增链接；Qoder 按 Skill 建立必要链接。Daylight AI 通过同一服务查询、提出草稿、审阅应用、核对原请求和返回对象详情。公共 MCP 不自动进入 AI 推理运行时。Cursor 不在首版登记范围。

[构建和回归原始摘要](extensions/runtime.json)记录最终包摘要、依赖版本、319 项测试结果及 Node/App 合同和原生旧功能的实际输出。浏览器、性能和软件发现分别保留独立证据，避免将部分通过表述为完整端到端通过。

## 已执行结果

| 验证层 | 结果及证据 | 实际覆盖范围 |
| --- | --- | --- |
| 实施前基线 | `npm run check`、原有 297 项 Node 测试通过 | 基线工作区包含已提交的日历、专注及其他改动 |
| 最终源代码检查 | `npm run check` 通过 | 既有模块与全部扩展前后端 JS 语法 |
| 完整 Node 回归 | `npm test`：319/319，通过，无跳过 | 既有任务、日历、专注、AI、代理、CLI、打包规则，以及 22 项新增扩展测试 |
| 文件系统与故障恢复 | `test/extensions.test.mjs`、`extensions-transactions.test.mjs` | YAML、范围约束、未知链接接管、链接目标漂移、父目录替换、归档恢复、源版本、请求复用、锁竞争、真实 SIGKILL 中断、回执后响应丢失、外部改动保留、扫描与保存重叠 |
| 真正 MCP 协议 | `test/extensions-mcp.test.mjs` | stdio 和 Streamable HTTP 初始化、工具分页、取消/超时/子进程退出、并发容量、配置变更或归档使旧检测取消且其他检测继续、结果失效标记、授权错误脱敏、内部凭据与同值别名拒绝；不调用业务工具 |
| AI 管理链路 | `test/extensions-http-ai.test.mjs` | 测试 adapter 通过真正私有 MCP 子进程调用管理工具；读取/草稿/拒绝零副作用，批准写一次，持久化失败不发请求，重启核对不重跑模型，真实对象引用和版本变化；没有付费模型推理 |
| 仓库外部 Skill | 同一 HTTP 测试调用真实 Python CLI | extensions-state/detail/diagnostics/prepare/apply/operation、原请求重试、Bearer API 和 capabilities；只更新仓库中的 Skill |
| Node 与打包 App | `python3 test/extensions-contract-test.py` 两端通过 | 同一 HTTP 合同、鉴权/Origin/方法、静态资源、零 AIStore 初始化、真实来源读回、链接/归档/恢复、MCP 生成和 stdio 检测 |
| 原生旧功能 | native-test、task-contract、focus-contract、native-ai、native-conversations、native-cli、native-proxy | 实际打包 Swift/helper，任务 24 项共享合同、专注恢复、最近模型发现（Codex 8 / Qoder 17）、AI 会话 API、隔离 Pi 配置同步、模拟上游代理协议与生命周期 |
| 浏览器交互 | [13 组结果](extensions/browser/report.json)，0 个页面异常 | 独立无头 Chrome，真实页面、HTTP API、隔离文件系统和本地 MCP fixture；AI 使用验收 adapter |
| 安装软件发现 | [逐软件结果](extensions/clients.json) | Codex 0.161.0、Pi 1.1.0 在隔离 HOME 实际发现共享 Skill，零新增链接；Qoder 1.1.64 初始化前出现 Transport closed，实际发现未验收，链接本身已由文件系统/页面/App 合同验证 |
| 规模与并行读取 | [性能原始数据](extensions/performance.json) | 1000 个合成 Skill、100 个 MCP，Node HTTP 首次约 451 ms、缓存 P95 约 10 ms；扫描期间任务查询 P95 约 1.2 ms、专注 session 保留 |
| 原生交付 | `npm run pack:mac` 成功，依赖 bundle/资源裁剪测试通过 | 新增 YAML/MCP SDK 显式打包及许可证；生成 `dist/native/Daylight.app`，没有替换安装版 |

原生代理回归有一次在并行验收时未取得 helper 就绪状态，单独复验完整流程通过；原因尚未证实，不能归结为已修复的产品缺陷。原始失败与复验日志分别留在本轮临时目录。

性能基线的任务 P95 约 1.8 ms，扫描时约 1.2 ms；短请求受预热和调度影响，不把差值解释为功能提升。当前只测 Node HTTP，不据此宣称原生 helper 冷启动或 1000 行浏览器交互延迟已经达标。

## 浏览器动作与界面证据

实际操作包括来源列表、搜索/键盘分类、单一空状态、Qoder 预览取消和接入、软件/问题筛选、切页保留编辑内容、Escape 返回焦点、AI 引用及拒绝/应用、响应丢失后的原请求核对、显式 MCP 检测、AI 确认检测后返回详情持续更新、手动配置生成、归档/恢复、响应式布局。引用加载故意延迟时快速输入，验证输入不被默认提示覆盖，引用完成前发送暂时禁用。

| 界面 | 截图 |
| --- | --- |
| 1360 宽主列表 | [列表](extensions/browser/skills-1360.png) |
| 1360 宽详情 | [详情](extensions/browser/detail-1360.png) |
| 800 宽详情 | [窄屏详情](extensions/browser/detail-800.png) |
| 390 宽详情 | [小屏详情](extensions/browser/detail-390.png) |
| 200% CSS 缩放 | [缩放详情](extensions/browser/detail-css-zoom-200.png) |
| AI 审阅 | [真实文件变更卡](extensions/browser/ai-review.png) |
| AI 结果未知 | [核对原请求](extensions/browser/ai-unknown.png) |
| MCP 检测 | [握手结果](extensions/browser/mcp-probe.png) |
| MCP 客户端生成 | [手动接入说明](extensions/browser/client-manual.png) |

1360×900、1024×768、800×600、390×844 及 CSS zoom=2 均断言页面没有横向溢出。截图已逐项观察主要列表、窄屏详情、缩放及审阅状态；这属于浏览器操作与布局验收，不是人类可用性研究，也不是 WKWebView 原生图形界面验收。

## 保留的兼容边界

1. MCP 只自动写 `~/.agents` 内的主配置、归档和生成文件。Codex/Qoder 混合全局设置须手动接入生成内容；没有验证其他软件的 MCP 实际发现或业务授权。Pi 原生 MCP 未验证，操作禁用。Qoder 含凭据引用的配置在插值形式未验证时拒绝生成。
2. Qoder 隔离运行发现未通过，页面始终把正确链接和运行发现分开显示。不能由真实环境原有的 Skill 清单推断隔离测试 Skill 已被加载。
3. 实际 macOS App 的 HTTP、资源、helper 和独立模块初始化已验收，安装版替换、WKWebView 图形交互及真实账号模型推理未执行。
4. 诊断只读取工具清单；服务的业务工具、真实账号权限、长期稳定性不在本轮通过范围。helper 重启后不自动重启先前已确认的 MCP 检测。
5. 多文件变更有恢复日志，不承诺文件系统级整体原子性。外部漂移使操作进入 recovery_required 并阻止后续写入，必须核对文件和回执后再重试。恢复材料直接保存在 0600 操作记录中。

## 人工验收步骤

在可丢弃的 `WORKBENCH_DATA_DIR`、`WORKBENCH_AGENTS_ROOT`、`WORKBENCH_EXTENSION_CLIENT_ROOTS` 下启动当前构建；真实来源接入由用户选择，人工验收不向真实配置写演练数据。

| 用户任务 | 通过条件 |
| --- | --- |
| 从导航找到扩展 | 名称和范围明确；来源为空/无法读入时能返回、刷新，其余页面正常 |
| 看懂 Skill 的状态 | 一眼区分原生读取、待接入、已接入未接管、Daylight 管理和冲突；不把链接正确看成已运行发现 |
| 编辑和取消 | 普通保存一次完成；取消/切页保留输入；Escape 回到触发控件；无意外执行脚本 |
| 接入、归档、恢复 | 预览展示真实路径、内容和影响；取消零写入；同名实体不覆盖，未知链接不删除；恢复有当前版本约束 |
| 带对象继续 AI 对话 | 继续已有对话，保留未发输入和任务关联；引用真实对象，审阅后才写；结果可返回原详情 |
| 核对未知结果 | 不诱导重新发一遍动作；原请求能查回唯一回执；旧操作不重复执行 |
| 测 MCP | 保存不启动；显式测试有取消和结果；握手与工具数说明准确，授权失败不暴露值 |
| 其它功能并行使用 | 任务保存、日历改期、专注倒计时、代理请求、Pi 同步和普通 AI 对话仍正常；扩展错误只在本页出现 |
| 真正目标软件加载 | 在相应软件刷新/新建会话后实际发现对象；记录版本及发现结果；Qoder 和各客户端 MCP 仍需完成这一层 |

## 复现入口

```sh
npm run check
npm test
npm run pack:mac
npm run test:extensions-contracts
node scripts/benchmark-extensions.mjs
node scripts/verify-extension-clients.mjs
```

浏览器先启动 `fixtures/extensions/browser-server.mjs` 并传入 `daylight-extensions-browser-` 前缀的临时目录，再运行 `scripts/verify-extensions-browser.mjs`。Playwright/Chrome 由验收环境提供，可用 DAYLIGHT_PLAYWRIGHT_MODULE 和 DAYLIGHT_CHROME_EXECUTABLE 指定，不加入产品运行依赖。软件发现脚本任一项未验证即退出 1，不能把已知 Qoder 限制当作通过。

## 界面反馈修复验收

日期：2026-10-09。改动基于 `74948f1`；[本次运行摘要](extensions/review-fix/runtime.json)与[浏览器报告](extensions/review-fix/browser/report.json)独立保存，不覆盖初次实施证据。

软件主目录、软件自身 Skills 目录与 Daylight 管理的共享来源分别呈现。Codex 主目录默认 `~/.codex`，遵循 `CODEX_HOME`；这与原生支持 `~/.agents/skills` 是两个概念。[官方配置目录说明](https://developers.openai.com/codex/config-advanced/)、[官方 Skills 来源说明](https://developers.openai.com/codex/skills/)。

Qoder 的列表、Skill 详情和软件详情复用同一勾选控件，操作先展示真实链接差异。取消不写入并返回焦点，应用后更新清单与详情。明确审阅移除已有正确链接无需先改接入归属，仍拒绝同名实体、不同目标及管理链接漂移；真实相对链接按原文本恢复。原生共享读取显示为只读勾选，旧链接可单独移除，界面及预览说明共享来源仍可读取。

原来的 7 层限制误报正常 bundled Skill 嵌套，现为 32 层；5000 个目录边界继续生效。测试覆盖正常深层来源、真正深度超限的多分支去重、总目录上限和其他分支继续扫描。当前用户 4328 服务只读核对为 17 个 Skill、0 条静态诊断、0 个原生 select；业务数据版本仍为 0，继续使用独立 Web 调试数据。

| 验证层 | 本次结果 |
| --- | --- |
| 源代码与完整 Node 回归 | `npm run check`；328/328，无失败、跳过 |
| Node / 打包 App 同一合同 | 主目录字段、原生零新链接、已有正确链接明确移除与精确恢复、归档恢复、MCP 生成与真实协议检测通过 |
| 原生旧功能 | `test/native-test.py`：CRUD、批量原子性、鉴权、网页写入、重启、跨运行时回执、外部 Skill、损坏保护通过 |
| 浏览器真实页面 | 22 组流程、0 个页面异常；AI 使用隔离 adapter，MCP 使用本地 fixture，不代表真实账号推理或业务权限通过 |
| 三分类布局 | [公共位置数据](extensions/review-fix/browser/layout.json)：1360、1024、800、390 四种宽度下，分类栏、搜索、软件筛选、问题筛选、操作按钮和清单标题的公共位置一致 |
| 键盘和草稿 | Space 勾选、Escape 取消与焦点恢复、文件选择、连接方式切换、保留编辑草稿、跨分类保留筛选通过；三个分类的加载、空清单、读取失败及刷新恢复通过 |

主要界面已观察：[勾选详情](extensions/review-fix/browser/skill-detail.png)、[Codex 主目录与共享来源](extensions/review-fix/browser/client-manual.png)、[窄屏详情](extensions/review-fix/browser/detail-390.png)。所有下拉框复用 `selectField` / `workbench-select`，三个分类共用布局和分类配置。项目根 `AGENTS.md` 写入通用组件优先及关联页面共同验收两条长期约定。

本次构建只用于验收，没有替换运行中的安装版 App。浏览器自动化属于交互和布局验收，不宣称完成人类可用性研究；初次记录的 Qoder 实际发现、客户端 MCP 接入和 WKWebView 图形交互边界继续保留。

## CLI 登记、软件目录与一级 Skill 清单修正

日期：2026-10-09。本段是当前行为，前面保留的原生共享目录只读复选框、递归扫描和零链接结果属于之前的实现。

- Codex 按 `~/.codex/skills`、Pi 按 `~/.pi/agent/skills` 管理单项链接，复选框可接入或移除；不显示“加载结果未核对”。
- Skill 清单只识别 `~/.agents/skills` 的一级子目录，不独立登记 `modules/vendor` 内部模块。真实 4328 服务只读验收为 16 项，没有扫描诊断。
- 接入软件页新增“添加 CLI”，复用编辑器、对话框、选择器、变更预览、回执和恢复；登记位于 `~/.agents/daylight/clients.json`，进入公共软件筛选及全部 Skill 接入控件。支持编辑、移除，自定义 MCP 格式明确选择已有 Codex TOML 或 Qoder JSON 适配；登记不安装或执行程序。
- 已管理链接未解除时，移除、改接入目录或恢复会移除登记的操作会停止；已有未接管链接、主来源及程序文件保留。格式错误登记不覆盖，其他业务及主 Skill 管理仍可使用。

`npm run check`、333/333 Node 回归、Node/实际打包 App 同一扩展合同、原生已有 CRUD/鉴权/原子批量/重启/回执/外部 Skill/损坏保护回归通过，包含 CLI 登记/链接/移除/恢复、MCP 和原有功能路径。AI 新增 CLI 已通过真正私有 MCP 子进程与审阅批准/拒绝测试；外部仓库 Skill Python CLI 也实际调用同一公开 API，任务与专注版本不变。

[24 组浏览器结果](extensions/cli-registration/browser/report.json)覆盖预览取消与草稿保留、重载后登记持久化、软件筛选、新软件 Skill 链接、阻止未解除链接的移除、登记恢复、一级来源识别，以及先前 AI/文件编辑/MCP/键盘/共享布局/四种宽度/两倍 CSS 缩放流程，0 个页面异常。AI 使用隔离 adapter，不代表真实模型账号推理或客户端运行发现已验收。

[当前 Web 只读验收](extensions/cli-registration/live.json)与[真实软件页面](extensions/cli-registration/live-clients.png)核对添加入口、16 个一级 Skill 和可操作的 Codex/Pi 勾选，没有向个人扩展目录提交测试操作。构建和合同日志见[本轮原始结果](extensions/cli-registration/runtime.json)。
