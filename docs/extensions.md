# 本地扩展管理

入口为主导航「扩展管理」，含 Skills、MCP 服务、接入软件三个分类。管理来源只位于 `~/.agents`；内置 Codex、Qoder、Pi，可登记其他本地 CLI，没有 Cursor 预设。Skills 软件筛选按已有链接关系筛选，MCP 软件筛选按是否支持配置适配筛选，不代表客户端已加载。

Skills 只从 `~/.agents/skills` 的一级子目录读取；内部 `modules`、`vendor`、`references` 等内容不会作为独立 Skill 列出，支持新建、受限文本编辑、归档和按操作恢复。元数据由标准 YAML 解析，保留未知 frontmatter；依赖只读取明确的 `metadata.mcp-dependencies` 数组，未声明不会解释成没有依赖。手动改名后不会按名称关联旧对象。

软件主目录和共享来源分别显示：Codex 主目录默认 `~/.codex`，支持 `CODEX_HOME`；客户端原有 Skills 位置为主目录下的 `skills`，Daylight 管理来源仍为 `~/.agents/skills`。Codex 链接位置是 `~/.codex/skills`；Pi 软件主目录默认 `~/.pi`，链接位置是 `~/.pi/agent/skills`。显式设置 `PI_CODING_AGENT_DIR` 时，该变量代表 agent 目录，Skills 位于其 `skills` 下。

列表与详情共用勾选控件。各软件勾选后预览建立单个 Skill 链接，取消勾选后预览移除该链接，主来源保持原样。已有正确链接默认不归 Daylight 管理；可明确确认仅移除该链接，也可先预览接管。同名实体目录、其他目标链接及已被外部改动的管理链接均不覆盖。修改前的链接可按操作恢复。

三个分类共用分类配置、筛选栏、操作区与列表布局，软件、文件和连接方式选择均使用 `workbench-select`。只扫描来源根目录及一级子目录，保留 5000 个目录上限；达到上限时显示首个跳过路径，不递归扫描 Skill 内部内容。

接入软件页提供“添加 CLI”：名称、单个命令名或可执行文件绝对路径、软件主目录、Skills 相对目录，以及可选 MCP 格式。登记保存于 `~/.agents/daylight/clients.json`，预览确认前不写入；不会安装或执行程序。保存后进入软件筛选和全部 Skill 勾选列表。自定义登记可编辑或移除，变更接入目录或移除前须解除已管理链接。AI 与外部 Agent 使用同一 `client.save` / `client.remove` 动作、回执和恢复机制。

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

Codex 可生成独立 TOML，Qoder 可生成不含凭据引用的 JSON；Qoder 的凭据插值形式未验证时拒绝生成，界面说明原因。生成文件位于 `~/.agents/mcp/generated/<client>/`。两者全局配置都含其他设置，所以用户须在客户端完成 MCP 接入，Daylight 不替换全局配置或整个文件的软链接。Pi 的原生 MCP 接入未验证，相关操作禁用。生成与链接完成、当前检测握手成功、目标客户端实际发现是不同状态。

检测须由页面明确点击或 AI 审阅确认；仅协商并读取工具清单，支持 stdio、Streamable HTTP 和分页，不调用业务工具。最多并行两项，超时、取消、正常完成均等待自己创建的连接和子进程清理。主配置修改、禁用、归档或恢复后，过期的本次检测会取消，其他服务检测保持运行；旧结果标明配置已经变化。检测结果保留在 helper 本次运行内，重启后须明确发起新检测。

网页与 AI 共用服务。四个 AI 管理工具为 `daylight_get_extensions`、`daylight_get_extension`、`daylight_diagnose_extensions`、`daylight_propose_extension_changes`。正文、注释及 MCP 返回内容作为数据处理。公共 MCP 不自动加入 Daylight 模型的 MCP 列表，现有 Skill 选择、模型配置和工作目录保持原语义。

详情可带真实对象引用回到现有 AI 对话，保留输入与返回入口。页面和 AI 使用同一份真实变更预览。页面批准请求保存在本地浏览器存储，AI 批准请求保存在对话 submission；响应丢失或重启后用原 requestId 和完整参数重试，服务回执防止重复写入。未知结果不能直接取消或换请求。未批准的 AI 草稿不会写盘或启动服务。

服务位于 `extensions/`，纯契约位于 `core/extensions-contracts.js`。Node 按需加载；原生端复用已有 AI helper 的传输，扩展与 AIStore 独立初始化。任务、日历、专注不等待来源扫描或模型登录。CLI 文件发现与已有 AI 适配器共用 `core/local-executables.mjs`，在 PATH 和常见本机安装目录检查，不启动进程。YAML 和 MCP SDK 在原生打包时显式 bundle，包含完整依赖许可证。

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
