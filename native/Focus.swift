import Foundation
import JavaScriptCore
import CryptoKit
import Darwin

private struct FocusRequestFailure: LocalizedError {
    let status: Int
    let value: [String: Any]
    var errorDescription: String? { value["error"] as? String }
}

/// IO and scheduling adapter. The only focus authority is __focusRecord in server.queue's JSContext.
final class Focus {
    private let engine: JSContext
    private let queue: DispatchQueue
    private let directory: URL
    private let getTasks: () -> [String: Any]
    private let onChanged: () -> Void
    private var timer: DispatchWorkItem?
    private var lastWall: Int64?
    private var lastMonotonic: TimeInterval?
    private var pendingTasks: [[String: Any]] = []
    private var failure: String?
    private var retryDelay: Double = 1
    private var storedBytes = 0
    private var bridgedTaskVersion: Int?
    private let diagnostics = ProcessInfo.processInfo.environment["WORKBENCH_FOCUS_DIAGNOSTICS"] == "1"
    var runtime: [String: Any] = ["mode": "native", "notifications": "unavailable", "notificationPermission": "unavailable", "alertEnabled": NSNull(), "soundEnabled": NSNull()]
    private var file: URL { directory.appendingPathComponent("focus.json") }
    private var now: Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded(.down)) }
    private var platform: [String: Any] { var value = runtime; value["historyBytes"] = storedBytes; value["largeHistory"] = storedBytes > 10 * 1024 * 1024; return value }

    init(engine: JSContext, queue: DispatchQueue, directory: URL, getTasks: @escaping () -> [String: Any], onChanged: @escaping () -> Void) {
        self.engine = engine; self.queue = queue; self.directory = directory; self.getTasks = getTasks; self.onChanged = onChanged
        do {
            let data: Data
            do { data = try Data(contentsOf: file) }
            catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError {
                let initial = try text("JSON.stringify(Daylight.initialFocusRecord({timeZone:\(try jsonText(FocusTimeZone.initial))}))")
                data = Data(initial.utf8)
                try writeExclusive(data, to: file)
            }
            guard let raw = String(data: data, encoding: .utf8) else { throw Failure(message: "专注文件必须使用 UTF-8") }
            storedBytes = data.count
            _ = try text("globalThis.__focusRecord=JSON.parse(\(try jsonText(raw))); Daylight.validateFocusRecord(__focusRecord); 'ok'")
            let timeZone = try json("__focusRecord.settings.statisticsTimeZone") as! String
            guard (timeZone == "UTC" || timeZone.contains("/")), TimeZone(identifier: timeZone) != nil else { throw Failure(message: "专注统计时区无效，原文件已保留") }
            // Compile one bridge. Repeated reports pass JSON arguments instead of generating
            // unique scripts containing the full task state and civil-day windows.
            _ = try text("""
            globalThis.__focusNative=(operation,raw)=>{
              const input=JSON.parse(raw);
              switch(operation){
                case 'tasks': globalThis.__focusTaskState=input; return 'ok';
                case 'reconcile': globalThis.__focusDecision=Daylight.reconcileFocus(__focusRecord,{...input,taskState:__focusTaskState}); return 'ok';
                case 'selection': globalThis.__focusSelection=Daylight.validateFocusQuery(input.kind,input.pairs); return 'ok';
                case 'query': return JSON.stringify(Daylight[input.function](__focusRecord,__focusSelection,input.context));
                case 'snapshot': return JSON.stringify(Daylight.focusSnapshot(__focusRecord,input));
                case 'task-summary': return JSON.stringify(Daylight.focusTaskSummary(__focusRecord,input.taskId,input.context));
                case 'fingerprint': return Daylight.fingerprintText(input.raw);
                case 'replay': return String(__focusRecord.receipts.some(r=>r.requestId===JSON.parse(input.raw).requestId));
                case 'prepare': return JSON.stringify(Daylight.prepareFocusAction(__focusRecord,JSON.parse(input.raw),{...input.context,taskState:__focusTaskState}));
                case 'write': globalThis.__focusDecision=Daylight.prepareFocusWrite(__focusRecord,JSON.parse(input.raw),input.fingerprint,{...input.context,taskState:__focusTaskState}); return 'ok';
              }
              throw new Error('Unknown native focus operation');
            }; 'ok'
            """)
            do { try reconcile(recovering: true) } catch { scheduleRetry() }
            if diagnostics, CommandLine.arguments.contains("--headless"), CommandLine.arguments.contains("--focus-benchmark-consume"),
               let outcome = try json("__focusRecord.lastOutcome") as? [String: Any],
               let notification = outcome["notification"] as? [String: Any], notification["state"] as? String == "pending", let id = outcome["id"] as? String {
                let started = ProcessInfo.processInfo.systemUptime
                _ = try consumeNotification(id)
                fputs((try jsonText(["focusDiagnostics": true, "consumeMs": (ProcessInfo.processInfo.systemUptime-started)*1000]))+"\n", stderr)
            }
        } catch {
            failure = error.localizedDescription
        }
    }

    private func text(_ script: String) throws -> String {
        dispatchPrecondition(condition: .onQueue(queue))
        return try autoreleasepool { try evaluateText(script) }
    }
    private func evaluateText(_ script: String) throws -> String {
        engine.exception = nil
        return try resultText(engine.evaluateScript(script))
    }
    private func resultText(_ value: JSValue?) throws -> String {
        if let error = engine.exception {
            var value: [String: Any] = ["error": error.forProperty("message")?.toString() ?? error.toString() ?? "专注处理失败"]
            for key in ["code", "version", "details"] {
                if let property = error.forProperty(key), !property.isUndefined, !property.isNull { value[key] = property.toObject() }
            }
            let status = error.forProperty("status")?.toInt32() ?? 400
            throw FocusRequestFailure(status: status > 0 ? Int(status) : 400, value: value)
        }
        guard let result = value?.toString() else { throw Failure(message: "专注处理失败") }
        return result
    }
    private func call(_ operation: String, _ input: Any) throws -> String {
        dispatchPrecondition(condition: .onQueue(queue))
        return try autoreleasepool {
            engine.exception = nil
            let function = engine.objectForKeyedSubscript("__focusNative")
            return try resultText(function?.call(withArguments: [operation, try jsonText(input)]))
        }
    }
    private func callJSON(_ operation: String, _ input: Any) throws -> Any {
        try JSONSerialization.jsonObject(with: Data(call(operation, input).utf8), options: .fragmentsAllowed)
    }
    private func bridgeTasks(_ snapshot: [String: Any]) throws {
        let version = snapshot["version"] as! Int
        guard bridgedTaskVersion != version else { return }
        _ = try call("tasks", snapshot["state"]!)
        bridgedTaskVersion = version
    }
    private func json(_ expression: String) throws -> Any {
        try JSONSerialization.jsonObject(with: Data(text("JSON.stringify(\(expression))").utf8), options: .fragmentsAllowed)
    }
    private func available() throws {
        if let failure { throw FocusRequestFailure(status: 503, value: ["error": failure, "code": "FOCUS_UNAVAILABLE"]) }
    }
    private func writeExclusive(_ data: Data, to destination: URL) throws {
        let descriptor = Darwin.open(destination.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        var complete = false
        defer { Darwin.close(descriptor); if !complete { try? FileManager.default.removeItem(at: destination) } }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let written = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if written < 0 { if errno == EINTR { continue }; throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
                if written == 0 { throw POSIXError(.EIO) }
                offset += written
            }
        }
        guard Darwin.fsync(descriptor) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        complete = true
    }
    private func replace(_ data: Data, at destination: URL) throws {
        let temporary = directory.appendingPathComponent(".focus-\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(at: temporary) }
        try writeExclusive(data, to: temporary)
        guard Darwin.rename(temporary.path, destination.path) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }

    private func commitDecision(incrementVersion: Bool) throws -> Bool {
        guard try text("String(!!__focusDecision.nextRecord)") == "true" else { return false }
        let started = ProcessInfo.processInfo.systemUptime
        if incrementVersion { _ = try text("__focusDecision.nextRecord.version=__focusRecord.version+1; 'ok'") }
        let data = Data(try text("JSON.stringify(__focusDecision.nextRecord)").utf8)
        let encoded = ProcessInfo.processInfo.systemUptime
        let previous = try Data(contentsOf: file)
        try replace(previous, at: directory.appendingPathComponent("focus.previous.json"))
        let savedPrevious = ProcessInfo.processInfo.systemUptime
        try replace(data, at: file)
        let replaced = ProcessInfo.processInfo.systemUptime
        _ = try text("__focusRecord=__focusDecision.nextRecord; __focusDecision=null; 'ok'")
        storedBytes = data.count
        retryDelay = 1
        if diagnostics {
            let timings: [String: Any] = ["focusDiagnostics": true, "encodingMs": (encoded-started)*1000, "previousMs": (savedPrevious-encoded)*1000, "replaceMs": (replaced-savedPrevious)*1000, "bytes": data.count]
            fputs(((try? jsonText(timings)) ?? "{}") + "\n", stderr)
        }
        onChanged()
        return true
    }

    func reconcile(recovering: Bool = false) throws {
        try available()
        let observed = now, monotonic = ProcessInfo.processInfo.systemUptime
        var clockCheck: [String: Any] = [:]
        if let lastWall, let lastMonotonic, Double(observed-lastWall) - (monotonic-lastMonotonic)*1000 < -5000 {
            clockCheck = ["changed": true, "lastTrustedAt": lastWall]
        }
        let contexts = pendingTasks.isEmpty ? [getTasks()] : pendingTasks
        for task in contexts {
            try bridgeTasks(task)
            var context: [String: Any] = ["now": observed, "recovering": recovering, "clockCheck": clockCheck]
            if let committed = task["committedAt"] { context["taskCommittedAt"] = committed }
            _ = try call("reconcile", context)
            if try text("String(!!__focusDecision.changed)") == "true" { _ = try commitDecision(incrementVersion: true) }
        }
        pendingTasks.removeAll()
        lastWall = observed; lastMonotonic = monotonic
        schedule()
    }
    func tasksCommitted(_ snapshot: [String: Any]) -> [[String: Any]] {
        guard failure == nil else { return [] }
        pendingTasks.append(snapshot)
        do { try reconcile(); return [] }
        catch { scheduleRetry(); return [["code": "FOCUS_RECONCILE_PENDING"]] }
    }
    private func scheduleRetry() {
        timer?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            do { try self.reconcile() } catch { self.scheduleRetry() }
        }
        timer = work; queue.asyncAfter(deadline: .now() + retryDelay, execute: work)
        retryDelay = min(retryDelay * 2, 30)
    }
    private func schedule() {
        timer?.cancel(); timer = nil
        guard let current = try? json("__focusRecord.current") as? [String: Any], current["status"] as? String == "running", let deadline = current["deadlineAt"] as? NSNumber else { return }
        let delay = max(0, (deadline.doubleValue-Double(now))/1000)
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            do { try self.reconcile() } catch { self.scheduleRetry() }
        }
        timer = work; queue.asyncAfter(deadline: .now()+delay, execute: work)
    }
    func close() { dispatchPrecondition(condition: .onQueue(queue)); timer?.cancel(); timer = nil }

    func consumeNotification(_ outcomeId: String) throws -> [String: Any]? {
        try available()
        _ = try text("globalThis.__focusDecision=Daylight.consumeFocusNotification(__focusRecord,\(try jsonText(outcomeId)),{now:\(now)}); 'ok'")
        guard try text("String(!!__focusDecision.changed)") == "true" else { return nil }
        _ = try commitDecision(incrementVersion: true)
        return try json("__focusRecord.lastOutcome") as? [String: Any]
    }

    func notificationResult(_ outcomeId: String, error: String?) throws {
        try available()
        guard try text("String(__focusRecord.lastOutcome?.id===\(try jsonText(outcomeId)) && __focusRecord.lastOutcome.notification.state==='attempted')") == "true" else { return }
        let notification: [String: Any] = ["state": error == nil ? "scheduled" : "failed"]
        _ = try text("globalThis.__focusDecision={nextRecord:{...__focusRecord,lastOutcome:{...__focusRecord.lastOutcome,notification:{...__focusRecord.lastOutcome.notification,...\(try jsonText(notification))}}}}; 'ok'")
        _ = try commitDecision(incrementVersion: true)
        if let error { runtime["notificationError"] = error } else { runtime.removeValue(forKey: "notificationError") }
    }

    func snapshot(reconcileFirst: Bool = true) throws -> [String: Any] {
        try available()
        var pending = false
        if reconcileFirst { do { try reconcile() } catch { pending = true; scheduleRetry() } }
        let tasks = getTasks()
        var result = try callJSON("snapshot", ["now": now, "taskVersion": tasks["version"]!, "runtime": platform]) as! [String: Any]
        if pending { result["warnings"] = [["code": "FOCUS_RECONCILE_PENDING"]] }
        return result
    }

    func handle(path: String, query: String, body: Data) -> (Int, Any) {
        do {
            try available()
            let kind = path.components(separatedBy: "/").last!
            let observed = now
            if ["actions", "prepare"].contains(kind), !query.isEmpty { throw FocusRequestFailure(status: 400, value: ["error": "写入不接受查询参数", "code": "INVALID_FOCUS_INPUT"]) }
            if kind == "actions" {
                guard let raw = String(data: body, encoding: .utf8) else { throw Failure(message: "请求必须使用 UTF-8") }
                let normalized = try call("fingerprint", ["raw": raw])
                let fingerprint = SHA256.hash(data: Data(normalized.utf8)).map { String(format: "%02x", $0) }.joined()
                // A successful receipt is authoritative even when the clock or task later changed.
                let replay = try call("replay", ["raw": raw]) == "true"
                if !replay { try reconcile() }
                let tasks = getTasks()
                try bridgeTasks(tasks)
                let context: [String: Any] = ["now": now, "sessionId": UUID().uuidString.lowercased(), "taskVersion": tasks["version"]!, "runtime": platform]
                _ = try call("write", ["raw": raw, "fingerprint": fingerprint, "context": context])
                let response = try json("({code:__focusDecision.code,value:__focusDecision.value})") as! [String: Any]
                let changed = try commitDecision(incrementVersion: false)
                if changed { schedule() }
                return (response["code"] as! Int, response["value"]!)
            }
            if kind == "prepare" {
                guard let raw = String(data: body, encoding: .utf8) else { throw Failure(message: "请求必须使用 UTF-8") }
                let tasks = getTasks()
                try bridgeTasks(tasks)
                let context: [String: Any] = ["now": observed, "taskVersion": tasks["version"]!]
                return (200, try callJSON("prepare", ["raw": raw, "context": context]))
            }
            let pairs = queryPairs(query)
            _ = try call("selection", ["kind": kind, "pairs": pairs])
            if kind == "state" { return (200, try snapshot()) }
            if kind == "export" { try reconcile(); return (200, try json("Daylight.focusExport(__focusRecord)")) }
            try reconcile()
            let selection = try json("__focusSelection") as! [String: Any]
            if kind == "task-summary" {
                return (200, try callJSON("task-summary", ["taskId": selection["taskId"]!, "context": ["now": now, "recentLimit": selection["recentLimit"] ?? 5]]))
            }
            let timeZone = try json("__focusRecord.settings.statisticsTimeZone") as! String
            var windows: [[String: Any]] = []
            if let from = selection["from"] as? String, let to = selection["to"] as? String { windows = try FocusTimeZone.windows(from: from, to: to, timeZone: timeZone) }
            let function = kind == "statistics" ? "focusStatistics" : "focusSessionQuery"
            return (200, try callJSON("query", ["function": function, "context": ["now": now, "dayWindows": windows]]))
        } catch {
            if let error = error as? FocusRequestFailure { return (error.status, error.value) }
            if failure != nil { return (503, ["error": failure!, "code": "FOCUS_UNAVAILABLE"]) }
            if error is Failure { return (400, ["error": error.localizedDescription]) }
            var value: [String: Any] = ["error": "专注记录保存失败，请检查本机存储后重试", "code": "FOCUS_SAVE_FAILED"]
            if let version = (try? json("__focusRecord.version")) as? NSNumber { value["version"] = version }
            return (503, value)
        }
    }
}
