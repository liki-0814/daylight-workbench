# 本地扩展管理

入口为主导航「扩展管理」，含 Skills、MCP 服务、接入软件三个分类。共享来源位于 `~/.agents`，同时读取各 CLI 的本地 Skills 和用户级 MCP。接入定义统一位于 `extensions/client-adapters.mjs`，支持 Codex、Qoder、Pi、Grok、Claude Code；Grok 和 Claude Code 在发现可执行文件或配置目录时自动显示。发现只提供候选项，不默认接入。在「接入软件」选择后才读取和管理该 CLI 的 Skills、MCP；取消接入保留原有文件、链接和记录。选择保存在 clients.json 的 selectedClients 中，未选择的软件不出现在 Skill 接入矩阵、保存位置或 MCP 接入操作中。其他 CLI 可以手动登记并审阅接入。旧版已明确登记或有 Daylight 管理记录的软件保留原选择，单纯存在程序、目录或外部链接不作为接入授权。软件筛选按真实来源或链接筛选，不代表客户端已加载。

Skills 从共享来源及各 CLI 的 Skills 目录读取一级子目录；已知来源的链接归入同一 Skill，不受扫描顺序影响；外部未知链接只列出链接位置，不读取其内容。内部 `modules`、`vendor`、`references` 等内容不会作为独立 Skill 列出，支持新建、受限文本编辑、归档和按操作恢复。元数据由标准 YAML 解析，保留未知 frontmatter；依赖只读取明确的 `metadata.mcp-dependencies` 数组，未声明不会解释成没有依赖。手动改名后不会按名称关联旧对象。

软件主目录和共享来源分别显示：Codex 主目录默认 `~/.codex`，支持 `CODEX_HOME`；客户端原有 Skills 位置为主目录下的 `skills`，Daylight 管理来源仍为 `~/.agents/skills`。Codex 链接位置是 `~/.codex/skills`；Pi 软件主目录默认 `~/.pi`，链接位置是 `~/.pi/agent/skills`。显式设置 `PI_CODING_AGENT_DIR` 时，该变量代表 agent 目录，Skills 位于其 `skills` 下。

列表与详情共用勾选控件。各软件勾选后预览建立单个 Skill 链接，取消勾选后预览移除该链接，主来源保持原样。已有正确链接默认不归 Daylight 管理；可明确确认仅移除该链接，也可先预览接管。同名实体目录、其他目标链接及已被外部改动的管理链接均不覆盖。修改前的链接可按操作恢复。

三个分类共用分类配置、筛选栏、操作区与列表布局，软件、文件和连接方式选择均使用 `workbench-select`。只扫描来源根目录及一级子目录，保留 5000 个目录上限；达到上限时显示首个跳过路径，不递归扫描 Skill 内部内容。

接入软件页提供“添加 CLI”：名称、单个命令名或可执行文件绝对路径、软件主目录、Skills 相对目录，以及 CLI 适配器和可选导出格式。格式本身不决定原生 MCP 配置结构。登记保存于 `~/.agents/daylight/clients.json`，预览确认前不写入；不会安装或执行程序。保存后进入软件筛选和全部 Skill 勾选列表。自定义登记可编辑或移除，变更接入目录或移除前须解除已管理链接。若旧登记与自动识别项指向同一 Skills 目录，使用自动识别项且不重复列出；删除旧登记时迁移链接管理记录，不改动实际链接。AI 与外部 Agent 使用同一 `client.save` / `client.remove` 动作、回执和恢复机制。

MCP 主文件为 `~/.agents/mcp/servers.json`，这是 Daylight 的管理格式。初次查看不创建目录；读取遇到格式错误时保留文件，管理写入暂停。保存不会启动服务。配置只接受环境变量引用，不接受明文凭据字段：

```json
{
  "schemaVersion": 1,
  "servers": [
    {"id": "local-tools", "name": "本地工具", "transport": "stdio", "enabled": true,
     "command": "node", "args": ["/absolute/path/server.mjs"],
     "envRefs": {"API_TOKEN": "API_TOKEN"}}
  ]
}
```

