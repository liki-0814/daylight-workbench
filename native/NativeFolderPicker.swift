import AppKit
import WebKit

/// Native folder picker for Skill import (PR-8). UNVERIFIED: written without a Swift toolchain; compile and try it on a Mac.
///
/// Menu-less bridge: the page calls `window.webkit.messageHandlers.pickFolder.postMessage({requestId})`; the shell opens an NSOpenPanel
/// (folders only, one selection) as a sheet on the main window and answers with a window event
/// `daylight-folder-picked` whose `detail` is `{requestId, ok, path?, cancelled?, error?}`.
/// The page only ever learns the folder the user explicitly picked; it cannot name a path, a start folder or any option.
/// Without this handler (older shell, non-mac browser) `window.webkit?.messageHandlers?.pickFolder` is undefined and the page falls back to a typed path.
final class NativeFolderPicker: NSObject, WKScriptMessageHandler {
    static let messageName = "pickFolder", eventName = "daylight-folder-picked"
    private let port: Int
    private let window: () -> NSWindow?
    private weak var web: WKWebView?
    private var pending: String?
    private var active = true
    init(port: Int, window: @escaping () -> NSWindow?) { self.port = port; self.window = window; super.init() }
    func attach(_ web: WKWebView) { self.web = web }
    func stop() { active = false; pending = nil; web?.configuration.userContentController.removeScriptMessageHandler(forName: NativeFolderPicker.messageName); web = nil }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard active, message.name == NativeFolderPicker.messageName, message.frameInfo.isMainFrame,
              origin.protocol == "http", origin.host == "127.0.0.1", origin.port == port, message.webView === web,
              let body = message.body as? [String: Any], Set(body.keys) == Set(["requestId"]),
              let id = body["requestId"] as? String, matches(id, "^[a-zA-Z0-9_-]{8,100}$") else { return }
        guard pending == nil else { reply(id, ["ok": false, "error": "已经有一个选择文件夹的窗口打开了"]); return }
        guard let window = window(), window.isKeyWindow else { reply(id, ["ok": false, "error": "请先切换到 Daylight 主窗口再选择文件夹"]); return }
        pending = id
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false; panel.canCreateDirectories = false
        panel.resolvesAliases = true; panel.prompt = "选择"; panel.message = "选择要导入的 Skill 文件夹"
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self, self.active, self.pending == id else { return }
            self.pending = nil
            guard response == .OK, let url = panel.url else { self.reply(id, ["ok": false, "cancelled": true]); return }
            let path = url.standardizedFileURL.path
            guard path.hasPrefix("/"), !path.contains("\0") else { self.reply(id, ["ok": false, "error": "无法读取所选文件夹的位置"]); return }
            self.reply(id, ["ok": true, "path": path])
        }
    }
    private func reply(_ id: String, _ fields: [String: Any]) {
        guard active, let web, let url = web.url, url.scheme == "http", url.host == "127.0.0.1", url.port == port else { return }
        var detail = fields; detail["requestId"] = id
        guard let literal = try? jsonText(detail) else { return }
        web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('\(NativeFolderPicker.eventName)',{detail:\(literal)}))")
    }
}
