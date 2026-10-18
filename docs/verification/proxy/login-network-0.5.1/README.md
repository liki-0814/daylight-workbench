# 0.5.1 macOS 登录修复验证

验证日期：2026-10-19（Asia/Shanghai）。

## 故障与修复

已安装的 0.5.0 App 中，Copilot 和 Grok 的授权初始化均返回 HTTP 502，页面显示统一的“操作失败”。同一 Node 可执行文件在清空 shell 环境后访问授权服务返回 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`；本机 Homebrew 的 OpenSSL 默认证书文件不存在。显式启用 Node 内置证书后恢复 HTTP 200，TLS 校验未关闭。

原生父进程现在启用内置公共根证书，并在支持的 Node 版本加载系统信任证书；通过 CFNetwork 读取系统 HTTP/HTTPS 代理。六个来源的授权、OIDC、续期、目录、额度与推理使用共享网络层，保留显式环境变量优先级和本机直连。错误边界区分证书、网络、超时与钥匙串故障，回调错误不再被页面覆盖成不明原因的登录失败。

AGY 的默认本机配置缺失时，自动只读检测已安装官方 agy / Antigravity 二进制中的已知 consumer OAuth 客户端参数。以公开客户端指纹确认一对参数，不执行客户端，不将参数写入源码、安装包或验证输出，不因自动检测扩大旧 CLI 登录的兼容导入。显式无效配置仍保留报错。

## 验证结果

- `npm run check` 通过。
- Node 自动测试：462 项全部通过；另复核 AGY 自动检测及独立授权测试 16 项通过。
- `python3 test/native-proxy-test.py` 通过：打包 Swift → Node → 网关、流式、生命周期、鉴权和运行环境恢复。
- `python3 test/native-credentials-test.py` 通过：13 个隔离契约场景，未调用真实 Security API。
- 无 shell 代理或证书变量的打包 App：六个来源均成功发起授权、返回等待状态并可取消，详情见 [native.json](native.json)。AGY 自动检测成功；Google 授权端点返回 HTTP 302，进入 `/v3/signin/identifier`。
- 隔离 Chrome 在 1280 / 720 两个窗口宽度实际切换六个来源页，检查共享账号栏锚点、登录／取消、键盘与焦点、模型加载／空／错误状态、回调错误保留和无横向溢出，无页面脚本错误。账号栏内容不同导致的窄窗口高度差为现有布局行为，本次未改样式。测量记录见 [browser.json](browser.json)，模拟证书错误截图见 [宽窗口](tls-error-1280.png) / [窄窗口](tls-error-720.png)。截图使用模拟授权码。
- 安装包 `codesign --verify --deep --strict` 和 DMG 校验通过。已将本机 App 更新至 0.5.1；原 0.5.0 App 保留在 `.local/backups/Daylight-0.5.0-before-login-fix.app`。更新前后任务状态文件和 Agent token 的摘要一致。

真实账号的浏览器确认、授权码交换及套餐推理仍需账号持有人完成，以上真实网络检查不代表已完成这些步骤；回调、令牌保存、续期和账号隔离由模拟上游回归覆盖。

完整测试还暴露了 Copilot 测试夹具在服务关闭前删除目录的清理竞争，已调整为先关闭服务再删除临时目录，避免后台写入造成 `ENOTEMPTY`。

## 安装包

`dist/Daylight-0.5.1-arm64.dmg`

SHA-256：`7bf2d6fda25115a03e04473a0554a204c43de5a52a78f5a749a1d6dda7f61da0`
