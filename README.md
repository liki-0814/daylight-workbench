# Daylight

本地运行的个人工作台，将项目任务、每日安排、AI 对话和模型中转集中在一个界面中。支持网页运行，也提供轻量的 macOS 原生应用。

任务管理可以独立使用。AI 与反向代理按需启用，项目目录关联用于记录和打开路径。

## 功能

- **项目与任务**：项目管理、任务备注、状态切换、每日安排、关键词搜索和最近一次操作撤销。
- **macOS 桌面**：菜单栏任务入口、窗口关闭后驻留，以及 `⌥Space` 快速搜索。
- **AI 对话**：连接本机 Codex 或 Qoder CLI，支持流式回答、历史会话、对话引用和变更草稿。
- **模型中转**：Qoder、AGY、Grok、Codex 与自定义上游共用接入地址、API Key 和服务开关。
- **请求诊断**：统一查看来源状态、请求结果、阶段耗时、模型映射及上游实际返回的用量。

## 快速启动

需要 **Node.js 22 或更新版本**。

```sh
git clone https://github.com/liki-0814/daylight-workbench.git
cd daylight-workbench
npm ci --ignore-scripts
npm start
```

打开 <http://127.0.0.1:4318>。首次启动是空工作台，项目与任务由你创建。

安装依赖时跳过 SDK 的下载脚本；AI 使用已经安装并登录的本机 CLI。只使用任务管理时无需配置模型账号。

开发时自动重启服务：

```sh
npm run dev
```

可使用独立端口与数据目录启动测试实例：

```sh
PORT=4328 WORKBENCH_DATA_DIR="$PWD/.local/dev" npm start
```

## macOS 应用

当前构建目标为 **Apple Silicon，macOS 13 或更新版本**。构建需要 Node.js 22+、Python 3 和 Xcode Command Line Tools。

```sh
npm ci --ignore-scripts
npm run pack:mac
open dist/native/Daylight.app
```

生成 DMG：

```sh
npm run dist:mac
```

产物位于 `dist/`。原生外壳使用 AppKit、WKWebView 和 JavaScriptCore；任务管理无需 Node.js，AI 与反向代理需要本机 Node.js。Node、Codex 和 Qoder CLI 均不内置。

当前使用本地 ad-hoc 签名，尚未配置 Apple Developer ID 签名和公证。桌面应用与网页服务默认共用 4318 端口，请分别启动。详见 [macOS 应用说明](docs/native-app.md)。

## AI 与反向代理

AI 对话使用本机 CLI 登录。工作台数据变更先生成可编辑草稿，由用户应用；Codex 的命令与文件审批在对话中处理。详见 [AI 对话说明](docs/ai.md)。

反向代理默认手动开启，默认地址为 `http://127.0.0.1:4319/v1`。在页面中配置来源、启用模型，并将页面显示的地址和 Key 填入客户端。

提供以下接口：

```text
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
POST /v1/messages
```

不同来源支持的参数与协议有差异；无法表示的跨协议字段会明确报错。同名模型需要设置别名或停用其中一个来源。请求记录只保存诊断元数据，缺失用量显示为“未提供”。详见 [反向代理说明](docs/reverse-proxy.md)。

## 数据与本地接口

默认数据目录是 `~/Library/Application Support/Daylight/`，网页与桌面应用共用。写入采用原子替换和版本检查，并保留上一版业务数据。`WORKBENCH_DATA_DIR` 可以覆盖默认目录。

服务只监听 `127.0.0.1`。工作台管理接口和模型中转分别使用鉴权凭据；自定义上游密钥由 macOS Keychain 保存。模型请求会发往你配置的上游，AI 对话会调用本机 CLI。

仓库和安装包不包含个人任务、账号凭据、对话历史或运行日志。外部工具可使用随仓库提供的 [Daylight skill](skills/daylight-workbench/SKILL.md) 管理工作台数据。

## 开发

```sh
npm run check
npm test
```

macOS 原生集成测试需要先构建 App：

```sh
npm run pack:mac
npm run test:native
python3 test/native-proxy-test.py
python3 test/native-ai-test.py
```

Node 测试使用临时数据目录与模拟上游；原生测试针对实际 App 二进制。测试通过不代表真实账号或所有上游能力都已验证。

| 目录 | 职责 |
| --- | --- |
| `public/` | 网页、交互组件与样式 |
| `native/` | macOS 外壳、菜单栏与本地服务 |
| `ai/` | AI 会话、CLI 适配和业务工具 |
| `gateway/` | 公共协议、自定义上游、请求记录与来源状态 |
| `qoder/`、`agy/`、`grok/` | 各来源的认证和推理适配 |
| `skills/` | 外部工作台管理 skill |
| `test/` | 单元测试和集成测试 |

更多实现约定见 [开发说明](docs/development.md)，贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

Daylight 原创代码采用 [MIT License](LICENSE)。第三方代码与依赖适用各自许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
