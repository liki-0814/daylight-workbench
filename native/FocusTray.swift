import AppKit

/// Menu display and user controls only; timers and durable decisions belong to Focus.
final class FocusTray {
    private let server: WorkbenchServer
    private let show: (String) -> Void
    private let fail: (Error) -> Void
    private var snapshot: [String: Any] = [:]
    private var receivedAt: TimeInterval = 0
    private weak var countdownItem: NSMenuItem?
    init(server: WorkbenchServer, show: @escaping (String) -> Void, fail: @escaping (Error) -> Void) { self.server = server; self.show = show; self.fail = fail }
    func update(_ value: [String: Any]) { snapshot = value; receivedAt = ProcessInfo.processInfo.systemUptime; updateText() }
    private var current: [String: Any]? { snapshot["current"] as? [String: Any] }
    private var text: String {
        guard let current else { return snapshot["error"] == nil ? "专注 · 未开始" : "专注暂不可用" }
        let phase = current["phase"] as? String == "work" ? "专注" : "休息"
        let running = current["status"] as? String == "running"
        let seconds = max(0, Int(ceil(((current["remainingMs"] as? NSNumber)?.doubleValue ?? 0)/1000 - (running ? ProcessInfo.processInfo.systemUptime-receivedAt : 0))))
        return "\(running ? phase : "已暂停") \(String(format: "%02d:%02d", seconds/60, seconds%60))"
    }
    func title(pendingCount: Int) -> String {
        (snapshot["settings"] as? [String: Any])?["showTrayTimer"] as? Bool == true && current != nil ? " " + text : " 待办 \(pendingCount)"
    }
    func updateText() { countdownItem?.title = text }
    func items(make: (String, @escaping () -> Void) -> NSMenuItem) -> [NSMenuItem] {
        let header = NSMenuItem(title: text, action: nil, keyEquivalent: ""); header.isEnabled = false; countdownItem = header
        var result = [header]
        if let current, let id = current["id"] as? String {
            if let title = current["taskTitleSnapshot"] as? String {
                let task = NSMenuItem(title: title, action: nil, keyEquivalent: ""); task.isEnabled = false; result.append(task)
            }
            let paused = current["status"] as? String == "paused"
            result.append(make(paused ? "继续专注" : "暂停专注") { self.perform(["type": paused ? "focus.resume" : "focus.pause", "sessionId": id]) })
            result.append(make("结束本轮") { self.perform(["type": "focus.finish", "sessionId": id]) })
        } else if snapshot["error"] == nil {
            result.append(make("开始专注…") { self.show("today") })
            result.append(make("开始短休息") { self.perform(["type": "focus.start", "phase": "shortBreak"]) })
        }
        result.append(make("查看专注统计") { self.show("focus") })
        result.append(.separator())
        return result
    }
    func start(taskId: String) {
        server.focusSnapshot { result in
            switch result {
            case .failure(let error): self.fail(error)
            case .success(let snapshot):
                var action: [String: Any] = ["type": "focus.start", "phase": "work", "taskId": taskId]
                if let current = snapshot["current"] as? [String: Any], let id = current["id"] as? String {
                    let alert = NSAlert(); alert.messageText = "切换专注任务？"; alert.informativeText = "当前轮次将提前结束并保留计时记录，随后开始所选任务。任务状态不会改变。"
                    alert.addButton(withTitle: "切换"); alert.addButton(withTitle: "取消")
                    guard alert.runModal() == .alertFirstButtonReturn else { return }
                    action["type"] = "focus.switch"; action["sessionId"] = id
                }
                self.perform(action)
            }
        }
    }
    private func perform(_ action: [String: Any]) {
        server.applyFocus(action) { code, value in
            if code != 200 { self.fail(Failure(message: (value as? [String: Any])?["error"] as? String ?? "专注操作失败，请核对状态")) }
        }
    }
}