HTTP 使用 `url` 和 `headerRefs`，例如 `{"Authorization":"MCP_AUTH_HEADER"}`，环境变量值应包含客户端需要的完整请求头值。主配置与生成文件只保存变量名。当前 stdio 诊断只继承基本运行环境和明确引用的变量，不传递 Daylight 私有 MCP token。

Codex、Grok 直接管理用户级 `config.toml` 的 `mcp_servers`；Qoder 管理 `settings.json` 的 `mcpServers`；Claude Code 管理 `~/.claude.json` 的用户级 `mcpServers`。只修改目标字段，保留未知字段、其他配置、注释和未编辑的凭据。Codex/Grok 支持服务启停；Qoder 使用 `mcp.excluded`，不猜测 Claude Code 的启停字段。Pi 暂无原生 MCP 适配器。项目、插件和兼容来源可能覆盖用户配置，本次不扫描项目目录。

`mcp.save` 可指定 `clientId` 保存到软件；新建服务传 `create: true`，ID 已存在时返回 409（`EXTENSIONS_DUPLICATE_ID`），省略 `create` 视为编辑并替换同 ID 服务；校验错误带 `field`，明文 `http://`（非本机地址）在计划与服务状态里带 `INSECURE_HTTP` 警告；`mcp.install` 把共享配置接入软件，同名服务不覆盖；`mcp.toggle` 仅用于声明支持启停的软件。导出片段和实际写入共用适配器。未知软件只有导出格式时仍为手动接入。Qoder 的凭据插值形式未核实时拒绝写入新引用。所有新凭据使用环境变量引用，原生配置中的既有值保持隐藏；公开清单、详情、计划不包含完整软件配置。恢复材料仍保存在本地私有操作日志中。

`mcp.generate` 保留为导出操作，位于 `~/.agents/mcp/generated/<client>/`。生成与链接完成、当前检测握手成功、目标客户端实际发现是不同状态。软件本地 MCP 的握手、OAuth 和实际发现由对应 CLI 核对，Daylight 的显式探测仍用于共享配置。

检测须由页面明确点击或 AI 审阅确认；仅协商并读取工具清单，支持 stdio、Streamable HTTP 和分页，不调用业务工具。最多并行两项，超时、取消、正常完成均等待自己创建的连接和子进程清理。主配置修改、禁用、归档或恢复后，过期的本次检测会取消，其他服务检测保持运行；旧结果标明配置已经变化。检测结果保留在 helper 本次运行内，重启后须明确发起新检测。

网页与 AI 共用服务。四个 AI 管理工具为 `daylight_get_extensions`、`daylight_get_extension`、`daylight_diagnose_extensions`、`daylight_propose_extension_changes`。正文、注释及 MCP 返回内容作为数据处理。公共 MCP 不自动加入 Daylight 模型的 MCP 列表，现有 Skill 选择、模型配置和工作目录保持原语义。

详情可带真实对象引用回到现有 AI 对话，保留输入与返回入口。页面和 AI 使用同一份真实变更预览。页面批准请求保存在本地浏览器存储，AI 批准请求保存在对话 submission；响应丢失或重启后用原 requestId 和完整参数重试，服务回执防止重复写入。未知结果不能直接取消或换请求。未批准的 AI 草稿不会写盘或启动服务。

服务位于 `extensions/`，纯契约位于 `core/extensions-contracts.js`。Node 按需加载；原生端复用已有 AI helper 的传输，扩展与 AIStore 独立初始化。任务、日历、专注不等待来源扫描或模型登录。CLI 文件发现与已有 AI 适配器共用 `core/local-executables.mjs`，在 PATH 和常见本机安装目录检查，不启动进程。YAML、MCP SDK、TOML 和 JSONC 解析器在原生打包时显式 bundle，包含完整依赖许可证。

写入前后材料保存在 `~/.agents/daylight/operations/<requestId>.json`，权限为 0600。跨进程排他锁、源版本、相关文件前后摘要与计划摘要共同约束提交；对象键排序确保 Swift/Node JSON 转发不改变身份。多文件步骤有回执和恢复材料，不能视为全局原子事务。中断操作只恢复仍符合本次前后摘要的文件；外部漂移时进入 `recovery_required` 并停止后续写入。核对对应文件和回执，手动保留或恢复到已知状态后，重试原请求可继续核对，不能盲目覆盖新内容。

