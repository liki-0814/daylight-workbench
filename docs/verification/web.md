# Web 启动与调试验收

日期：2026-10-09。在 codex/extensions-management 分支扩展现有 Node 入口，不创建第二套业务服务；不打包、不替换安装 App、不推送远端。

| 验证 | 结果 |
| --- | --- |
| 静态检查 | npm run check 通过 |
| 完整回归 | npm test：322/322，失败 0、跳过 0 |
| Web 入口 | test/web.test.mjs：从仓库外工作目录启动，源码资源可访问；HTTP 就绪后才打开浏览器；--no-open 不打开浏览器 |
| 数据和生命周期 | 真实任务保存及 SIGTERM 停止、端口释放、重启持久化、Token 换新、扩展独立初始化及 AI 接口鉴权通过 |
| 启动失败 | 已占用端口、无效端口在初始化业务数据前退出；原实例仍可访问，未创建来源或打开浏览器 |
| 本机 CLI | [实际 npm Web 入口](web-cli.json)：Codex 8 个模型、Qoder 17 个模型；复用本机登录，未发送推理请求 |
| 断点入口 | [实际 npm dev:debug](web-debug.json)：Web 可访问，Node inspector 在本机 9229 提供当前 Node target |

浏览器界面和业务 API 沿用已经验收的[扩展管理实现](extensions.md)；本次没有修改页面，也没有重复计算此前 13 条浏览器验收。新增启动和调试验收使用临时数据/来源/客户端/Pi 目录。CLI 自身的凭据刷新和缓存遵循原生规则，不能将 Daylight 写入隔离表述为 CLI 进程完全只读。

普通 Web 启动：npm run web。后端 watch 调试：PORT=4328 WORKBENCH_DATA_DIR="$PWD/.local/web-dev" npm run dev；前端修改后刷新页面，无需构建。断点模式使用同样环境变量运行 npm run dev:debug。业务隔离不自动隔离扩展写入，合成内容演练见[完整隔离命令](../extensions.md)。
