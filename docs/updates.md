# 应用内更新

Daylight 可以在应用内检查、下载、校验并替换自身。更新只来自本仓库 [GitHub Releases](https://github.com/liki-0814/daylight-workbench/releases)，所有步骤都在本机完成，不上传任何数据。入口是侧栏「更新」页（`#update`）、菜单「Daylight → 检查更新…」；设置页只保留跳转链接。

## 流程

1. **检查**：启动 30 秒后、之后每 6 小时、窗口回到前台且距上次成功检查超过 6 小时时检查；失败按 15 分钟起指数退避，最长 6 小时。GitHub 结果沿用原有缓存（成功 6 小时，失败 15 分钟），「检查更新」跳过缓存。
2. **验证清单**：发布必须带有 `Daylight-<版本>-arm64.zip`、`latest-mac.json` 和 `latest-mac.json.sig`。清单内容（版本、地址、大小、SHA-256、最低系统、日期、是否允许降级）由内置公钥验证 Ed25519 签名；清单的地址必须与发布附件一致，且只接受 `https://github.com/liki-0814/daylight-workbench/releases/download/` 前缀。
3. **下载**：Swift 层 `URLSession` 下载到 `~/Library/Application Support/Daylight/updates/<版本>/`（目录权限 0700）。同一时间只保留一个版本，可随时取消。
4. **校验**：大小与 SHA-256 对照清单，并在 GitHub 提供 `digest` 时再对照一次；`ditto` 解压；`codesign --verify --strict --deep`；Bundle ID、版本号必须高于当前（除非清单明确 `downgradeable`）；新包的 designated requirement 必须与当前 App 完全一致，否则判定为「签名身份变化」，不安装并提示去 GitHub 手动下载。
5. **空闲检查**：安装前检查反向代理的活动请求和运行中/等待确认的 AI 对话；不空闲时弹窗确认，可选择稍后。
6. **替换**：随包的 `DaylightUpdater` 辅助程序被复制到更新目录后运行。它等待主进程退出（最多 30 秒），用 `renamex_np(RENAME_SWAP)` 原子交换新旧 App，再次校验，然后打开新 App。新 App 启动后写入 `health.json`；辅助程序在 60 秒内没看到它则自动换回旧版本并重新打开。成功后上一版本作为唯一备份保留在 `updates/backup/`，可在更新页「回滚」。结果写入 `last-result.json` 并进入更新历史，下次显示更新页时展示。
7. **不会做的事**：不写隔离属性（quarantine），所以无需 Gatekeeper 放行；不触碰设置、任务、凭据文件；失败时旧 App 保持原样。

## 自动更新模式

在更新页「自动更新」选择，默认 **仅提醒**：

| 模式 | 行为 |
| --- | --- |
| 仅提醒 | 只提示有新版本，由你点击下载、安装 |
| 退出时安装 | 自动下载并校验；下次退出 Daylight 时静默安装（辅助程序在无界面状态下自检新版本，不弹出窗口） |
| 下载后提示重启 | 自动下载并校验，就绪后提示重启安装；可选择稍后 |

自动下载失败的版本会被记住，不会反复重试；手动检查可重试。

## 不能在应用内更新的情况

更新页会给出原因并保留 DMG 下载链接：

- 当前版本是 ad-hoc 签名（见下方迁移说明）或没有签名。
- 从 DMG 或隔离状态（App Translocation）里运行；请先拖进「应用程序」。
- App 所在目录当前用户不可写。
- 构建没有内置更新公钥。
- 网页版（`server.mjs`）：只检查，不提供安装。

## 一次性迁移：从 ad-hoc 到自签名

早期版本使用 ad-hoc 签名，其身份会随每次构建改变，所以无法保证新旧版本是同一发布者。第一个使用固定自签名证书「Daylight Release Code Signing」的版本需要：

1. 从 GitHub Release 下载 DMG，手动拖进「应用程序」覆盖一次。
2. 首次打开后，因为签名身份变了，系统会让你**重新授权一次**通知、日历等 TCC 权限，凭据（Keychain 里 Daylight 保存的登录）也会被询问或需要重新登录一次。
3. 此后所有更新保持同一身份，权限和 Keychain 访问不再重置。

自签名证书不被 Gatekeeper 信任，这是预期的：用户首次从 DMG 安装仍需按系统提示放行；应用内更新不经过 Gatekeeper 流程。凭据辅助程序 `DaylightCredentials`、`DaylightAgyCredentials` 的二进制内容在构建间保持不变（`native/Credentials.swift` 不应随意修改），否则其签名摘要改变会触发 Keychain 重新授权。

## 预发布版本（beta）

`package.json` 可以是 `0.7.0-beta.1` 这样的预发布版本号，但 macOS 的 `CFBundleShortVersionString` / `CFBundleVersion` 只接受最多三段整数。`scripts/build-native.py` 因此把这两个键写成数字核心 `0.7.0`，完整版本号写进自定义键 `DaylightVersion`；更新器、`/api/update` 的当前版本、更新包校验（`UpdaterHelper`）都优先读 `DaylightVersion`，没有这个键的旧版本回退到 `CFBundleShortVersionString`。

- 比较遵循 SemVer：`0.7.0-beta.1 < 0.7.0-beta.2 < 0.7.0`。beta 用户会被提示更新到正式版 `0.7.0`；正式版不会被提示"更新"到 beta。
- 发布侧（清单、tag、下载地址、更新包名）仍只接受严格的 `x.y.z`：预发布版本不会作为更新发布，GitHub 标记为 prerelease 或 tag 带后缀的发布一律不被当作更新。
- `check-version.mjs --app` 会检查 `CFBundle*` 等于数字核心，并用 `DaylightVersion` 与 package.json 对账。
- 未验证：Swift 与 macOS 打包部分（本机是 Linux，无法编译或跑 `native-updater-test.py`），需要在 macOS 上构建一个 beta 包确认 `plutil -lint` 与更新流程。

## 发布流程（维护者）

签名材料只在发布机器上，不进仓库，也不要提交到任何地方：

- `~/.daylight-signing/release.keychain-db`：专用钥匙串，保存自签名代码签名证书（10 年）；密码在 `keychain-password`（权限 600）。
- `~/.daylight-signing/update-ed25519.pem`：Ed25519 更新签名私钥；公钥已写入 `build/update-public-key.txt`，构建时嵌入 Info.plist 的 `DaylightUpdatePublicKey`。
- 首次准备：`bash scripts/release/setup-signing.sh`（已存在材料时不会覆盖）。请**备份整个 `~/.daylight-signing` 目录**；丢失私钥意味着已安装的 App 无法再验证新更新，只能手动重装。

发布一个版本：

```bash
# 1. 版本号：package.json、package-lock.json 一致，并在 Release 里写更新说明
node scripts/release/check-version.mjs

# 2. 用发布证书构建（不设置这些变量则是 ad-hoc 构建，CI 即如此）
export DAYLIGHT_SIGN_IDENTITY=$(cat ~/.daylight-signing/release-cert.sha1)
export DAYLIGHT_SIGN_KEYCHAIN=~/.daylight-signing/release.keychain-db
export DAYLIGHT_SIGN_KEYCHAIN_PASSWORD_FILE=~/.daylight-signing/keychain-password
npm run dist:mac            # dist/Daylight-<版本>-arm64.dmg 与 dist/native/Daylight.app

# 3. 生成更新包与签名清单
node scripts/release/package-update.mjs --tag v<版本>   # dist/update/
```

把 DMG、`Daylight-<版本>-arm64.zip`、`latest-mac.json`、`latest-mac.json.sig` 上传到**同一个** GitHub Release（正式发布，非草稿/预发布）。`package-update.mjs` 会校验版本一致、App 签名有效、私钥与仓库公钥匹配，并在写出前用公钥验证一次生成的签名。

## 更新页

`public/update-page.js` 与 `public/update.css` 复用设置页的版式和通用组件。页面展示仓库地址（打开/复制）、当前与最新版本、渲染后的完整更新说明（Markdown 经净化）、检查/下载并安装/重启/取消操作与进度、自动更新模式、更新历史与回滚；每种状态（检查中、已是最新、有更新、下载中、已就绪、安装中、失败、需要重新授权、不支持、网页版）都有对应展示，状态变化通过 `aria-live` 播报，键盘与焦点保持可用。

接口：`GET /api/app/update`（发布信息，`?refresh=1` 跳过缓存）与 `GET/POST /api/app/updater`（更新器状态与操作：`download`、`cancel`、`discard`、`install`、`rollback`、`ack`、`mode`）。后者需要 `x-workbench-token`，POST 另要求同源 `Origin`。

## 测试

- `npm test`：版本比较、清单与附件选择、URL 白名单、摘要比对、Ed25519 验证（正确/被篡改/错误公钥）、拒绝降级、畸形清单（`test/app-update.test.mjs`、`test/update-security.test.mjs`、`test/sidebar.test.mjs`）。
- `node scripts/verify-update-browser.mjs <输出目录>`：在 760/1240/1440 宽度下用 Playwright 跑更新页验收（导航顺序、设置↔更新公共控件位置、检查→下载→进度→取消→就绪→确认→安装、键盘与焦点、历史与回滚、各状态、无横向溢出）。需要 `DAYLIGHT_PLAYWRIGHT_MODULE` 与 `DAYLIGHT_CHROME_EXECUTABLE`。
- `python3 test/native-updater-test.py`：仅 macOS，需要设置 `DAYLIGHT_TEST_APP_OLD`、`DAYLIGHT_TEST_APP_NEW`（两个用同一证书、隔离 Bundle ID 构建的旧/新版本）与 `DAYLIGHT_TEST_UPDATE_DIR`（`package-update.mjs` 对新版本的输出）。它在隔离数据目录和随机端口运行真实 App，用本地模拟 GitHub 服务验证：完整更新与回滚、篡改包/伪造签名/同版本拒绝、不健康版本自动回滚、退出时（无界面）安装、ad-hoc 不支持。未设置变量时打印 skipped。测试环境变量 `DAYLIGHT_UPDATE_TEST_BASE` 只在设置了 `WORKBENCH_DATA_DIR` 且端口不是 4318 时才生效，正式运行不能被重定向到其他服务器。
