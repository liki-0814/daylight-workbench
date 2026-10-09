import AppKit
import WebKit
import UserNotifications

/// The injected delivery boundary runs only after the real durable intent consumer succeeds.
/// It lets storage failure and crash recovery be tested without contacting UserNotifications.
final class FocusNotificationConsumer {
    private let queue: DispatchQueue
    private let consume: (String) throws -> [String: Any]?
    private let settings: () throws -> [String: Any]
    private let deliver: ([String: Any], [String: Any]) -> Void
    private var consuming = Set<String>()
    private var active = true
    init(queue: DispatchQueue, consume: @escaping (String) throws -> [String: Any]?, settings: @escaping () throws -> [String: Any], deliver: @escaping ([String: Any], [String: Any]) -> Void) {
        self.queue = queue; self.consume = consume; self.settings = settings; self.deliver = deliver
    }
    func stop() { active = false; consuming.removeAll() }
    func process(_ snapshot: [String: Any], ready: Bool) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard active, ready, let outcome = snapshot["lastOutcome"] as? [String: Any], let id = outcome["id"] as? String,
              let notification = outcome["notification"] as? [String: Any], notification["state"] as? String == "pending", !consuming.contains(id) else { return }
        consuming.insert(id)
        queue.async {
            do {
                let consumed = try self.consume(id)
                let settings = try self.settings()
                DispatchQueue.main.async { self.consuming.remove(id); if let consumed, self.active { self.deliver(consumed, settings) } }
            } catch { DispatchQueue.main.async { self.consuming.remove(id) } }
        }
    }
}

/// GUI-only permission bridge and consumer of already-persisted notification intents.
final class FocusNotifications: NSObject, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    private let server: WorkbenchServer
    private let center = UNUserNotificationCenter.current()
    private let show: (String) -> Void
    private weak var web: WKWebView?
    private var requests = Set<String>()
    private var active = true
    private var permission = "unavailable"
    private var statusReady = false
    private lazy var consumer: FocusNotificationConsumer = {
        let server = server
        return FocusNotificationConsumer(queue: server.queue, consume: { try server.focus.consumeNotification($0) }, settings: {
            try server.focus.snapshot(reconcileFirst: false)["settings"] as? [String: Any] ?? [:]
        }, deliver: { [weak self] outcome, settings in self?.deliver(outcome, settings: settings) })
    }()
    init(server: WorkbenchServer, show: @escaping (String) -> Void) { self.server = server; self.show = show; super.init() }
    func attach(_ web: WKWebView) { self.web = web; center.delegate = self; refreshPermission() }
    func stop() { active = false; requests.removeAll(); consumer.stop(); web?.configuration.userContentController.removeScriptMessageHandler(forName: "focusNotifications"); center.delegate = nil; web = nil }
    private func status(_ settings: UNNotificationSettings) -> [String: Any] {
        let permission: String
        switch settings.authorizationStatus {
        case .notDetermined: permission = "default"
        case .denied: permission = "denied"
        case .authorized, .provisional: permission = "granted"
        @unknown default: permission = "unavailable"
        }
        func enabled(_ setting: UNNotificationSetting) -> Any {
            switch setting { case .enabled: return true; case .disabled: return false; default: return NSNull() }
        }
        return ["mode": "native", "notifications": "system", "permission": permission, "notificationPermission": permission, "alertEnabled": enabled(settings.alertSetting), "soundEnabled": enabled(settings.soundSetting)]
    }
    func refreshPermission() { readStatus { _ in } }
    private func readStatus(_ completion: @escaping ([String: Any]) -> Void) {
        center.getNotificationSettings { [weak self] settings in
            DispatchQueue.main.async {
                guard let self, self.active else { return }
                let status = self.status(settings); self.permission = status["permission"] as! String; self.statusReady = true
                self.server.updateFocusPlatform(status); completion(status)
            }
        }
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard active, message.name == "focusNotifications", message.frameInfo.isMainFrame,
              origin.protocol == "http", origin.host == "127.0.0.1", origin.port == Int(server.port), message.webView === web,
              let body = message.body as? [String: Any], Set(body.keys) == Set(["requestId", "op"]),
              let id = body["requestId"] as? String, matches(id, "^[a-zA-Z0-9_-]{8,100}$"),
              let op = body["op"] as? String, ["getStatus", "authorize", "openSettings"].contains(op), !requests.contains(id) else { return }
        requests.insert(id)
        if op == "authorize" {
            center.requestAuthorization(options: [.alert, .sound]) { [weak self] _, error in
                DispatchQueue.main.async {
                    self?.readStatus { self?.reply(id, status: $0, error: error?.localizedDescription) }
                }
            }
        } else if op == "openSettings" {
            let opened = NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.notifications")!)
            readStatus { self.reply(id, status: $0, error: opened ? nil : "请打开系统设置 → 通知 → Daylight，调整提醒权限") }
        } else { readStatus { self.reply(id, status: $0) } }
    }
    private func reply(_ id: String, status: [String: Any], error: String? = nil) {
        guard active, requests.remove(id) != nil, let web, let url = web.url,
              url.scheme == "http", url.host == "127.0.0.1", url.port == Int(server.port) else { return }
        var response: [String: Any] = ["requestId": id, "ok": error == nil, "permission": status["permission"]!, "alertEnabled": status["alertEnabled"]!, "soundEnabled": status["soundEnabled"]!]
        if let error { response["error"] = error }
        guard let literal = try? jsonText(response) else { return }
        web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('daylight-focus-notification-reply',{detail:\(literal)}))")
    }
    func process(_ snapshot: [String: Any]) {
        consumer.process(snapshot, ready: active && statusReady)
    }
    private func deliver(_ outcome: [String: Any], settings: [String: Any]) {
        let id = outcome["id"] as! String
        guard permission == "granted" else { recordResult(id, error: "系统提醒尚未授权，请在专注设置中开启"); return }
        let content = UNMutableNotificationContent()
        content.title = outcome["phase"] as? String == "work" ? "专注计时完成" : "短休息结束"
        content.body = outcome["taskTitleSnapshot"] as? String ?? "本轮计时已保存，可以开始下一轮。"
        if settings["soundEnabled"] as? Bool == true { content.sound = .default }
        var route = "focus"
        if let task = outcome["taskId"] as? String { var allowed = CharacterSet.urlQueryAllowed; allowed.remove(charactersIn: "&=+#?"); route = "task=" + (task.addingPercentEncoding(withAllowedCharacters: allowed) ?? task) }
        content.userInfo = ["route": route]
        let requestId = (outcome["notification"] as? [String: Any])?["requestId"] as? String ?? "focus-"+id
        center.add(UNNotificationRequest(identifier: requestId, content: content, trigger: nil)) { [weak self] error in self?.recordResult(id, error: error?.localizedDescription) }
    }
    private func recordResult(_ id: String, error: String?) {
        server.queue.async { try? self.server.focus.notificationResult(id, error: error) }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) { completionHandler([.banner, .sound]) }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let route = response.notification.request.content.userInfo["route"] as? String ?? "focus"
        DispatchQueue.main.async { if self.active { self.show(route) }; completionHandler() }
    }
}
