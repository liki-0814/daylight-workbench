import Foundation
import Network
import JavaScriptCore
import CryptoKit
import Security

struct Failure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
func jsonData(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]) }
func jsonText(_ value: Any) throws -> String { String(data: try jsonData(value), encoding: .utf8)! }
func secureToken() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw Failure(message: "无法生成本机凭证") }
    return bytes.map { String(format: "%02x", $0) }.joined()
}
func requestJSON(_ data: Data) throws -> Any {
    do { return try JSONSerialization.jsonObject(with: data) } catch { throw Failure(message: "请求 JSON 无效") }
}
func matches(_ text: String, _ pattern: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }
func queryPairs(_ query: String) -> [[String]] {
    // URLSearchParams and CLI form encoding treat '+' as a space; a literal plus is %2B.
    (URLComponents(string: "http://localhost/?" + query.replacingOccurrences(of: "+", with: "%20"))?.queryItems ?? []).map { [$0.name, $0.value ?? ""] }
}

final class WorkbenchServer {
    // Foundation and JavaScriptCore bridge values must drain between serialized requests.
    let queue = DispatchQueue(label: "daylight.storage", autoreleaseFrequency: .workItem)
    let directory: URL
    let resources: URL
    let port: UInt16
    let webToken: String
    let agentToken: String
    let ai: ProxyRuntime
    let proxy: ProxyRuntime
    let engine: JSContext
    var record: [String: Any]
    var listener: NWListener?
    var onChange: (() -> Void)?
    var onFocusChange: (() -> Void)?
    var focus: Focus!
    private var requestStarted: TimeInterval?
    var endpoint: String { "http://127.0.0.1:\(port)" }
    var version: Int { record["version"] as! Int }
    var state: [String: Any] { record["state"] as! [String: Any] }
    var snapshot: [String: Any] { ["version": version, "state": state] }

