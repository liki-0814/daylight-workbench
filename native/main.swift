import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKDownloadDelegate, WKUIDelegate {
    let server: WorkbenchServer
    var window: NSWindow!
    var web: WKWebView!
    var status: NSStatusItem!
    var launcher: Launcher!
    var timer: Timer?
    var actions: [String: () -> Void] = [:]
    init(_ server: WorkbenchServer) { self.server = server }
    func applicationDidFinishLaunching(_ notification: Notification) {
        do { try server.start { error in
            if let error { self.fail(error); NSApp.terminate(nil); return }
            self.setup()
        } } catch { fail(error); NSApp.terminate(nil) }
    }
    func fail(_ error: Error) { let alert = NSAlert(); alert.messageText = "Daylight"; alert.informativeText = error.localizedDescription; alert.runModal() }
    func item(_ title: String, key: String = "", action: @escaping () -> Void) -> NSMenuItem {
        let id = UUID().uuidString; actions[id] = action
        let result = NSMenuItem(title: title, action: #selector(performItem(_:)), keyEquivalent: key)
        result.target = self; result.representedObject = id; return result
    }
    @objc func performItem(_ sender: NSMenuItem) { if let id = sender.representedObject as? String { actions[id]?() } }
    func setup() {
        let menu = NSMenu()
        let appItem = NSMenuItem(); let appMenu = NSMenu(); appItem.submenu = appMenu; menu.addItem(appItem)
        appMenu.addItem(withTitle: "关于 Daylight", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(item("设置…", key: ",") { self.show("settings") })
        appMenu.addItem(.separator()); appMenu.addItem(withTitle: "隐藏 Daylight", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出 Daylight", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let file = NSMenuItem(title: "文件", action: nil, keyEquivalent: ""); let fm = NSMenu(); file.submenu = fm; menu.addItem(file)
        fm.addItem(item("新建任务", key: "n") { self.show("new") })
        let quick = item("快速搜索…") { self.launcher.toggle() }; quick.keyEquivalent = " "; quick.keyEquivalentModifierMask = [.option]; fm.addItem(quick)
        fm.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let edit = NSMenuItem(title: "编辑", action: nil, keyEquivalent: ""); let em = NSMenu(); edit.submenu = em; menu.addItem(edit)
        for (title, selector, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] { em.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key) }
        NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .aqua); window.backgroundColor = NSColor(calibratedRed: 0.97, green: 0.98, blue: 0.96, alpha: 1); window.title = "Daylight · 任务管理"; window.minSize = NSSize(width: 760, height: 560); window.isReleasedWhenClosed = false; window.center()
        let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: .zero, configuration: config); web.navigationDelegate = self; web.uiDelegate = self; window.contentView = web
        web.load(URLRequest(url: URL(string: server.endpoint + "/")!))
        launcher = Launcher(server: server); launcher.install()
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.image = NSImage(systemSymbolName: "checklist", accessibilityDescription: "Daylight")
        server.onChange = { [weak self] in self?.updateTray() }
        updateTray(); timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.updateTray() }
        show()
    }
    func applicationWillTerminate(_ notification: Notification) { launcher?.stop(); server.proxy.shutdown(); server.ai.shutdown() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { show(); return true }
    func show(_ route: String? = nil) {
        guard window != nil else { return }
        if let route { let hash = route + "&intent=" + UUID().uuidString; web.evaluateJavaScript("location.hash=\((try? jsonText(hash)) ?? "''")") }
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    func updateTray() {
        let snapshot = server.queue.sync { server.snapshot }
        let state = snapshot["state"] as! [String: Any], version = snapshot["version"] as! Int
        let tray = server.queue.sync { try! server.js("getTrayState(\(try! jsonText(state)),localDate())") as! [String: Any] }
        let tasks = tray["pending"] as! [[String: Any]]
        let projects = state["projects"] as! [[String: Any]]
        let today = tray["today"] as! [[String: Any]], other = tray["other"] as! [[String: Any]]
        let ids = today.map { $0["id"] as! String }
        status.button?.title = " 待办 \(tasks.count)"
        // Keep only application menu callbacks; discard closures owned by the previous tray menu.
        if let old = status.menu { clearActions(old) }
        let menu = NSMenu()
        func label(_ title: String) { let item = NSMenuItem(title: title, action: nil, keyEquivalent: ""); item.isEnabled = false; menu.addItem(item) }
        for (title, group) in [("今日任务", today), ("其他待办", other)] {
            label("\(title) · \(group.count)")
            if group.isEmpty { label(title == "今日任务" ? "今天暂无安排" : "暂无其他待办") }
            for task in group.prefix(8) {
                let id = task["id"] as! String, active = task["status"] as? String == "active"
                let parent = NSMenuItem(title: (active ? "▶ " : "") + (task["title"] as! String), action: nil, keyEquivalent: "")
                let sub = NSMenu(); parent.submenu = sub; menu.addItem(parent)
                let project = projects.first { $0["id"] as? String == task["projectId"] as? String }?["name"] as? String ?? "未归类"
                let info = NSMenuItem(title: project, action: nil, keyEquivalent: ""); info.isEnabled = false; sub.addItem(info)
                sub.addItem(item("标记完成") { self.apply(["type": "task.status", "id": id, "status": "done"], version) })
                sub.addItem(item(active ? "暂停任务" : "开始任务") { self.apply(["type": "task.status", "id": id, "status": active ? "todo" : "active"], version) })
                sub.addItem(item(ids.contains(id) ? "移出今天" : "加入今天") { self.apply(["type": ids.contains(id) ? "plan.remove" : "plan.add", "id": id], version) })
                sub.addItem(item("查看任务") { self.show("task=" + (id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? id)) })
            }
            if group.count > 8 { menu.addItem(item("查看全部…") { self.show(title == "今日任务" ? "today" : "all") }) }
            menu.addItem(.separator())
        }
        menu.addItem(item("新建任务…") { self.show("new") }); menu.addItem(item("快速搜索…") { self.launcher.toggle() }); menu.addItem(item("打开工作台") { self.show("today") })
        menu.addItem(item("打开数据目录") { NSWorkspace.shared.open(self.server.directory) })
        menu.addItem(.separator()); menu.addItem(withTitle: "退出 Daylight", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        status.menu = menu
    }
    func clearActions(_ menu: NSMenu) { for item in menu.items { if let id = item.representedObject as? String { actions.removeValue(forKey: id) }; if let sub = item.submenu { clearActions(sub) } } }
    func apply(_ action: [String: Any], _ version: Int) {
        var request = URLRequest(url: URL(string: server.endpoint + "/api/v1/actions")!); request.httpMethod = "POST"
        request.setValue("Bearer " + server.agentToken, forHTTPHeaderField: "Authorization"); request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? jsonData(["requestId": UUID().uuidString, "expectedVersion": version, "action": action])
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { DispatchQueue.main.async { self.fail(error) }; return }
            if (response as? HTTPURLResponse)?.statusCode != 200 {
                let object = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
                DispatchQueue.main.async { self.fail(Failure(message: object?["error"] as? String ?? "无法更新任务")) }
            }
        }.resume()
    }
    func isWorkbenchURL(_ url: URL) -> Bool {
        url.scheme == "http" && url.host == "127.0.0.1" && url.port == Int(server.port)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.shouldPerformDownload && (url.scheme == "blob" || url.absoluteString.hasPrefix(server.endpoint + "/")) { decisionHandler(.download) }
        else if isWorkbenchURL(url) { decisionHandler(.allow) }
        else if navigationAction.navigationType == .linkActivated && ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url); decisionHandler(.cancel) }
        else { decisionHandler(.cancel) }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if isWorkbenchURL(url) { webView.load(URLRequest(url: url)) }
            else if navigationAction.navigationType == .linkActivated && ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        }
        return nil
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel(); panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }
}

let env = ProcessInfo.processInfo.environment
let headless = CommandLine.arguments.contains("--headless")
if !headless, let existing = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == Bundle.main.bundleIdentifier && $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) { existing.activate(options: [.activateAllWindows]); exit(0) }
let resources = Bundle.main.resourceURL!
let directory = env["WORKBENCH_DATA_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Daylight")
do {
    let server = try WorkbenchServer(resources: resources, directory: directory, port: UInt16(env["PORT"] ?? "4318") ?? 4318)
    if headless {
        try server.start { error in if let error { fputs(error.localizedDescription + "\n", stderr); exit(1) }; print("READY"); fflush(stdout) }
        RunLoop.main.run()
    } else {
        let app = NSApplication.shared; app.setActivationPolicy(.regular)
        let delegate = AppDelegate(server); app.delegate = delegate; app.run()
    }
} catch { if headless { fputs(error.localizedDescription + "\n", stderr) } else { let alert = NSAlert(); alert.messageText = "Daylight 无法启动"; alert.informativeText = error.localizedDescription; alert.runModal() }; exit(1) }