API 的网页入口为 `/api/extensions`，Agent 入口为 `/api/v1/extensions`。网页变更校验 Token 和 Origin，Agent 校验 Bearer；不接受任意外部路径。公开接口及命令见[仓库 Skill API](../skills/daylight-workbench/references/api.md)。测试与人工验收证据见[验收报告](verification/extensions.md)。

调试页面、AI 和模型发现可直接运行 `npm run dev`，无需打包。业务数据隔离不会自动隔离扩展主来源或 Pi 配置；需要用合成内容演练链接、编辑和归档时，显式覆盖所有写入目录：

```sh
PORT=4328 \
WORKBENCH_DATA_DIR="$PWD/.local/web-dev" \
WORKBENCH_AGENTS_ROOT="$PWD/.local/web-dev/agents" \
WORKBENCH_EXTENSION_CLIENT_ROOTS="{\"codex\":\"$PWD/.local/web-dev/codex\",\"qoder\":\"$PWD/.local/web-dev/qoder\",\"pi\":\"$PWD/.local/web-dev/pi\"}" \
PI_CODING_AGENT_DIR="$PWD/.local/web-dev/pi" \
npm run dev
```

这些变量隔离 Daylight 管理写入，CLI 的认证和原生 Skill 发现继续遵循本机 CLI 自己的目录规则。不要将测试来源中的链接状态作为真实 CLI 已加载的证明。

## Skill 启用与停用

仅共享来源（`~/.agents/skills`）的 Skill 支持。`skill.disable(id)` 移除该 Skill 在所有已接入软件中的链接（Daylight 管理的链接，以及指向主来源的已有正确链接），并把这些接入记入 `~/.agents/daylight/bindings.json` 的 `skillStates`，主来源文件不变。`skill.enable(id, clientIds?)` 按记忆重建链接；目标位置被占用时进入冲突，不覆盖，可用 `clientIds` 只恢复其中一部分，其余保留在记忆中。停用的 Skill 不能接入新软件。`bindings.json` 仍为 `schemaVersion: 1`，`skillStates` 缺省即启用；旧版本只读取 `bindings` 并保留未知字段。`state.skills[]` 返回 `enabled` 与 `rememberedClientIds`。

## 导入

`skill.import` 从本地文件夹复制 Skill（不支持 URL）：路径需为绝对路径，顶层有合法 `SKILL.md`；目录名取其中的 `name`；不跟随符号链接，忽略隐藏文件和 `node_modules`，最多 500 个文件、5 MB、6 层目录；目标同名时进入冲突，不覆盖。`scope` 为 `shared` 或 `client`（需 `clientId`）。`mcp.importJson` 解析粘贴的 `{"mcpServers": {...}}` 或带 `id`/`name` 的单个服务对象，`env`/`headers` 只接受 `${变量名}` 形式的引用，明文凭据会被拒绝且不回显；JSON 语法错误返回 `line`/`column`；已有 ID 一律是冲突，不覆盖。

## 接入冲突处理（E-11）

当软件的 Skills 目录里已有同名内容（真实目录、单个文件，或指向别处的链接），而不是指向共享 Skill 的正确链接时，这个位置的状态是 `conflict`（`bindings[].state`），不能直接接入。处理方式有三种，对应检查器的三个按钮，范围是共享来源中的 Skill：