    init(resources: URL, directory: URL, port: UInt16) throws {
        self.resources = resources; self.directory = directory; self.port = port
        self.proxy = ProxyRuntime(resources: resources, directory: directory)
        self.ai = ProxyRuntime(resources: resources, directory: directory, helper: "ai", workbenchURL: "http://127.0.0.1:\(port)")
        let context = queue.sync { JSContext()! }
        self.engine = context
        let uuid: @convention(block) () -> String = { UUID().uuidString.lowercased() }
        try queue.sync {
        context.setObject(uuid, forKeyedSubscript: "randomUUID" as NSString)
        context.evaluateScript("function structuredClone(x){return JSON.parse(JSON.stringify(x))}; Object.hasOwn ||= ((o,k)=>Object.prototype.hasOwnProperty.call(o,k));")
        context.evaluateScript(try String(contentsOf: resources.appendingPathComponent("native-core.js"), encoding: .utf8))
        if let error = context.exception { throw Failure(message: error.toString()) }
        context.evaluateScript("var {validate,initialState,localDate,change,taskQuery,taskQueryCapability,applyAction,operations,getTrayState,resolveRoute,capabilities,fingerprintText,prepareTaskWrite}=Daylight;")
        }
        let fm = FileManager.default
        let file = directory.appendingPathComponent("state.json")
        let legacy = fm.homeDirectoryForCurrentUser.appendingPathComponent("liki_dev/daylight-workbench/.local")
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if !fm.fileExists(atPath: file.path), ProcessInfo.processInfo.environment["WORKBENCH_DATA_DIR"] == nil,
           fm.fileExists(atPath: legacy.appendingPathComponent("state.json").path) {
            // Validate before migrating; never replace a destination file or remove the source.
            let oldData = try Data(contentsOf: legacy.appendingPathComponent("state.json"))
            guard let old = try JSONSerialization.jsonObject(with: oldData) as? [String: Any], let value = old["state"] else { throw Failure(message: "旧数据无效") }
            try queue.sync {
                context.evaluateScript("validate(\(try jsonText(value)))")
                if let error = context.exception { throw Failure(message: error.toString()) }
            }
            for name in ["agent-token", "state.previous.json", "state.json"] {
                let from = legacy.appendingPathComponent(name), to = directory.appendingPathComponent(name)
                if fm.fileExists(atPath: from.path), !fm.fileExists(atPath: to.path) { try fm.copyItem(at: from, to: to) }
            }
        }
        if fm.fileExists(atPath: file.path) {
            guard let existing = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any], let value = existing["state"], let v = existing["version"] as? Int, v >= 0 else { throw Failure(message: "数据文件无效，原文件已保留") }
            try queue.sync {
                context.evaluateScript("validate(\(try jsonText(value)))")
                if let error = context.exception { throw Failure(message: error.toString()) }
            }
            record = existing
        } else {
            let initial = queue.sync { context.evaluateScript("JSON.stringify(initialState())")!.toString()! }
            record = ["version": 0, "state": try JSONSerialization.jsonObject(with: Data(initial.utf8))]
            try jsonData(record).write(to: file, options: .atomic)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
        webToken = try secureToken()
        let tokenFile = directory.appendingPathComponent("agent-token")
        if fm.fileExists(atPath: tokenFile.path) { agentToken = try String(contentsOf: tokenFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) }
        else {
            agentToken = try secureToken()
            try Data(agentToken.utf8).write(to: tokenFile, options: .atomic)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tokenFile.path)
        }
        guard matches(agentToken, "^[a-f0-9]{64}$") else { throw Failure(message: "本机凭证格式无效") }
        queue.sync {
            focus = Focus(engine: engine, queue: queue, directory: directory, getTasks: { [unowned self] in self.snapshot }, onChanged: { [weak self] in
                DispatchQueue.main.async { self?.onFocusChange?() }
            })
        }
    }

    func js(_ expression: String) throws -> Any {
        dispatchPrecondition(condition: .onQueue(queue))
        return try autoreleasepool {
            engine.exception = nil
            let result = engine.evaluateScript("JSON.stringify(\(expression))")
            if let error = engine.exception { throw Failure(message: error.toString()) }
            guard let text = result?.toString() else { throw Failure(message: "任务处理失败") }
            return try JSONSerialization.jsonObject(with: Data(text.utf8), options: .fragmentsAllowed)
        }
    }
    func traySnapshot(_ completion: @escaping ([String: Any]) -> Void) {
        queue.async {
            var result = self.snapshot
            result["tray"] = try? self.js("getTrayState(\(try! jsonText(self.state)),localDate())")
            do { result["focus"] = try self.focus.snapshot() }
            catch { result["focus"] = ["error": error.localizedDescription, "code": "FOCUS_UNAVAILABLE"] }
            DispatchQueue.main.async { completion(result) }
        }
    }
    func focusSnapshot(_ completion: @escaping (Result<[String: Any], Error>) -> Void) {
        queue.async {
            let result = Result { try self.focus.snapshot() }
            DispatchQueue.main.async { completion(result) }
        }
    }
    func applyFocus(_ action: [String: Any], completion: @escaping (Int, Any) -> Void) {
        queue.async {
            do {
                let current = try self.focus.snapshot()
                var request: [String: Any] = ["requestId": UUID().uuidString.lowercased(), "expectedVersion": current["version"]!, "action": action]
                if ["focus.start", "focus.switch"].contains(action["type"] as? String ?? "") { request["expectedTaskVersion"] = self.version }
                let result = self.focus.handle(path: "/api/focus/actions", query: "", body: try jsonData(request))
                DispatchQueue.main.async { completion(result.0, result.1) }
            } catch { DispatchQueue.main.async { completion(503, ["error": error.localizedDescription]) } }
        }
    }
    func updateFocusPlatform(_ status: [String: Any]) {
        queue.async {
            self.focus.runtime.merge(status) { _, new in new }
            DispatchQueue.main.async { self.onFocusChange?() }
        }
    }
    @discardableResult func persist(_ nextState: Any, receipt: [String: Any]? = nil) throws -> [[String: Any]] {
        var receipts = record["receipts"] as? [[String: Any]] ?? []
        if let receipt { receipts.append(receipt); receipts = Array(receipts.suffix(100)) }
        let next: [String: Any] = ["version": version + 1, "state": nextState, "receipts": receipts]
        try jsonData(record).write(to: directory.appendingPathComponent("state.previous.json"), options: .atomic)
        try jsonData(next).write(to: directory.appendingPathComponent("state.json"), options: .atomic)
        for name in ["state.previous.json", "state.json"] { try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: directory.appendingPathComponent(name).path) }
        record = next
        DispatchQueue.main.async { self.onChange?() }
        return focus.tasksCommitted(["state": state, "version": version, "committedAt": Int64((Date().timeIntervalSince1970 * 1000).rounded(.down))])
    }
    func start(ready: @escaping (Error?) -> Void) throws {
        proxy.start()
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        let service = try NWListener(using: parameters)
        listener = service
        service.stateUpdateHandler = { state in
            switch state {
            case .ready: DispatchQueue.main.async { ready(nil) }
            case .failed(let error): DispatchQueue.main.async { ready(error) }
            default: break
            }
        }
        service.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            connection.start(queue: self.queue)
            let timeout = DispatchWorkItem { connection.cancel() }
            self.queue.asyncAfter(deadline: .now() + 15, execute: timeout)
            self.receive(connection, buffer: Data(), timeout: timeout)
        }
        service.start(queue: queue)
    }
    private func receive(_ connection: NWConnection, buffer: Data, timeout: DispatchWorkItem) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, error in
            guard let self else { return }
            var buffer = buffer; if let data { buffer.append(data) }
            guard buffer.count <= 4_032_768 else { timeout.cancel(); self.reply(connection, 413, ["error": "请求过大"]); return }
            if let split = buffer.range(of: Data("\r\n\r\n".utf8)) {
                guard split.lowerBound < 32768, let header = String(data: buffer[..<split.lowerBound], encoding: .utf8) else { timeout.cancel(); connection.cancel(); return }
                let lines = header.components(separatedBy: "\r\n")
                let request = lines[0].split(separator: " ").map(String.init)
                var headers: [String: String] = [:]
                for line in lines.dropFirst() {
                    let parts = line.split(separator: ":", maxSplits: 1).map(String.init)
                    if parts.count == 2 {
                        let key = parts[0].lowercased()
                        if headers[key] != nil { timeout.cancel(); self.reply(connection, 400, ["error": "重复请求头"]); return }
                        headers[key] = parts[1].trimmingCharacters(in: .whitespaces)
                    }
                }
                guard request.count == 3, headers["transfer-encoding"] == nil, let length = Int(headers["content-length"] ?? "0"), length >= 0, length <= 4_000_000 else { timeout.cancel(); self.reply(connection, 400, ["error": "无效请求"]); return }
                if buffer.count - split.upperBound >= length {
                    timeout.cancel()
                    let body = buffer.subdata(in: split.upperBound..<(split.upperBound + length))
                    self.handle(connection, method: request[0], path: request[1].components(separatedBy: "?")[0], headers: headers, body: body, query: request[1].components(separatedBy: "?").dropFirst().joined(separator: "?"))
                    return
                }
            }
            if done || error != nil { timeout.cancel(); connection.cancel() }
            else { self.receive(connection, buffer: buffer, timeout: timeout) }
        }
    }
    func reply(_ connection: NWConnection, _ status: Int, _ object: Any) {
        send(connection, status, (try? jsonData(object)) ?? Data(), type: "application/json; charset=utf-8")
    }
    func send(_ connection: NWConnection, _ status: Int, _ body: Data, type: String) {
        let csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        let timing = ProcessInfo.processInfo.environment["WORKBENCH_FOCUS_DIAGNOSTICS"] == "1" && requestStarted != nil ? "X-Daylight-Queue-Ms: \((ProcessInfo.processInfo.systemUptime-requestStarted!)*1000)\r\n" : ""
        var response = Data("HTTP/1.1 \(status) Response\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: \(csp)\r\n\(timing)\r\n".utf8)
        response.append(body)
        connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
    }
    func handle(_ connection: NWConnection, method: String, path: String, headers: [String: String], body: Data, query: String = "") {
        autoreleasepool { handleRequest(connection, method: method, path: path, headers: headers, body: body, query: query) }
    }
    private func handleRequest(_ connection: NWConnection, method: String, path: String, headers: [String: String], body: Data, query: String) {
        requestStarted = ProcessInfo.processInfo.systemUptime
        guard headers["host"] == "127.0.0.1:\(port)" else { reply(connection, 403, ["error": "仅允许本机访问"]); return }
        do {
            let dispatch = try js("resolveRoute(\(try jsonText(path)),\(try jsonText(method)))") as! [String: Any]
            let handler = dispatch["handler"] as! String
            let auth = dispatch["auth"] as! String
            if auth == "web" || auth == "webOrigin" {
                guard headers["x-workbench-token"] == webToken,
                      auth == "webOrigin" ? headers["origin"] == endpoint : (headers["origin"] == nil || headers["origin"] == endpoint) else { reply(connection, 403, ["error": "本机会话验证失败，请刷新页面"]); return }
            }
            if auth == "agent" {
                let provided = Array((headers["authorization"] ?? "").utf8), expected = Array("Bearer \(agentToken)".utf8)
                let valid = provided.count == expected.count && zip(provided, expected).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
                guard valid, headers["origin"] == nil || headers["origin"] == endpoint else { reply(connection, 401, ["error": "本机接口认证失败"]); return }
            }
            if handler == "ai" || handler == "proxy" {
                let target = dispatch["target"] as! String
                (handler == "ai" ? ai : proxy).handle(path: target + (query.isEmpty ? "" : "?" + query), method: method, body: body) { code, object in
                    self.queue.async { self.reply(connection, code, object) }
                }
                return
            }
            if handler == "focus" {
                let result = focus.handle(path: path, query: query, body: body)
                reply(connection, result.0, result.1); return
            }
            if handler == "calendar" {
                let params = queryPairs(query)
                let result = try js("(()=>{try{return {code:200,value:Daylight.calendarQuery(\(try jsonText(state)),\(version),\(try jsonText(params)))}}catch(e){return {code:e.status||400,value:{error:e.message,code:e.code}}}})()") as! [String: Any]
                reply(connection, result["code"] as! Int, result["value"]!); return
            }
            if handler == "actions" {
                guard let raw = String(data: body, encoding: .utf8) else { throw Failure(message: "请求必须使用 UTF-8") }
                let normalized = try js("fingerprintText(\(try jsonText(raw)))") as! String
                let fingerprint = SHA256.hash(data: Data(normalized.utf8)).map { String(format: "%02x", $0) }.joined()
                let args = "\(try jsonText(record)),JSON.parse(\(try jsonText(raw))),\(try jsonText(fingerprint))"
                var result = try js("prepareTaskWrite(\(args))") as! [String: Any]
                if result["needsPrevious"] as? Bool == true {
                    let previous = (try? JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("state.previous.json")))) ?? NSNull()
                    result = try js("prepareTaskWrite(\(args),{previous:\(try jsonText(previous))})") as! [String: Any]
                }
                if let receipt = result["receipt"] as? [String: Any] {
                    let warnings = try persist(result["state"]!, receipt: receipt)
                    if !warnings.isEmpty, var value = result["value"] as? [String: Any] { value["warnings"] = warnings; result["value"] = value }
                }
                reply(connection, result["code"] as! Int, result["value"]!); return
            }
            if auth == "agent" {
                if handler == "tasks" {
                    let items = URLComponents(string: "http://localhost/?" + query)?.queryItems ?? []
                    var params: [String: String] = [:]
                    for item in items { params[item.name] = item.value ?? "" }
                    let expression = "(()=>{try{return {code:200,value:taskQuery(\(try jsonText(state)),\(version),\(try jsonText(params)))}}catch(e){return {code:e.status||400,value:{error:e.message}}}})()"
                    let result = try js(expression) as! [String: Any]
                    reply(connection, result["code"] as! Int, result["value"]!); return
                }
                if handler == "state" { var result = snapshot; result["localDate"] = try js("localDate()"); reply(connection, 200, result); return }
                if handler == "capabilities" { reply(connection, 200, try js("capabilities()")); return }
                reply(connection, 404, ["error": "接口不存在"]); return
            }
            if handler == "webState" { var result = snapshot; result["token"] = webToken; reply(connection, 200, result); return }
            if handler == "webWrite" {
                guard headers["if-match"] == String(version) else { reply(connection, 409, ["error": "其他窗口已更新数据，请重新打开表单"]); return }
                let input = try requestJSON(body)
                let warnings = try persist(js("validate(\(try jsonText(input)))"))
                var result = snapshot; if !warnings.isEmpty { result["warnings"] = warnings }
                reply(connection, 200, result); return
            }
            guard let file = dispatch["file"] as? String else { reply(connection, 404, ["error": "页面不存在"]); return }
            let types = ["html": "text/html", "js": "text/javascript", "css": "text/css", "svg": "image/svg+xml"]
            let url = resources.appendingPathComponent("public").appendingPathComponent(file)
            send(connection, 200, try Data(contentsOf: url), type: (types[url.pathExtension] ?? "text/plain") + "; charset=utf-8")
        } catch {
            reply(connection, error is Failure || error is DecodingError ? 400 : 500, ["error": error.localizedDescription])
        }
    }
}