- **对比差异（只读）** `GET /api/extensions/compare?id=<skillId>&clientId=<clientId>[&expectedVersion=<version>]`。返回 `readOnly:true`、`local.kind`（`directory`/`file`/`link`）、`summary`（各状态文件数、`withheld`、`redactedLines`）、`files[]`（`path`、`status`：`same`/`different`/`onlyShared`/`onlyLocal`/`typeDiffers`/`unknown`；文本文件的 `diff` 是从共享版本到软件内版本的行差异，每行 `op` 为 `same`/`shared`（只在共享版本）/`local`（只在软件内版本））、`identical`、`truncated`。有 `expectedVersion` 且已过期返回 409 `EXTENSIONS_VERSION_CONFLICT`；该位置没有冲突返回 409 `EXTENSIONS_NOT_CONFLICT`。
- **采用共享版本** `skill.resolveConflict {id, clientId, resolution:"adoptShared"}`：先 `prepare`，确认后用 `actions` 提交（`expectedVersion`、`planId`、`requestId` 与其他动作相同）。把软件里的同名内容替换成指向共享 Skill 的链接并登记为 Daylight 管理的接入；被替换的内容（目录最多 2500 个文件 / 8 MB）写入恢复记录，可用 `operation.restore` 找回。共享 Skill 已停用时 409 `EXTENSIONS_SKILL_DISABLED`。
- **保留软件内版本** `skill.resolveConflict {id, clientId, resolution:"keepLocal"}`：不改动任何文件，也不建立链接；在 `bindings.json` 的可选顶层数组 `conflictResolutions: [{skillId, clientId, target, fingerprint}]` 里记住这个决定（`fingerprint` 是软件内内容的 SHA-256，不含内容本身）。之后该绑定仍是 `conflict`，但带 `resolution:"keepLocal"`，`BINDING_CONFLICT` 诊断消失；软件内内容变化后 `resolution` 变回 `null`、带 `resolutionStale:true`，诊断重新出现。`resolution:"reopen"` 清除这个决定（不改文件）。归档该 Skill 会清除它的决定。

不泄露内容的约束：对比永远不跟随符号链接（软件位置本身是链接时只返回链接目标，`compared:false`），忽略 `.git` 与 `node_modules`，最多 500 个文件、6 层；文本差异每个文件不超过 64 KB / 2000 行 / 400 行差异；`.env*`、密钥证书、名称含 credential/secret/token/password 的文件只给状态和大小（`withheld:"sensitive"`），二进制或过大文件同样不给内容；看起来像凭据的行（`api_key=`、`token:`、`sk-…`、`ghp_…`、Bearer、PEM 私钥）整行替换为「[已隐藏：疑似凭据]」。`prepare` 的 `files` 对目录与链接替换不回显任何文件内容，对被替换的单个文件标记为私有，不回显。

错误码：`EXTENSIONS_NOT_CONFLICT`（409，位置没有冲突）、`EXTENSIONS_ALREADY_RESOLVED`（409，已保留软件内版本）、`EXTENSIONS_NOT_RESOLVED`（409，没有可重新打开的记录）、`EXTENSIONS_SKILL_DISABLED`（409）；`resolution`、`clientId`、`id` 无效返回 400 并带 `field`。

## MCP 行级启停、批量检测与凭据引用状态

- `mcp.toggle`（`id`、`enabled` 布尔值）现在也适用于共享 MCP：只改主配置 `servers.json` 里的 `enabled`，不启动服务；重复启停返回 409（`EXTENSIONS_ALREADY_ENABLED` / `EXTENSIONS_ALREADY_DISABLED`）；停用后配置版本变化，进行中的检测会被取消，停用的服务不能检测（`POST /probes` 返回 400）。软件作用域的行为不变。
- `POST /api/extensions/probes` 除 `{id, expectedVersion}` 外接受 `{ids:[…], expectedVersion}`（1–50 个不重复 ID，一次确认一批可见的服务）。已停用的服务不会启动，列在 `skipped`（`reason: "disabled"`）；响应 `{probes, skipped}`。同时最多 2 个连接，其余 `status: "queued"` 排队、轮到自动开始，可用 `DELETE /probes/:id` 取消。单个检测的行为不变，满 2 个仍返回 409 `EXTENSIONS_PROBE_BUSY`。
- 每个 MCP 服务（`/state` 与 `/objects/:id`）带 `refStatus: [{kind: "env"|"header", key, ref, set, internal}]`：`ref` 是引用的环境变量名，`set` 表示 Daylight 进程环境中是否已设置，`internal` 表示属于 Daylight 内部凭据（检测会拒绝）。变量的值永远不会出现在响应里。
